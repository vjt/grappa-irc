defmodule Grappa.Scrollback do
  @moduledoc """
  Bouncer-owned scrollback persistence — the only sanctioned write/read
  surface for the `messages` table. Internal schema (`Grappa.Scrollback.Message`)
  stays encapsulated; callers never `Repo.insert/2` directly.

  ## Per-user iso (Phase 2 sub-task 2e)

  Every row carries `user_id` (FK → `users.id`) and `network_id` (FK →
  `networks.id`). `fetch/5` filters on the `(user_id, network_id,
  channel)` triple so alice's `GET /messages` on a shared channel does
  NOT see vjt's messages — even though both users' Sessions write to
  the same `(network, channel)` row stream. The composite index
  `messages_user_id_network_id_channel_server_time_index` makes this a
  single index scan.

  The schema is shaped so a future `CHATHISTORY` listener facade is a
  mechanical query translation, not a redesign:

    * monotonic `id` provides stable ordering inside a single
      `server_time` (epoch milliseconds; collisions are rare in Phase 1
      but cannot be assumed away).
    * `(user_id, network_id, channel, server_time)` index makes
      per-channel DESC paginated lookup cheap.

  Pagination uses a strict-less-than `before` cursor on monotonic `id`
  (post-CP29 R-2: was `server_time` pre-cluster, but same-millisecond
  ties straddling page boundaries could lose or duplicate rows). The
  DESC `(server_time, id)` order is preserved for display; only the
  cursor key flipped. Phase 6 will additionally accept an IRCv3
  `msgid` tuple cursor — the column is additive, no migration needed.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.IRC, Grappa.Repo],
    # `Networks.Network` is referenced by `Scrollback.Message` (the
    # `belongs_to :network` association) and `Scrollback.Wire` (the
    # `%Network{slug: _}` pattern that A1+A26 made the wire-shape
    # contract). `Visitors.Visitor` is referenced by `Scrollback.Message`
    # (the Task 4 `belongs_to :visitor` association). Declaring those
    # refs as dirty xrefs lets two cycle inversions land without
    # transitive cycles: Cluster 2's Networks → Session (which would
    # close `Scrollback → Networks → Session → Scrollback`) and the
    # visitor-auth cluster's Visitors → Networks (which would close
    # `Scrollback → Visitors → Networks → Scrollback` and
    # `Scrollback → Visitors → Networks → Session → Scrollback`).
    # The struct-only nature of both deps means we lose Boundary
    # checks on a use case Boundary couldn't help with anyway
    # (struct field access doesn't go through any function call we'd
    # want to gate); the cost is intentional.
    dirty_xrefs: [Grappa.Networks.Network, Grappa.Visitors.Visitor],
    exports: [Message, Wire]

  import Ecto.Query

  alias Grappa.Repo
  alias Grappa.Scrollback.{Message, Meta}

  @max_limit 500

  @doc """
  Maximum rows returned by a single `fetch/5` call.

  Exposed so callers (REST controller, Phoenix Channel handler, Phase 6
  CHATHISTORY listener) can clamp their own page-size negotiation
  upstream rather than guessing.

  The spec returns the literal `@max_limit` rather than `pos_integer()`
  so Dialyzer's `:underspecs` flag (mandated by mix.exs) doesn't flag
  the helper as wider-than-actual. If the cap moves, update both.
  """
  @spec max_page_size() :: unquote(@max_limit)
  def max_page_size, do: @max_limit

  @doc """
  Persists a scrollback row of arbitrary kind. Takes the full attribute
  map explicitly — no defaulting, no implicit current-time read. Caller
  is responsible for `:server_time` (epoch ms) and `:meta` (`%{}` for
  kinds without event-specific payload).

  The returned row has `:network` preloaded so callers can hand it
  straight to `Grappa.Scrollback.Wire.message_payload/1` (which
  pattern-matches on `%Network{slug: _}` and crashes on unloaded assoc).
  Single source for the wire-shape contract — every door (REST,
  PubSub, future Phase 6 listener) goes through here.

  Body validation per-kind is enforced by `Message.changeset/2`:
  `:privmsg | :notice | :action | :topic` require non-nil body;
  `:join | :part | :quit | :nick_change | :mode | :kick` accept
  `body: nil` (presence kinds + state changes).

  `:dm_with` is per-kind constrained too (M8 fix 2026-05-08): only
  `:privmsg` and `:action` may carry a non-nil peer nick. Every
  other kind MUST omit `:dm_with` (or pass `nil`); a stray peer
  nick on a presence event surfaces as a typed changeset error
  rather than silently corrupting the active/archive view-derivation
  in `list_archive/3` (which uses `COALESCE(dm_with, channel)` to
  pick the per-window key). Caller-side: `Scrollback.dm_peer/4` is
  the canonical computer of the value — pass its result directly.
  """
  @spec persist_event(%{
          optional(:user_id) => Ecto.UUID.t(),
          optional(:visitor_id) => Ecto.UUID.t(),
          optional(:dm_with) => String.t() | nil,
          required(:network_id) => integer(),
          required(:channel) => String.t(),
          required(:server_time) => integer(),
          required(:kind) => Message.kind(),
          required(:sender) => String.t(),
          required(:body) => String.t() | nil,
          required(:meta) => Meta.t()
        }) :: {:ok, Message.t()} | {:error, Ecto.Changeset.t()}
  def persist_event(%{kind: kind} = attrs) when is_atom(kind) do
    changeset = Message.changeset(%Message{}, attrs)

    case Repo.insert(changeset) do
      {:ok, message} -> {:ok, Repo.preload(message, :network)}
      {:error, _} = err -> err
    end
  end

  @doc """
  CP14 B3 — derive the normalized "DM peer" for a (target, sender,
  own_nick) triple. Returns the peer nick (binary) if the triple is a
  DM exchange between `own_nick` and a peer; `nil` if the triple is a
  channel message, a $server-window message, or any other non-DM
  shape. Caller passes the result as `:dm_with` in the
  `persist_event/1` attrs map; the field is ignored by the schema for
  non-PRIVMSG kinds (they always get `nil` here regardless).

  Rules (PRIVMSG / ACTION / NOTICE — peer-to-peer content kinds):

    * Inbound:  target == own_nick (case-insensitive) → peer = sender
    * Outbound: sender == own_nick (case-insensitive) AND target is
      nick-shaped (no `#`/`&`/`!`/`+` sigil and not "$server") →
      peer = target
    * Otherwise: nil

  Service / server NOTICEs use the `$server` window — those callers
  pass channel = "$server" so the nick-shape check rejects them.
  Channel-targeted NOTICEs (auth banners on `#channel`, etc.) match
  the otherwise arm and return nil. Only nick-targeted peer NOTICEs
  (CTCP-style queries from real users) get a non-nil peer.

  `own_nick` may be nil briefly during connection setup before
  registration assigns the negotiated nick — guard against it here so
  EventRouter's `state.nick` doesn't have to nil-check at every call
  site.

  Single source of truth for the DM-detection predicate so the
  EventRouter inbound path and the Session.Server outbound path stay
  byte-aligned (CLAUDE.md "implement once, reuse everywhere").
  """
  @spec dm_peer(Message.kind(), String.t(), String.t(), String.t() | nil) :: String.t() | nil
  def dm_peer(kind, target, sender, own_nick)
      when kind in [:privmsg, :action, :notice] and is_binary(target) and is_binary(sender) and
             is_binary(own_nick) do
    own = String.downcase(own_nick)

    cond do
      String.downcase(target) == own -> sender
      String.downcase(sender) == own and nick_shaped?(target) -> target
      true -> nil
    end
  end

  def dm_peer(_, _, _, _), do: nil

  # `nick_shaped?/1` — true iff `target` is a peer-shaped name (not a
  # channel sigil, not the synthetic "$server" pseudo-channel).
  # Derived from `target_kind/1` so the sigil rule is single-sourced
  # (M7 2026-05-08): the rule changes ONCE in `target_kind/1` and
  # every consumer (this fn + `dm_eligible?/1` + `list_archive/3`)
  # tracks it.
  defp nick_shaped?("$server"), do: false
  defp nick_shaped?(name) when is_binary(name), do: target_kind(name) == :query

  @doc """
  Fetches up to `limit` messages for `(subject, network_id, channel)`,
  ordered by `server_time` DESC then `id` DESC (stable inside same-ms
  ties). The subject filter is the central per-subject iso boundary —
  see moduledoc.

  `subject` discriminated union (Task 4 + 30):

    * `{:user, user_id}` — partitions on `m.user_id == ^user_id`.
    * `{:visitor, visitor_id}` — partitions on `m.visitor_id == ^visitor_id`.

  When `before` is an integer, only rows with `id < before` are returned
  — id-cursor semantics post-CP29 R-2 (server_time pre-cluster, but
  same-millisecond ties straddling page boundaries could lose / duplicate
  rows). When `nil`, returns the latest page.

  `limit` must be a positive integer; non-positive values raise
  `FunctionClauseError` (caller bug, let it crash per CLAUDE.md OTP
  rules). Values above `max_page_size/0` are silently clamped to the
  max as an anti-DoS guard for the REST surface.

  Returned rows have `:network` preloaded so callers can hand the
  result straight to `Scrollback.Wire.to_json/1` (which pattern-matches
  on `%Network{slug: _}` and crashes on unloaded assoc). Single
  network query per page (Ecto deduplicates the `IN (...)` lookup);
  identical wire-shape contract as `persist_event/1` (A4 + A26).
  """
  @type subject :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

  @spec fetch(subject(), integer(), String.t(), integer() | nil, pos_integer()) ::
          [Message.t()]
  def fetch(subject, network_id, channel, before, limit),
    do: fetch(subject, network_id, channel, before, limit, nil)

  @doc """
  Fetch with explicit `own_nick` for own-nick query window narrowing.

  When `own_nick` matches the requested `channel` (case-insensitive), the
  fetch restricts to self-msgs only — rows where both `channel` and
  `dm_with` equal `own_nick`. Without this, the OR-shape filter from
  `channel_or_dm_where/3` would pull every inbound DM the user ever
  received (server stores inbound DMs at `channel = own_nick,
  dm_with = peer`), polluting the own-nick query window with conversations
  from every peer.

  Pass `nil` for `own_nick` when the caller doesn't have it (channel-
  shaped target fetches don't need it; tests with synthetic data don't
  either). The 5-arity `fetch/5` is a thin wrapper that passes `nil`.

  Origin: 2026-05-10 — vjt observed CristoBOT replies (and every other
  peer's DMs) showing up in the `grappa` (own-nick) query window. Bug
  shipped in CP14-B3 (commit 47866bc, 2026-05-07): the `:dm_with` field
  + bidirectional fetch landed without the own-nick narrowing, so the
  own-nick query window's REST fetch returned every inbound DM ever.
  """
  @spec fetch(
          subject(),
          integer(),
          String.t(),
          integer() | nil,
          pos_integer(),
          String.t() | nil
        ) :: [Message.t()]
  def fetch(subject, network_id, channel, before, limit, own_nick)
      when is_integer(network_id) and is_integer(limit) and limit > 0 and
             (is_binary(own_nick) or is_nil(own_nick)) do
    capped = min(limit, @max_limit)

    Message
    |> subject_where(subject)
    |> where([m], m.network_id == ^network_id)
    |> channel_or_dm_where(channel, own_nick)
    |> maybe_before(before)
    |> order_by([m], desc: m.server_time, desc: m.id)
    |> limit(^capped)
    |> preload(:network)
    |> Repo.all()
  end

  @doc """
  Fetches up to `limit` rows for `(subject, network_id, channel)` whose
  `id` is strictly greater than `after_id`, in ASCENDING `id` order.

  Sole consumer (today): cic's reconnect-backfill flow (CP25-cluster
  message-replay-on-reconnect, 2026-05-12). Cic tracks
  `lastSeenMessageId` per channel/dm window and, on Phoenix Channel
  re-join, calls
  `GET /api/networks/:slug/channels/:chan/messages?after=<id>` to pull
  any rows that arrived during the WS gap. The fire-and-forget PubSub
  broadcast can drop in-flight events when the WS is down; the
  scrollback DB is the source of truth.

  Mirror-symmetric to `fetch/6` in shape (subject filter, network_id
  filter, channel-vs-DM dispatch, optional own-nick narrowing,
  `:network` preload, max-page clamp) but inverts the cursor key:
  uses `id > after_id` instead of `server_time > t`. Two reasons:

    1. The wire shape (`Wire.to_json/1`) already exposes `id`, so cic
       has the value cheap.
    2. `id` is monotonic per-row; same-millisecond `server_time` ties
       (the existing `fetch/6` docstring's caveat) become a non-issue.

  Returns ASC so cic appends in chronological order without a flip
  in the consumer. The cursor is a numeric comparison only — passing
  an `after_id` for a row that was deleted (or never existed) is
  legal: the query returns every row with a strictly greater `id`,
  which is the desired resume-from-gap behaviour.

  `:network` is preloaded — same wire-shape-ready contract as
  `fetch/6` (A26).
  """
  @spec fetch_after(subject(), integer(), String.t(), integer(), pos_integer()) :: [Message.t()]
  def fetch_after(subject, network_id, channel, after_id, limit),
    do: fetch_after(subject, network_id, channel, after_id, limit, nil)

  @doc """
  6-arity variant of `fetch_after/5` with explicit `own_nick` for own-nick
  query window narrowing — symmetric with `fetch/6` (CP14 B3 narrowing
  rule). When `own_nick` matches `channel` (case-insensitive), the fetch
  restricts to self-msgs (rows where channel == dm_with == own_nick),
  preventing every inbound DM from leaking into the own-nick window's
  backfill page. Pass `nil` when the caller doesn't have a session
  (the channel-shape default applies).
  """
  @spec fetch_after(
          subject(),
          integer(),
          String.t(),
          integer(),
          pos_integer(),
          String.t() | nil
        ) :: [Message.t()]
  def fetch_after(subject, network_id, channel, after_id, limit, own_nick)
      when is_integer(network_id) and is_integer(after_id) and is_integer(limit) and limit > 0 and
             (is_binary(own_nick) or is_nil(own_nick)) do
    capped = min(limit, @max_limit)

    Message
    |> subject_where(subject)
    |> where([m], m.network_id == ^network_id)
    |> channel_or_dm_where(channel, own_nick)
    |> where([m], m.id > ^after_id)
    |> order_by([m], asc: m.id)
    |> limit(^capped)
    |> preload(:network)
    |> Repo.all()
  end

  @doc """
  Fetches a window of `limit` rows centered on `around_id` for
  `(subject, network_id, channel)`.

  Returns up to `floor(limit/2)` rows where `m.id <= around_id` (DESC)
  AND up to `ceil(limit/2)` rows where `m.id > around_id` (ASC), merged
  into a single chronological-DESC list (newest first — same as
  `fetch/6`).

  Sole consumer: cic's "open window centered on cursor" flow landing in
  R-4 — when a user opens a channel with an existing read cursor, cic
  asks for ~50 rows before + ~100 rows after the cursor so the unread
  marker has visual context on both sides. Per plan vjt 2026-05-13
  ("50 before, 100 next").

  If `around_id` doesn't exist (deleted, never existed, or belongs to a
  different subject/network/channel), the query still returns whatever
  rows fall on either side of that integer position — same
  resume-from-gap semantics as `fetch_after/6`. Validation that the id
  belongs to the (subject, network, channel) triple lives in the
  caller (`MessagesController` does NOT validate; the cic-side R-4
  call always derives `around_id` from a known cursor).

  `:network` is preloaded — same wire-shape-ready contract as
  `fetch/6` / `fetch_after/6`.

  Splits the work into two queries (one DESC, one ASC) rather than a
  single SQL UNION because Ecto's UNION composition would lose the
  per-side ordering + per-side limit semantics. Two queries hit the
  same `(subject, network_id, channel, server_time)` index; cost is
  roughly double a single page fetch — bounded.
  """
  @spec fetch_around(
          subject(),
          integer(),
          String.t(),
          pos_integer(),
          pos_integer(),
          String.t() | nil
        ) :: [Message.t()]
  def fetch_around(subject, network_id, channel, around_id, limit, own_nick)
      when is_integer(network_id) and is_integer(around_id) and around_id > 0 and
             is_integer(limit) and limit > 0 and
             (is_binary(own_nick) or is_nil(own_nick)) do
    capped = min(limit, @max_limit)
    before_count = div(capped, 2)
    after_count = capped - before_count

    base =
      Message
      |> subject_where(subject)
      |> where([m], m.network_id == ^network_id)
      |> channel_or_dm_where(channel, own_nick)

    before_rows =
      base
      |> where([m], m.id <= ^around_id)
      |> order_by([m], desc: m.server_time, desc: m.id)
      |> limit(^before_count)
      |> preload(:network)
      |> Repo.all()

    after_rows =
      base
      |> where([m], m.id > ^around_id)
      |> order_by([m], asc: m.server_time, asc: m.id)
      |> limit(^after_count)
      |> preload(:network)
      |> Repo.all()

    # DESC merge: after-rows (newest first when reversed) followed by
    # before-rows (already DESC). Single chronological-DESC list,
    # consistent with fetch/6 callers.
    Enum.reverse(after_rows) ++ before_rows
  end

  @typedoc """
  CP15 B4 — archive entry shape returned by `list_archive/3`.

  `kind` is derived at query time from the `target` prefix via
  `target_kind/1` — the canonical sigil-rule classifier (M7
  2026-05-08). Sigil-led (`#`, `&`, `!`, `+`) → `:channel`,
  otherwise `:query`. Single source of truth for the predicate;
  every consumer (this fn + `dm_eligible?/1` + `nick_shaped?/1`)
  derives from it.
  """
  @type archive_entry :: %{
          target: String.t(),
          kind: :channel | :query,
          last_activity: integer(),
          row_count: non_neg_integer()
        }

  @doc """
  CP15 B4 — lists targets that have scrollback rows for the
  `(subject, network_id)` pair AND are NOT in `active_keyset`. Powers
  the per-network Archive section in cicchetto's sidebar.

  Target derivation: `COALESCE(dm_with, channel)` — DM rows (CP14 B3)
  carry `dm_with = peer` regardless of which side `channel` points at
  (inbound = own_nick, outbound = peer); channel rows carry
  `dm_with = nil` so the COALESCE picks the channel name. The result
  collapses to one row per logical "window" the user has talked in.

  `active_keyset` is a `MapSet` of currently-active target strings —
  joined channels (from `Grappa.Session.list_channels/2`) plus open
  query window targets (from `Grappa.QueryWindows.list_for_subject/1`).
  Members of the set are filtered OUT of the archive so the active +
  archive sets are disjoint per intent doc. Empty set means everything
  with rows qualifies.

  The `$server` pseudo-channel is ALWAYS excluded — system surface,
  never archived per intent doc `Active/Archive boundary`. Mirrors
  `dm_eligible?/1`'s `$server` short-circuit so the rule is uniform
  across read paths.

  Result is sorted by `last_activity` DESC for stable client rendering.
  """
  @spec list_archive(subject(), integer(), MapSet.t(String.t())) :: [archive_entry()]
  def list_archive(subject, network_id, %MapSet{} = active_keyset)
      when is_integer(network_id) do
    Message
    |> subject_where(subject)
    |> where([m], m.network_id == ^network_id)
    |> group_by([m], fragment("COALESCE(?, ?)", m.dm_with, m.channel))
    |> select([m], %{
      target: fragment("COALESCE(?, ?)", m.dm_with, m.channel),
      last_activity: max(m.server_time),
      row_count: count(m.id)
    })
    |> Repo.all()
    |> Enum.reject(fn %{target: t} -> t == "$server" or MapSet.member?(active_keyset, t) end)
    |> Enum.map(fn entry -> Map.put(entry, :kind, target_kind(entry.target)) end)
    |> Enum.sort_by(& &1.last_activity, :desc)
  end

  @doc """
  M7 2026-05-08 — canonical sigil-rule classifier for IRC targets.

  Returns `:channel` for sigil-led names (`#`, `&`, `!`, `+`) and
  `:query` for everything else (peer nicks, the synthetic
  `$server` pseudo-channel — callers that need to special-case
  `$server` do so AFTER this classification, never inside it).

  Single source of truth for the sigil predicate. Pre-M7 the rule
  lived in three separate private functions inside this module
  (`nick_shaped?/1`, `target_kind/1`, `dm_eligible?/1`), kept in
  lockstep by convention. Promoting it to a public helper closes
  the convention-not-contract gap and gives external callers
  (cic-wire, future Phase 6 IRCv3 listener) a canonical predicate
  rather than re-encoding the same sigil set independently.
  """
  @spec target_kind(String.t()) :: :channel | :query
  def target_kind(<<sigil::utf8, _::binary>>) when sigil in [?#, ?&, ?!, ?+],
    do: :channel

  def target_kind(name) when is_binary(name), do: :query

  # CP14 B3 — channel-vs-DM dispatch.
  #
  # Channel-shaped names (#chan, &local, !local, +mode) and the
  # synthetic "$server" pseudo-channel resolve to a pure
  # `channel == ^name` filter — these can never be DM rows, so the
  # `:dm_with` index is irrelevant.
  #
  # Peer-shaped names (anything else, i.e. nick-shaped) resolve to
  # the union of `(channel == ^name) OR (dm_with == ^name)` so a DM
  # window for `peer` returns both:
  #   * outbound — own_nick → peer (channel = peer)
  #   * inbound — peer → own_nick (channel = own_nick, dm_with = peer
  #     populated at persist by EventRouter).
  #
  # Includes pre-CP14-B3 inbound rows where dm_with is nil — those
  # never pulled in via this branch (pre-existing inbound history for
  # peers fetched as own_nick keeps showing under the own-nick
  # window). Backfill in the migration covers as many historical
  # rows as the current credential's nick can identify; the
  # write-time path covers everything from CP14 B3 forward.
  defp channel_or_dm_where(query, channel, own_nick) when is_binary(channel) do
    # UX-4 bucket A: canonicalise the channel param at the read
    # boundary so case-insensitive lookups land on the canonical
    # lowercase row regardless of how the REST URL path-segment was
    # cased by the cic caller. Mirrors the write-time canonicalisation
    # in `Grappa.Scrollback.Message.changeset/2` + the backfill
    # migration. Sigil-aware via `Identifier.canonical_channel/1` —
    # nick-shape DM targets pass through unchanged.
    channel = Grappa.IRC.Identifier.canonical_channel(channel)

    cond do
      # Own-nick query window: restrict to self-msgs only
      # (`/msg <ownnick> body` rows where both channel + dm_with = ownnick).
      # The peer-DM OR-shape would pull every inbound DM the user ever
      # received because the server stores inbound at `channel = ownnick,
      # dm_with = peer`. CP14-B3 (47866bc) shipped without this narrowing;
      # vjt observed the bug 2026-05-10 (every CristoBOT reply leaked into
      # the `grappa` window's scrollback).
      is_binary(own_nick) and String.downcase(channel) == String.downcase(own_nick) ->
        where(query, [m], m.channel == ^channel and m.dm_with == ^channel)

      # Peer DM target (nick-shaped, NOT own-nick): outbound `/msg peer`
      # lands at `channel = peer`; inbound `<peer> PRIVMSG ownnick` lands
      # at `channel = ownnick AND dm_with = peer`. The OR matches both,
      # giving the conversation view the user expects.
      dm_eligible?(channel) ->
        where(query, [m], m.channel == ^channel or m.dm_with == ^channel)

      # Channel-shaped target (#chan, &local, etc.) — no DM aggregation.
      true ->
        where(query, [m], m.channel == ^channel)
    end
  end

  # `dm_eligible?/1` — true iff the target may carry DM rows.
  # Derived from `target_kind/1` so the sigil rule is single-sourced
  # (M7 2026-05-08): byte-equivalent to pre-M7 behaviour. The
  # `$server` carve-out stays explicit (target_kind classifies it
  # :query, but it can never carry DM history by intent doc).
  defp dm_eligible?("$server"), do: false
  defp dm_eligible?(name) when is_binary(name), do: target_kind(name) == :query

  defp subject_where(query, {:user, user_id}) when is_binary(user_id),
    do: where(query, [m], m.user_id == ^user_id)

  defp subject_where(query, {:visitor, visitor_id}) when is_binary(visitor_id),
    do: where(query, [m], m.visitor_id == ^visitor_id)

  # B5.4 L-pers-2: explicit fall-through replaces an implicit
  # FunctionClauseError (Erlang-level message hides both the
  # offending value and the function name). ArgumentError carries
  # the inspected subject so caller bugs (typo `:users` for `:user`,
  # `nil` from a stale ref, leftover atom from a refactor) surface
  # with actionable diagnostics. Same fail-loud behaviour, better
  # post-mortem.
  defp subject_where(_, other),
    do: raise(ArgumentError, "unknown subject: #{inspect(other)}")

  defp maybe_before(query, nil), do: query

  # Cursor key is monotonic id post-CP29 R-2 — was server_time, but
  # same-ms ties straddling a page boundary could lose / duplicate rows.
  # Order remains `(server_time DESC, id DESC)` for display stability.
  defp maybe_before(query, before) when is_integer(before),
    do: where(query, [m], m.id < ^before)

  @doc """
  UX-1 (2026-05-17) — deletes all scrollback rows for a DM peer in a
  `(subject, network_id)` pair. Case-insensitive on the peer nick to
  match the IRC-side lowercase normalization (`dm_with` is stored
  verbatim but compared lowered, mirroring `channel_or_dm_where/3`).

  Symmetric: drops both outbound (`channel = peer`) and inbound
  (`channel = own_nick, dm_with = peer`) sides because both rows
  carry `dm_with = peer` per CP14 B3 (write-time backfill via
  `dm_peer/4`). Pre-CP14 inbound rows with `dm_with = nil` slip
  through this filter — that's the documented residue covered by
  the CP14 migration.

  Returns `{:ok, count}` always; `count` is `0` on idempotent calls
  for an empty (subject, network, peer) triple. Never raises on
  empty matches — boundary contract is "the row stream is gone after
  this returns".

  Sole consumer: `GrappaWeb.ArchiveController.delete/2`. Caller
  resolves `subject` + `network_id` from the authenticated conn +
  `Plugs.ResolveNetwork`; controller broadcasts a typed
  `:archive_changed` event on `Topic.user(subject_label)` so connected
  cic tabs refresh their archive section.
  """
  @spec delete_for_dm(subject(), integer(), String.t()) :: {:ok, non_neg_integer()}
  def delete_for_dm(subject, network_id, peer)
      when is_integer(network_id) and is_binary(peer) do
    lower_peer = String.downcase(peer)

    # UX-3 Z (2026-05-18): match the same coalescing rule `list_archive/3`
    # uses on the read side. The read-side groups by
    # `COALESCE(dm_with, channel)` so any row with EITHER `dm_with = peer`
    # OR (`dm_with IS NULL` AND `channel = peer`) surfaces under target =
    # peer. The pre-fix write side only matched `dm_with = peer`, so
    # orphan rows — typically server NOTICEs like "No such nick/channel"
    # routed to the query window via `numeric_router.scan_params/2` with
    # `dm_with = NULL` because no PRIVMSG-direction sender/recipient pair
    # existed — appeared in archive but `delete_for_dm` returned a silent
    # `{:ok, 0}` and the operator's "really delete" tap did nothing.
    #
    # vjt 2026-05-18: ghost-* nicks vjt /msg'd that don't exist on the
    # upstream → server NOTICE 401 → persisted as channel=nick,
    # dm_with=NULL → archive shows them, delete never removed them.
    {count, _} =
      Message
      |> subject_where(subject)
      |> where([m], m.network_id == ^network_id)
      |> where(
        [m],
        fragment("lower(?)", m.dm_with) == ^lower_peer or
          (is_nil(m.dm_with) and fragment("lower(?)", m.channel) == ^lower_peer)
      )
      |> Repo.delete_all()

    {:ok, count}
  end

  @doc """
  UX-1 (2026-05-17) — deletes all scrollback rows for a channel in a
  `(subject, network_id)` pair. Case-insensitive on the channel name
  (IRC channels are case-insensitive per RFC 1459 §2.2).

  Pure `channel = ^name` filter (no DM aggregation): channel rows
  carry `dm_with = nil` per `dm_peer/4`'s otherwise arm. Peer DMs are
  out of scope here — use `delete_for_dm/3` for the query-kind path.

  Returns `{:ok, count}` always — `count` is `0` on empty matches.
  Caller (`ArchiveController.delete/2`) dispatches by sigil:
  `target_kind/1 == :channel` → here; `:query` → `delete_for_dm/3`.

  This removes local history only. The channel itself remains
  rejoinable from the IRC server's perspective — the bouncer can
  re-issue JOIN and the channel state (members, topic, modes) comes
  back from upstream. cic's confirm-modal copy makes the rejoinable
  contract explicit.
  """
  @spec delete_for_channel(subject(), integer(), String.t()) :: {:ok, non_neg_integer()}
  def delete_for_channel(subject, network_id, channel)
      when is_integer(network_id) and is_binary(channel) do
    lower_channel = String.downcase(channel)

    {count, _} =
      Message
      |> subject_where(subject)
      |> where([m], m.network_id == ^network_id)
      |> where([m], fragment("lower(?)", m.channel) == ^lower_channel)
      |> Repo.delete_all()

    {:ok, count}
  end

  @doc """
  Returns `true` if at least one row exists for `network_id`.

  Sole consumer is `Grappa.Networks.Credentials.unbind_credential/2`'s
  cascade-on-empty path: if the last user unbinds and any archival
  scrollback still references the network, the cascade rolls back
  with `{:error, :scrollback_present}` so the operator must
  explicitly delete the messages first (Phase 5
  `mix grappa.delete_scrollback`).

  Pre-A22 the same query was inlined in `Networks` as a raw
  `from(m in "messages", ...)` to dodge the Networks↔Scrollback
  Boundary cycle — cycle still exists structurally (Scrollback
  schemas reference `Networks.Network` via `belongs_to`), but
  exposing the query through this boundary keeps schema knowledge
  in one place even when `Networks` opts out of taking the
  Boundary dep.

  `Repo.exists?/1` with `limit: 1` is O(index lookup), not a count.
  """
  @spec has_messages_for_network?(integer()) :: boolean()
  def has_messages_for_network?(network_id) when is_integer(network_id) do
    query = from(m in Message, where: m.network_id == ^network_id, select: 1, limit: 1)
    Repo.exists?(query)
  end
end
