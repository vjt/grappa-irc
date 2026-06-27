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

  alias Grappa.IRC.Identifier
  alias Grappa.Repo
  alias Grappa.Scrollback.{Message, Meta}

  @max_limit 500

  # Content-bearing kinds: the ones that carry a notification meaning.
  # Mirrors `count_after_split/5`'s `:messages` bucket + `Grappa.Mentions`'
  # `@content_kinds`. Presence/control kinds never notify.
  @content_kinds [:privmsg, :notice, :action]

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

  @type subject :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

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

  ## `own_nick`

  When `own_nick` matches the requested `channel` (case-insensitive), the
  fetch restricts to self-msgs only — rows where both `channel` and
  `dm_with` equal `own_nick`. Without this, the OR-shape filter from
  `channel_or_dm_where/3` would pull every inbound DM the user ever
  received (server stores inbound DMs at `channel = own_nick,
  dm_with = peer`), polluting the own-nick query window with conversations
  from every peer.

  Pass `nil` for `own_nick` when the caller doesn't have it (channel-
  shaped target fetches don't need it; tests with synthetic data don't
  either) — the nil-ness becomes a deliberate decision at the call site
  rather than a silent default from a wrapper arity.

  Origin: 2026-05-10 — vjt observed CristoBOT replies (and every other
  peer's DMs) showing up in the `grappa` (own-nick) query window. Bug
  shipped in CP14-B3 (commit 47866bc, 2026-05-07): the `:dm_with` field
  + bidirectional fetch landed without the own-nick narrowing, so the
  own-nick query window's REST fetch returned every inbound DM ever.

  REV-J M12: previously a 5-arity wrapper auto-passed `nil` for
  `own_nick`. The wrapper was an open footgun — a future controller
  forgetting to thread `own_nick` could silently re-introduce the
  CP14-B3 leak. Per CLAUDE.md "No default arguments via `\\`" — the
  rule extends to "no wrapper arities that default a load-bearing
  parameter." Callers now state nil explicitly when they have no
  session.
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

  ## `own_nick`

  Symmetric with `fetch/6` (CP14 B3 narrowing rule). When `own_nick`
  matches `channel` (case-insensitive), the fetch restricts to
  self-msgs (rows where channel == dm_with == own_nick), preventing
  every inbound DM from leaking into the own-nick window's backfill
  page. Pass `nil` when the caller doesn't have a session (the
  channel-shape default applies) — the nil-ness is a deliberate
  decision at the call site (REV-J M12, same rule as `fetch/6`).
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
  Counts rows for `(subject, network_id, channel)` whose `id` is
  strictly greater than `after_id`. Returns an integer.

  Sole consumer: the unread-badges-from-cursor refactor (2026-06-01).
  Phoenix Channel `join_reply/1` calls `count_after(subject,
  network.id, channel, cursor || 0)` to seed cic's per-channel unread
  badge with the server-authoritative count at sync time; cic then
  derives the live count by counting local scrollback rows with `id >
  cursor` and falls back to this seed when scrollback hasn't been
  hydrated yet (or for channels the user has never opened in this
  session).

  Same predicates as `fetch_after/6` so the count exactly matches what
  a `fetch_after(..., :infinity)` would return — modulo the
  `@max_limit` cap, which `count_after/4` deliberately does not apply.
  Counts unbounded by definition: a channel with 10k unread rows
  must surface as `10000`, not `@max_limit`.

  ## `own_nick`

  Mirrors the `fetch_after/6` contract (CP14 B3 narrowing rule). When
  `own_nick` equals `channel` (case-insensitive), the count restricts
  to self-msgs so every inbound DM doesn't inflate the own-nick
  window's unread count. Pass `nil` when the caller doesn't have a
  session — the channel-shape default applies. The Phoenix Channel
  `join_reply` path threads the current credential's nick when it can
  resolve one, `nil` otherwise.

  Returns `0` for the past-tail case (`after_id >= max(id)`), `0` for
  the impossible-subject case (no rows match the subject + network),
  and the total count for `after_id = 0` (the initial-cursor case
  before the user has ever clicked).
  """
  @spec count_after(subject(), integer(), String.t(), integer(), String.t() | nil) ::
          non_neg_integer()
  def count_after(subject, network_id, channel, after_id, own_nick \\ nil)
      when is_integer(network_id) and is_integer(after_id) and
             (is_binary(own_nick) or is_nil(own_nick)) do
    Message
    |> subject_where(subject)
    |> where([m], m.network_id == ^network_id)
    |> channel_or_dm_where(channel, own_nick)
    |> where([m], m.id > ^after_id)
    |> select([m], count(m.id))
    |> Repo.one()
  end

  @doc """
  Same predicate as `count_after/5` but returns the count split into a
  `{content, presence}` pair as `%{messages: integer, events: integer}`.

  Sole consumer: the `/me` `unread_counts` envelope (bucket C, 2026-06-01)
  — cic's per-channel sidebar badge renders messages (bold) and events
  (faint) separately, so the cold-load seed needs the split too. A
  single query with a CASE-WHEN GROUP BY beats two `count_after/5`
  round-trips per (slug, channel) cursor at login time.

  Content kinds (`:privmsg | :notice | :action`) match the cic
  `isContentKind` predicate (`cicchetto/src/lib/api.ts`); every other
  kind (`:join | :part | :quit | :nick_change | :mode | :topic |
  :kick | :server_event`) counts under `:events`. The split is the
  same one the cic derived memos use (`selection.ts`'s
  `perChannelUnread`), so the seed → local-derived hand-off carries no
  visual jump.

  Returns `%{messages: 0, events: 0}` for past-tail / impossible
  subject / empty partition — never a missing key, so callers can
  pattern-match without a default.
  """
  @spec count_after_split(subject(), integer(), String.t(), integer(), String.t() | nil) ::
          %{messages: non_neg_integer(), events: non_neg_integer()}
  def count_after_split(subject, network_id, channel, after_id, own_nick \\ nil)
      when is_integer(network_id) and is_integer(after_id) and
             (is_binary(own_nick) or is_nil(own_nick)) do
    query =
      Message
      |> subject_where(subject)
      |> where([m], m.network_id == ^network_id)
      |> channel_or_dm_where(channel, own_nick)
      |> where([m], m.id > ^after_id)
      |> group_by([m], fragment("CASE WHEN ? IN ('privmsg','notice','action') THEN 1 ELSE 0 END", m.kind))
      |> select([m], {
        fragment("CASE WHEN ? IN ('privmsg','notice','action') THEN 1 ELSE 0 END", m.kind),
        count(m.id)
      })

    Enum.reduce(Repo.all(query), %{messages: 0, events: 0}, fn
      {1, n}, acc -> %{acc | messages: n}
      {0, n}, acc -> %{acc | events: n}
    end)
  end

  @doc """
  Returns up to `limit` unread CONTENT rows (`id > after_id`) for the
  `(subject, network_id, channel)` window, oldest-first.

  "Content" = `:privmsg | :notice | :action` — the same kind set
  `count_after_split/5` buckets as `:messages` and the push-trigger
  predicate (`Grappa.Push.Triggers.should_notify?/4`) can act on.
  Presence/control kinds (`:join`, `:mode`, …) never carry a
  notification meaning, so they are excluded at the SQL layer rather
  than fetched and discarded.

  Sole consumer: `Grappa.Push.BadgeCount` — it maps the REAL
  `should_notify?/4` predicate over this bounded tail to count
  notify-worthy unread per window. The `limit` is the per-channel cap
  that keeps the badge fold off an unbounded scan: a channel a user
  hasn't read in months has a huge unread range, but the badge tops out
  at 99, so fetching past the cap is wasted work. Oldest-first ordering
  is deterministic; the caller only counts matches, so direction is not
  load-bearing for correctness — `asc` keeps it stable for tests.

  Window semantics (DM vs channel) are delegated to
  `channel_or_dm_where/3`: a nick-shaped `channel` returns both inbound
  (`channel == own_nick, dm_with == peer`) and outbound (`channel ==
  peer`) DM rows. The caller's predicate excludes the outbound ones
  (own messages never notify), so no inbound/outbound split is needed
  here.
  """
  @spec unread_content_tail(
          subject(),
          integer(),
          String.t(),
          integer(),
          String.t() | nil,
          pos_integer()
        ) :: [Message.t()]
  def unread_content_tail(subject, network_id, channel, after_id, own_nick, limit)
      when is_integer(network_id) and is_integer(after_id) and
             (is_binary(own_nick) or is_nil(own_nick)) and
             is_integer(limit) and limit > 0 do
    Message
    |> subject_where(subject)
    |> where([m], m.network_id == ^network_id)
    |> channel_or_dm_where(channel, own_nick)
    |> where([m], m.id > ^after_id)
    |> where([m], m.kind in ^@content_kinds)
    |> order_by([m], asc: m.id)
    |> limit(^min(limit, @max_limit))
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
  marker has visual context on both sides (50 before, 100 next).

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

  @doc """
  Adds the channel-vs-DM dispatch `WHERE` clause to a `Message`-bound
  query (a query already-bound to `Message` so the implicit `[m]`
  binding resolves).

  Public surface: shared with `Grappa.ReadCursor`'s private
  `message_belongs?/4`
  so the read paths (`fetch/6` + friends) and the cursor-write
  validator agree on the same "what counts as a row in this window"
  predicate. UX-6 bucket K (2026-05-21): pre-K the validator used a
  literal `m.channel == ^channel` filter while reads used this
  OR-shape. The divergence rejected inbound DMs (`channel = own_nick,
  dm_with = peer`) as `:invalid_message` whenever the cursor target
  was the peer's nick — sole cause of the "PM unread-marker doesn't
  clear on focus" bug. One predicate, one rule, both paths.

  Channel-shaped names (#chan, &local, !local, +mode) and the
  synthetic "$server" pseudo-channel resolve to a pure
  `channel == ^name` filter — these can never be DM rows, so the
  `:dm_with` index is irrelevant.

  Peer-shaped names (anything else, i.e. nick-shaped) resolve to
  the union of `(channel == ^name) OR (dm_with == ^name)` so a DM
  window for `peer` returns both:

    * outbound — own_nick → peer (channel = peer)
    * inbound — peer → own_nick (channel = own_nick, dm_with = peer
      populated at persist by EventRouter).

  Own-nick query window narrowing: when `own_nick` matches `channel`
  (case-insensitive), the filter restricts to self-msgs (rows where
  both channel + dm_with = own_nick). The peer-DM OR-shape would
  otherwise pull every inbound DM the user ever received because the
  server stores inbound at `channel = own_nick, dm_with = peer`.

  Includes pre-CP14-B3 inbound rows where dm_with is nil — those
  never pulled in via this branch (pre-existing inbound history for
  peers fetched as own_nick keeps showing under the own-nick
  window). Backfill in the migration covers as many historical
  rows as the current credential's nick can identify; the
  write-time path covers everything from CP14 B3 forward.
  """
  @spec channel_or_dm_where(Ecto.Query.t(), String.t(), String.t() | nil) :: Ecto.Query.t()
  def channel_or_dm_where(query, channel, own_nick) when is_binary(channel) do
    # UX-4 bucket A: canonicalise the channel param at the read
    # boundary so case-insensitive lookups land on the canonical
    # lowercase row regardless of how the REST URL path-segment was
    # cased by the cic caller. Mirrors the write-time canonicalisation
    # in `Grappa.Scrollback.Message.changeset/2` + the backfill
    # migration. Sigil-aware via `Identifier.canonical_channel/1` —
    # nick-shape DM targets pass through unchanged.
    channel = Identifier.canonical_channel(channel)

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
  `:archive_purged` event on `Topic.user(subject_label)` so connected
  cic tabs refresh their archive section AND invalidate the in-memory
  scrollback cache for the deleted target (UX-7-B 2026-05-22).
  """
  @spec delete_for_dm(subject(), integer(), String.t()) :: {:ok, non_neg_integer()}
  def delete_for_dm(subject, network_id, peer)
      when is_integer(network_id) and is_binary(peer) do
    # REV-B / H17 (2026-05-22 codebase review): route through
    # `Identifier.canonical_channel/1` for boundary single-sourcing
    # consistency with `delete_for_channel/3` + the controller. The
    # call is a no-op on nick-shaped input (no sigil → pass-through),
    # so the `lower()` fragment comparison stays correct: `dm_with`
    # is intentionally case-preserved at write time (see
    # `lib/grappa/scrollback/message.ex:252-254`), and `dm_with` is
    # the nick comparator. The orphan-channel arm
    # (`is_nil(m.dm_with) and channel = peer`) compares against the
    # canonical-cased `channel` column — write-time canonical guarantees
    # the lowercase form, so `lower()` is redundant but harmless.
    canonical_peer = Identifier.canonical_channel(peer)
    lower_peer = String.downcase(canonical_peer)

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
    # REV-B / H17 (2026-05-22 codebase review): single-source the
    # canonicalisation rule via `Identifier.canonical_channel/1` so the
    # delete path observes the SAME normalisation the write path
    # applies in `Grappa.Scrollback.Message.canonicalize_channel/1` +
    # the UX-4-A backfill migration. Pre-fix the delete path raw-
    # downcased while the write path called the sigil-aware
    # `canonical_channel`. ASCII channels agree today (both shapes
    # collapse to `String.downcase/1` for `[A-Z]`), but any future
    # canonicalisation extension (Unicode-aware casefold, leading-`!`
    # strip, etc.) would silently make the delete miss its target
    # rows. Stored `channel` is already canonical → plain `==` (no
    # `lower()` fragment) is the correct comparison.
    canonical = Identifier.canonical_channel(channel)

    {count, _} =
      Message
      |> subject_where(subject)
      |> where([m], m.network_id == ^network_id)
      |> where([m], m.channel == ^canonical)
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
