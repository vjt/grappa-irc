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
    deps: [Grappa.Accounts, Grappa.IRC, Grappa.Repo, Grappa.Visitors.Visitor],
    # `Networks.Network` is referenced by `Scrollback.Message` (the
    # `belongs_to :network` association) and `Scrollback.Wire` (the
    # `%Network{slug: _}` pattern that A1+A26 made the wire-shape
    # contract). Declaring that ref a dirty xref lets Cluster 2's
    # Networks → Session cycle inversion land without a transitive cycle
    # (which would otherwise close
    # `Scrollback → Networks → Session → Scrollback`). The struct-only
    # nature of the dep means we lose Boundary checks on a use case
    # Boundary couldn't help with anyway (struct field access doesn't go
    # through any function call we'd want to gate); the cost is intentional.
    dirty_xrefs: [Grappa.Networks.Network],
    exports: [Message, Wire]

  import Ecto.Query

  alias Grappa.IRC.Identifier
  alias Grappa.Repo
  alias Grappa.Scrollback.{Message, Meta, Telemetry}

  # Identifier.nick_fold/1 is a query macro (ASCII fold fragment, #121/#525).
  require Identifier
  require Logger

  @max_limit 500

  # #336 / #340 — SQLite is single-writer; a write burst saturates the
  # connection pool (`Repo.insert`/`Repo.preload` RAISE
  # `DBConnection.ConnectionError`, reason: :queue_timeout) OR, when a slow
  # writer holds the lock past `busy_timeout`, raises `%Exqlite.Error{}`
  # with a "busy"/"locked" message. Both are TRANSIENT contention, not a
  # returned `{:error, _}`. Persistence is best-effort durability: it must
  # degrade under saturation, never take down the session that calls it (a
  # raised exception here crashed the Session.Server and disconnected the
  # user — the 2026-07-19 09:17 incident).
  #
  # #340 rejected a serialized batched writer (adds ~25ms latency per
  # message + is Postgres-unfriendly, and serialization does NOT buy
  # reliability — SQLite is single-writer regardless, busy_timeout already
  # rides out lock contention). The chosen model stays PARALLEL synchronous
  # inserts on the pool, tightened so ONLY a sustained flood ever loses a
  # row: retry over a generous WALL-CLOCK BUDGET (not a fixed attempt
  # count) so a normal or bursty message caught behind a burst is ridden
  # out, and a row degrades to `{:error, :persist_unavailable}` only when
  # the pool stays saturated the whole budget. The retry sleep runs AFTER
  # the failed checkout is released, so it holds no connection — it is
  # bounded backpressure on the flooding session, not a held-conn leak.
  # A non-transient Exqlite.Error (syntax/corruption) is not saturation:
  # retrying only spins, so it degrades immediately with a LOUD log.
  @persist_retry_budget_ms Application.compile_env(
                             :grappa,
                             [:scrollback, :persist_retry_budget_ms],
                             1_500
                           )
  @persist_backoff_ms Application.compile_env(:grappa, [:scrollback, :persist_backoff_ms], 25)
  @persist_backoff_cap_ms Application.compile_env(
                            :grappa,
                            [:scrollback, :persist_backoff_cap_ms],
                            200
                          )

  # Closed error set for the write path. A validation failure returns the
  # changeset (caller inspects `.errors`); a pool-saturation drop returns
  # the bare atom (nothing to inspect — the row never reached the DB, or
  # the insert landed but the wire-shape preload could not).
  @type persist_error :: Ecto.Changeset.t() | :persist_unavailable

  # Content-bearing kinds: the ones that carry a notification meaning.
  # S17 — derived from the schema SSOT (`Message.content_kinds/0`);
  # feeds `count_after_split/5`'s `:messages` bucket, the content-row
  # fetch, and the `dm_peer/4` guard here. Presence/control kinds
  # never notify.
  @content_kinds Message.content_kinds()

  # #458 — the NARROW presence-noise kinds the history reads omit when a
  # channel is hiding presence. Derived from the schema SSOT
  # (`Message.suppressed_presence_kinds/0`); consumed by
  # `maybe_exclude_presence/2`. A module attribute (compile-time list) so the
  # `not in ^...` interpolation renders `kind NOT IN (?, ?, ?)` with the atoms
  # dumped to their Ecto.Enum string values — same mechanism as
  # `count_after_split/5`'s `^@content_kinds`.
  @suppressed_presence_kinds Message.suppressed_presence_kinds()

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
        }) :: {:ok, Message.t()} | {:error, persist_error()}
  def persist_event(%{kind: kind} = attrs) when is_atom(kind) do
    changeset = Message.changeset(%Message{}, attrs)

    # #357 D1 — the insert+preload is wrapped in the `[:grappa, :scrollback,
    # :persist, …]` span (channel-tagged) so per-channel write latency
    # (mechanism 3) is measurable, and it is the "pure insert" half of the
    # split-span pair vs the send-path total (mechanism 1). The span returns
    # the raw `result` unchanged — contract untouched. Metadata is read via
    # `Map.get` (never dot-access) so a malformed attrs still fails LOUD as a
    # changeset error, not a KeyError from the telemetry tag.
    metadata = persist_metadata(attrs, kind)

    Telemetry.span_persist(metadata, fn ->
      result = persist_row(changeset)
      # `:telemetry.span` does NOT carry start metadata into `:stop` — repeat
      # the full tag map (+ outcome) so the STOP event stays channel-tagged.
      {result, Map.put(metadata, :outcome, persist_outcome(result))}
    end)
  end

  # Insert and preload each run through `with_pool_retry/1` so a pool
  # saturation raise on EITHER step degrades to `{:error, :persist_unavailable}`
  # instead of escaping. The `with` also carries a plain `{:error, %Changeset{}}`
  # validation failure straight through (that op returns, never raises, so it's
  # not retried). On a preload-only failure the row IS durably written but has
  # no `:network` assoc for the wire payload — degrading is correct: the row
  # surfaces on the next `fetch/5`, the live broadcast is what's lost. Extracted
  # from the span closure to keep `persist_event/1`'s nesting ≤ 2 (Credo).
  @spec persist_row(Ecto.Changeset.t()) :: {:ok, Message.t()} | {:error, persist_error()}
  defp persist_row(changeset) do
    with {:ok, message} <- with_pool_retry(fn -> Repo.insert(changeset) end),
         {:ok, preloaded} <- with_pool_retry(fn -> {:ok, Repo.preload(message, :network)} end) do
      {:ok, preloaded}
    end
  end

  # #357 D1 — span metadata. `channel`/`network_id` via `Map.get` (nil on a
  # malformed attrs — the changeset rejects it downstream, unchanged
  # failure mode). `subject` distinguishes user vs visitor writers so a
  # dashboard can attribute per-subject write pressure.
  @spec persist_metadata(map(), Message.kind()) :: Telemetry.persist_metadata()
  defp persist_metadata(attrs, kind) do
    %{
      channel: Map.get(attrs, :channel),
      kind: kind,
      network_id: Map.get(attrs, :network_id),
      subject: persist_subject(Map.get(attrs, :user_id), Map.get(attrs, :visitor_id))
    }
  end

  # Takes the two nilable FK values (not the whole attrs map) so the spec is
  # `term()`-precise — a `map()`-input spec here trips Dialyzer `:underspecs`
  # (the single caller narrows the map type; the spec would be a supertype).
  @spec persist_subject(term(), term()) :: Telemetry.subject()
  defp persist_subject(user_id, visitor_id) do
    cond do
      not is_nil(user_id) -> :user
      not is_nil(visitor_id) -> :visitor
      true -> :unknown
    end
  end

  @spec persist_outcome({:ok, Message.t()} | {:error, persist_error()}) ::
          Telemetry.persist_outcome()
  defp persist_outcome({:ok, _}), do: :ok
  defp persist_outcome({:error, %Ecto.Changeset{}}), do: :validation_error
  defp persist_outcome({:error, :persist_unavailable}), do: :unavailable

  @doc """
  Runs a best-effort persistence op with bounded retry over transient
  SQLite write contention (#336 / #340).

  `op` is a zero-arity fun returning `{:ok, term()}` or `{:error,
  Ecto.Changeset.t()}`. Two exception classes are caught as TRANSIENT
  contention and retried:

    * `DBConnection.ConnectionError` — the pool could not serve a
      checkout (`reason: :queue_timeout`).
    * a busy/locked `%Exqlite.Error{}` — a slow writer held the single
      SQLite write-lock past `busy_timeout`.

  The retry loop runs over a wall-clock BUDGET
  (`#{@persist_retry_budget_ms}ms`), sleeping a linear backoff capped at
  `#{@persist_backoff_cap_ms}ms` between attempts, so a normal or bursty
  message caught behind a burst is ridden out. Only when the budget is
  exhausted (the pool stayed saturated the whole time = a sustained
  flood) does the row degrade to `{:error, :persist_unavailable}` — the
  raise never crashes the calling process (#336 contract).

  A NON-transient `%Exqlite.Error{}` (syntax/corruption) is not
  saturation: it degrades IMMEDIATELY (no spin) with a loud error log,
  since retrying a broken statement only wastes the budget. A returned
  `{:error, _}` (a validation failure) is passed straight through — it
  is not a fault at all, so it is never retried.

  Public because `persist_event/1` runs BOTH its insert and its preload
  through it, and the retry/degrade contract is unit-tested here directly
  (the sandbox pool cannot reproduce a real `queue_timeout`).
  """
  @spec with_pool_retry((-> {:ok, result} | {:error, Ecto.Changeset.t()})) ::
          {:ok, result} | {:error, persist_error()}
        when result: var
  def with_pool_retry(op) when is_function(op, 0) do
    deadline = System.monotonic_time(:millisecond) + @persist_retry_budget_ms
    with_pool_retry(op, deadline, 1)
  end

  @spec with_pool_retry((-> {:ok, result} | {:error, Ecto.Changeset.t()}), integer(), pos_integer()) ::
          {:ok, result} | {:error, persist_error()}
        when result: var
  defp with_pool_retry(op, deadline, attempt) do
    op.()
  rescue
    error in [DBConnection.ConnectionError, Exqlite.Error] ->
      cond do
        not transient_fault?(error) ->
          # Syntax / corruption — retrying spins pointlessly. Degrade at
          # once (never crash — #336), but LOUD (error level, full error):
          # this is a real bug the operator/CI must see, not a saturation
          # drop. Distinct from the :warning transient-drop below.
          Logger.error(
            "scrollback persist unavailable: non-transient DB error — dropping row",
            error: inspect(error)
          )

          {:error, :persist_unavailable}

        System.monotonic_time(:millisecond) < deadline ->
          # #357 D1 — surface mechanism 2 (single-writer contention) as
          # telemetry, not just an eventual log grep: fires per transient
          # fault while the budget rides it out. On the contention path only,
          # so zero cost to an uncontended insert.
          Telemetry.contention(fault_kind(error), attempt, false)
          # The backoff sleep runs after the failed checkout was already
          # released, so it holds no connection — bounded backpressure on
          # the flooding session, not a held-conn leak (#340).
          Process.sleep(min(@persist_backoff_ms * attempt, @persist_backoff_cap_ms))
          with_pool_retry(op, deadline, attempt + 1)

        true ->
          # #357 D1 — the terminal contention event (row dropped): the
          # telemetry companion of the warning below, so a dashboard counts
          # drops without grepping logs.
          Telemetry.contention(fault_kind(error), attempt, true)

          Logger.warning(
            "scrollback persist unavailable: SQLite pool saturated for the full " <>
              "#{@persist_retry_budget_ms}ms retry budget (#{attempt} attempts) — dropping row",
            error: inspect(error)
          )

          {:error, :persist_unavailable}
      end
  end

  # #357 D1 — classify a TRANSIENT fault for the contention telemetry. Only
  # reached after `transient_fault?/1` returned true, so an `Exqlite.Error`
  # here is always busy/locked (write-lock contention) and a
  # `ConnectionError` is always a pool queue_timeout.
  @spec fault_kind(DBConnection.ConnectionError.t() | Exqlite.Error.t()) ::
          :queue_timeout | :busy_locked
  defp fault_kind(%DBConnection.ConnectionError{}), do: :queue_timeout
  defp fault_kind(%Exqlite.Error{}), do: :busy_locked

  # #340 — is this caught exception TRANSIENT write contention (retry) or a
  # permanent fault (degrade at once)? A pool queue_timeout is always
  # transient. For an Exqlite.Error the message text is the only
  # discriminator SQLite gives us: "busy"/"locked" = lock contention;
  # anything else (syntax, corruption, constraint at the driver layer) is
  # not saturation.
  @spec transient_fault?(Exception.t()) :: boolean()
  defp transient_fault?(%DBConnection.ConnectionError{}), do: true

  defp transient_fault?(%Exqlite.Error{message: message}) when is_binary(message) do
    downcased = String.downcase(message)
    String.contains?(downcased, "busy") or String.contains?(downcased, "locked")
  end

  defp transient_fault?(%Exqlite.Error{}), do: false

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
      when kind in @content_kinds and is_binary(target) and is_binary(sender) and
             is_binary(own_nick) do
    own = Identifier.canonical_target(own_nick)

    cond do
      Identifier.canonical_target(target) == own -> sender
      Identifier.canonical_target(sender) == own and nick_shaped?(target) -> target
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

  ## `hide_presence` (#458)

  When `true`, the query excludes the NARROW presence-noise kinds
  (`Message.suppressed_presence_kinds/0` — join/part/quit/nick_change) in
  SQL, so `limit` counts VISIBLE rows: one page-up is one screenful instead
  of a page that renders empty on a busy channel. The broad control kinds
  (mode/topic/kick/server_event) always stay. When `false`, every kind is
  returned (unchanged behaviour). REQUIRED positional (same no-default rule as
  `own_nick`): a `false` default would silently disable #458 for any caller
  that forgets to thread it. The per-channel decision (tri-state pref × live
  member count) is resolved by the caller via `Grappa.PresenceFilter.hidden?/2`
  — this module only applies the boolean. cic keeps its own render-layer filter
  for the LIVE WS tail; the two paths answer different questions.
  """
  @spec fetch(
          subject(),
          integer(),
          String.t(),
          integer() | nil,
          pos_integer(),
          String.t() | nil,
          boolean()
        ) :: [Message.t()]
  def fetch(subject, network_id, channel, before, limit, own_nick, hide_presence)
      when is_integer(network_id) and is_integer(limit) and limit > 0 and
             (is_binary(own_nick) or is_nil(own_nick)) and is_boolean(hide_presence) do
    capped = min(limit, @max_limit)

    Message
    |> subject_where(subject)
    |> where([m], m.network_id == ^network_id)
    |> channel_or_dm_where(channel, own_nick)
    |> maybe_exclude_presence(hide_presence)
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

  ## `hide_presence` (#458)

  Same contract as `fetch/6` — excludes the narrow presence-noise kinds when
  `true`, so the reconnect/backfill replay stays consistent with the history
  page (#458 decision B). Safe by construction: cic routes backfill rows ONLY
  to the render/scrollback store (`refreshScrollback`), NEVER through
  `applyPresenceEvent` — the members store is fed by the LIVE WS stream +
  `members_seeded` snapshots, so omitting presence from the backfill can't
  starve the nicklist.
  """
  @spec fetch_after(
          subject(),
          integer(),
          String.t(),
          integer(),
          pos_integer(),
          String.t() | nil,
          boolean()
        ) :: [Message.t()]
  def fetch_after(subject, network_id, channel, after_id, limit, own_nick, hide_presence)
      when is_integer(network_id) and is_integer(after_id) and is_integer(limit) and limit > 0 and
             (is_binary(own_nick) or is_nil(own_nick)) and is_boolean(hide_presence) do
    capped = min(limit, @max_limit)

    Message
    |> subject_where(subject)
    |> where([m], m.network_id == ^network_id)
    |> channel_or_dm_where(channel, own_nick)
    |> maybe_exclude_presence(hide_presence)
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
  network.id, channel, cursor || 0, own_nick)` to seed cic's per-channel
  unread badge with the server-authoritative count at sync time; cic then
  derives the live count by counting local scrollback rows with `id >
  cursor` and falls back to this seed when scrollback hasn't been
  hydrated yet (or for channels the user has never opened in this
  session).

  Same predicates as `fetch_after/6` so the count exactly matches what
  a `fetch_after(..., :infinity)` would return — modulo the
  `@max_limit` cap, which `count_after/5` deliberately does not apply.
  Counts unbounded by definition: a channel with 10k unread rows
  must surface as `10000`, not `@max_limit`.

  ## `own_nick`

  Mirrors the `fetch_after/6` contract (CP14 B3 narrowing rule). When
  `own_nick` equals `channel` (case-insensitive), the count restricts
  to self-msgs so every inbound DM doesn't inflate the own-nick
  window's unread count. `own_nick` is a REQUIRED positional (no
  defaulting wrapper — same rule as `fetch/6`, REV-J M12: a default
  silently re-opens the CP14-B3 leak for a caller that forgets to
  thread it — S2, 2026-07-08 review). Pass `nil` explicitly when the
  caller doesn't have a session; the channel-shape narrowing then
  applies. The Phoenix Channel `join_reply` path threads the live
  session nick when it can resolve one, `nil` otherwise; the `/me`
  cold-load threads the LIVE nick (via `Push.BadgeCount.live_nick_windows/1`,
  a cheap `Registry` lookup — #498).

  Returns `0` for the past-tail case (`after_id >= max(id)`), `0` for
  the impossible-subject case (no rows match the subject + network),
  and the total count for `after_id = 0` (the initial-cursor case
  before the user has ever clicked).
  """
  @spec count_after(subject(), integer(), String.t(), integer(), String.t() | nil) ::
          non_neg_integer()
  def count_after(subject, network_id, channel, after_id, own_nick)
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

  `own_nick` is a REQUIRED positional (same rule as `count_after/5` /
  `fetch/6`): a defaulting wrapper silently re-opens the CP14-B3
  own-nick DM over-count for any caller that forgets to thread it
  (S2, 2026-07-08 review — the `/me` cold-load did exactly that).
  """
  @spec count_after_split(subject(), integer(), String.t(), integer(), String.t() | nil) ::
          %{messages: non_neg_integer(), events: non_neg_integer()}
  def count_after_split(subject, network_id, channel, after_id, own_nick)
      when is_integer(network_id) and is_integer(after_id) and
             (is_binary(own_nick) or is_nil(own_nick)) do
    # #576 — the own-nick SELF window (channel keyed to your own nick) is the
    # ONE window where own content is legitimate payload (notes-to-self, #396),
    # so own content is NOT excluded there — only in peer / channel windows.
    self_window? =
      is_binary(own_nick) and
        Identifier.canonical_target(channel) == Identifier.canonical_target(own_nick)

    query =
      Message
      |> subject_where(subject)
      |> where([m], m.network_id == ^network_id)
      |> channel_or_dm_where(channel, own_nick)
      |> where([m], m.id > ^after_id)
      |> exclude_own_authored(own_nick, self_window?)
      # S17: the content bucket derives from `@content_kinds` (schema
      # SSOT) via Ecto's `in` — which renders the same
      # `kind IN (?, ?, ?)` predicate the hand-maintained raw-SQL list
      # did, with the atoms dumped to their Ecto.Enum string values.
      # SQLite evaluates the CASE to integer 1/0, unchanged from before.
      |> group_by([m], fragment("CASE WHEN ? THEN 1 ELSE 0 END", m.kind in ^@content_kinds))
      |> select([m], {
        fragment("CASE WHEN ? THEN 1 ELSE 0 END", m.kind in ^@content_kinds),
        count(m.id)
      })

    Enum.reduce(Repo.all(query), %{messages: 0, events: 0}, fn
      {1, n}, acc -> %{acc | messages: n}
      {0, n}, acc -> %{acc | events: n}
    end)
  end

  # #532 A + #576 — the subject's OWN rows are never "unread" to them: a
  # line they typed is read BY DEFINITION (#576 content), and leaving a
  # channel (self-PART), a KICK they issued, or renaming themselves is an
  # action they performed, not something to catch up on (#532 A presence).
  # The two matched clauses in each branch below, because a rename splits
  # identity across the row:
  #
  #   * `nick_fold(sender) == canonical_nick(own_nick)` — own CONTENT (a
  #     PRIVMSG/ACTION/NOTICE the operator sent, #576), a self-PART or a KICK
  #     the subject issued, and a case-only self-rename (`sender` is the
  #     current/live nick in all of these).
  #   * `nick_fold(meta.new_nick) == canonical_nick(own_nick)` — PRESENCE
  #     ONLY: a genuine self-rename's `:nick_change` row is persisted with
  #     `sender = OLD nick` and `meta.new_nick = NEW nick`; the live nick is
  #     the NEW one, so only the `new_nick` clause catches the TERMINAL
  #     rename, killing the recurring `$server` "+1" every `/nick` left
  #     behind. Content rows carry no `new_nick`, so the `kind not in
  #     @content_kinds` guard is intent + belt-and-braces.
  #
  # ## Self-window carve-out (#576 × #396)
  #
  # `self_window?` is TRUE when the window being counted is keyed to the
  # subject's OWN nick (`channel == own_nick`). That is the ONE window where
  # own content is legitimate payload — a note-to-self (`/msg <ownnick>`) —
  # so #396 deliberately counts it. There, we strip own PRESENCE ONLY (the
  # original #532 A predicate); own content still counts. Everywhere else (a
  # peer DM or a channel) own content is read by definition and #576 strips
  # it too. #532 A presence exclusion applies in BOTH branches. This keeps a
  # DM/channel badge from being made of your own lines (the reported bug —
  # the optimistic send-time cursor advance has gaps) WITHOUT silently
  # zeroing the self-window's notes-to-self.
  #
  # Derive-don't-duplicate: no cursor is moved, so any legitimate unread PEER
  # row that arrived before the own row survives, and it is timing-
  # independent. Same rule applied in `ReadCursor.bulk_unread_split/2` (the
  # #396 cold-load twin — the self-window test there is per-row on
  # `rc.channel`). Boundary: an INTERMEDIATE row of a multi-hop rename
  # (`alice→bob→vjt`) still counts and self-heals on the next view — a rare,
  # narrow gap. `own_nick == nil` (unbound network / no live session) → no
  # nick to match → no exclusion. Mentions stay a SEPARATE predicate (own
  # content never mentions self), untouched here.
  @spec exclude_own_authored(Ecto.Query.t(), String.t() | nil, boolean()) :: Ecto.Query.t()
  defp exclude_own_authored(query, nil, _), do: query

  # Self-window: own content is a legitimate note-to-self (#396) → count it;
  # strip own PRESENCE only (#532 A). This is byte-for-byte the pre-#576
  # exclusion.
  defp exclude_own_authored(query, own_nick, true) when is_binary(own_nick) do
    folded = Identifier.canonical_target(own_nick)

    where(
      query,
      [m],
      not (m.kind not in ^@content_kinds and
             (Identifier.nick_fold(m.sender) == ^folded or
                (not is_nil(fragment("json_extract(?, '$.new_nick')", m.meta)) and
                   Identifier.nick_fold(fragment("json_extract(?, '$.new_nick')", m.meta)) ==
                     ^folded)))
    )
  end

  # Peer / channel window: own CONTENT (#576) AND own PRESENCE (#532 A) both
  # excluded.
  defp exclude_own_authored(query, own_nick, false) when is_binary(own_nick) do
    folded = Identifier.canonical_target(own_nick)

    where(
      query,
      [m],
      not (Identifier.nick_fold(m.sender) == ^folded or
             (m.kind not in ^@content_kinds and
                not is_nil(fragment("json_extract(?, '$.new_nick')", m.meta)) and
                Identifier.nick_fold(fragment("json_extract(?, '$.new_nick')", m.meta)) ==
                  ^folded))
    )
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

  ## `hide_presence` (#458)

  Same contract as `fetch/6` — the exclusion is applied to the shared `base`
  query so BOTH the before- and after-rows inherit it. Filtered here for total
  consistency with `fetch/6` / `fetch_after/6` (#458 decision C): all three
  history reads suppress the same rows, so jump-to-context on a
  presence-hiding channel doesn't surface noise the rest of the pane hides.
  """
  @spec fetch_around(
          subject(),
          integer(),
          String.t(),
          pos_integer(),
          pos_integer(),
          String.t() | nil,
          boolean()
        ) :: [Message.t()]
  def fetch_around(subject, network_id, channel, around_id, limit, own_nick, hide_presence)
      when is_integer(network_id) and is_integer(around_id) and around_id > 0 and
             is_integer(limit) and limit > 0 and
             (is_binary(own_nick) or is_nil(own_nick)) and is_boolean(hide_presence) do
    capped = min(limit, @max_limit)
    before_count = div(capped, 2)
    after_count = capped - before_count

    base =
      Message
      |> subject_where(subject)
      |> where([m], m.network_id == ^network_id)
      |> channel_or_dm_where(channel, own_nick)
      |> maybe_exclude_presence(hide_presence)

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
  `dm_with = nil` so the COALESCE picks the channel name. The GROUP BY
  folds that key via `Identifier.nick_fold/1` (ASCII, #372/#525) so a DM
  peer that differs only in casing — the service `DebugServ` replying
  to an opened `debugserv` window — collapses to ONE archive entry
  instead of splitting. `dm_with` is stored case-PRESERVED (nick display
  rule, `message.ex`); the fold applies at the MATCH, exactly as the DM
  read (`channel_or_dm_where/3`) and delete (`delete_for_dm/3`) do. The
  selected `target` is a bare `COALESCE` (not the folded key) so the
  display casing is preserved; SQLite picks it from the row carrying the
  single `max(server_time)` aggregate (documented bare-column rule), i.e.
  the most-recent spelling. Channels fold idempotently (already canonical
  at write) so this is a no-op for them; non-ASCII case variants stay
  distinct (ASCII-only fold, matching the ircd).

  `active_keyset` is a `MapSet` of currently-active target strings —
  joined channels (from `Grappa.Session.list_channels/2`) plus open
  query window targets (from `Grappa.QueryWindows.list_for_subject/1`).
  Members are filtered OUT so the active + archive sets are disjoint per
  intent doc. The exclusion compares on the ASCII fold of BOTH sides
  (#372) — an open `debugserv` window MUST suppress the proper-case
  `DebugServ` inbound rows, not leave them as a phantom archived split.
  Empty set means everything with rows qualifies.

  The `$server` pseudo-channel is ALWAYS excluded — system surface,
  never archived per intent doc `Active/Archive boundary`. Mirrors
  `dm_eligible?/1`'s `$server` short-circuit so the rule is uniform
  across read paths.

  Result is sorted by `last_activity` DESC for stable client rendering.
  """
  @spec list_archive(subject(), integer(), MapSet.t(String.t())) :: [archive_entry()]
  def list_archive(subject, network_id, %MapSet{} = active_keyset)
      when is_integer(network_id) do
    folded_active = MapSet.new(active_keyset, &Identifier.canonical_target/1)

    Message
    |> subject_where(subject)
    |> where([m], m.network_id == ^network_id)
    |> group_by([m], Identifier.nick_fold(fragment("COALESCE(?, ?)", m.dm_with, m.channel)))
    |> select([m], %{
      target: fragment("COALESCE(?, ?)", m.dm_with, m.channel),
      last_activity: max(m.server_time),
      row_count: count(m.id)
    })
    |> Repo.all()
    |> Enum.reject(fn %{target: t} ->
      t == "$server" or MapSet.member?(folded_active, Identifier.canonical_target(t))
    end)
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
    # Canonicalise the channel param at the read boundary so
    # case-insensitive lookups land on the canonical row regardless of
    # how the REST URL path-segment was cased by the cic caller. Mirrors
    # the write-time canonicalisation in
    # `Grappa.Scrollback.Message.changeset/2`. #537 — `canonical_target/1`
    # (fold at every identifier boundary) so a nick-shaped DM/own-nick
    # window KEY folds too, matching the folded write key; the sigil-gated
    # form left it raw and the own-nick self-window read then missed its
    # own folded rows.
    channel = Identifier.canonical_target(channel)

    cond do
      # Own-nick query window: restrict to self-msgs only
      # (`/msg <ownnick> body` rows where both channel + dm_with = ownnick).
      # The peer-DM OR-shape would pull every inbound DM the user ever
      # received because the server stores inbound at `channel = ownnick,
      # dm_with = peer`. CP14-B3 (47866bc) shipped without this narrowing;
      # vjt observed the bug 2026-05-10 (every CristoBOT reply leaked into
      # the `grappa` window's scrollback).
      is_binary(own_nick) and Identifier.canonical_target(channel) == Identifier.canonical_target(own_nick) ->
        # #537 — `channel` is now the folded own-nick (canonical_target),
        # and `m.channel` is folded at write; but `m.dm_with` is stored
        # RAW (display), so the self-msg dm_with match MUST fold via
        # `nick_fold/1` or a mixed-case own_nick misses its own rows.
        where(query, [m], m.channel == ^channel and Identifier.nick_fold(m.dm_with) == ^channel)

      # Peer DM target (nick-shaped, NOT own-nick): outbound `/msg peer`
      # lands at `channel = peer`; inbound `<peer> PRIVMSG ownnick` lands
      # at `channel = ownnick AND dm_with = peer`. Match on the ASCII
      # FOLD of the peer (#372/#525) so a reply from a differently-cased sender
      # (service `DebugServ` vs the opened `debugserv` window) resolves to
      # the SAME window — `dm_with` is stored case-PRESERVED (nick display
      # rule, message.ex) so the MATCH must fold, exactly like the nick
      # invariant demands (#121). Shared `where_dm_peer/2` with
      # `delete_for_dm/3` so read + delete pick one identical window key.
      dm_eligible?(channel) ->
        where_dm_peer(query, Identifier.canonical_target(channel))

      # Channel-shaped target (#chan, &local, etc.) — no DM aggregation.
      true ->
        where(query, [m], m.channel == ^channel)
    end
  end

  @doc """
  True iff `target` may carry DM (query-window) rows — i.e. a nick-shaped
  peer window, NOT a channel and NOT the synthetic `$server` pseudo-channel.

  Derived from `target_kind/1` so the sigil rule is single-sourced
  (M7 2026-05-08): byte-equivalent to pre-M7 behaviour. The `$server`
  carve-out stays explicit (`target_kind/1` classifies it `:query`, but it
  can never carry DM history by intent doc).

  Public since #422: `Session.Server` uses it as the SINGLE predicate that
  decides whether a just-persisted content row (window key
  `dm_with || channel`, mirroring `list_archive/3`'s
  `COALESCE(dm_with, channel)`) should auto-open a server-side query window
  — so the "$server" carve-out is not re-derived at the auto-open site.
  """
  @spec dm_eligible?(String.t()) :: boolean()
  def dm_eligible?("$server"), do: false
  def dm_eligible?(name) when is_binary(name), do: target_kind(name) == :query

  # `where_dm_peer/2` — the SINGLE ASCII-folded DM-peer match: "rows
  # belonging to the DM window whose peer folds to `folded_peer`". Shared
  # by the read path (`channel_or_dm_where/3`) and the delete path
  # (`delete_for_dm/3`) so a nick that folds identically (ASCII case only,
  # A-Z; brackets `[ ] \ ~` are NOT folded, so `nick[1]`/`nick{1}` stay
  # DISTINCT) resolves to ONE window everywhere (#372/#525). `dm_with` is
  # stored case-PRESERVED (nick display rule, `message.ex`), so every MATCH
  # folds via `Identifier.nick_fold/1` — the same query-side twin the WHOIS
  # / query_windows lookups use (#121).
  # `folded_peer` MUST already be `Identifier.canonical_nick/1`-folded by
  # the caller (the value side of the fold).
  #
  # #393 — SARGABLE single predicate on `fold(COALESCE(dm_with, channel))`.
  # This is EXACTLY equivalent to the prior two-arm disjunction
  # `fold(dm_with) == peer OR (dm_with IS NULL AND fold(channel) == peer)`:
  # when `dm_with` is non-NULL the COALESCE picks it (first arm); when it
  # is NULL the COALESCE picks `channel` (the orphan arm — a server NOTICE
  # 401 routed to a query window via numeric_router). vjt proved the
  # equivalence empirically on a prod copy (`EXCEPT` over the whole of
  # network 3: ZERO id mismatches, 27 rows vs 27). The disjunction form
  # was NON-sargable — even with per-arm folded expression indexes the
  # planner stayed on `messages_network_id_index` and folded row-by-row
  # over the whole network's history (prod 2026-07-25: SQLite pool
  # saturation, the `SELECT scrollback` at 409ms and `count_after_split`
  # DM shape at 432ms). Collapsing the OR to one folded-COALESCE equality
  # lets SQLite SEEK the matching expression index
  # (`messages_<subject>_id_network_id_dm_coalesce_fold_id_kind_index` —
  # `(subject, network_id, fold(COALESCE(dm_with, channel)), id, kind)`;
  # `kind` at the tail makes the count aggregate covering, `id` keeps the
  # `id > cursor` reads seekable): prod `EXPLAIN` flipped from `SEARCH USING
  # messages_network_id_index` to `SEARCH USING COVERING INDEX ...
  # (subject=? AND network_id=? AND <expr>=? AND id>?)`, 204ms → 0.000s.
  # The expression is byte-identical to `Identifier.nick_fold_sql/1`
  # applied to the COALESCE (pin test) and reuses the SAME query fragment
  # `list_archive/3`'s GROUP BY already uses (in-house precedent). Because
  # the match lives ONLY here, every consumer of the shared predicate
  # (`fetch/6`, `fetch_after/6`, `fetch_around/6`, `unread_content_tail/6`,
  # `count_after/5`, `count_after_split/5` via `channel_or_dm_where/3`, and
  # `delete_for_dm/3` directly) becomes sargable in one shot.
  @spec where_dm_peer(Ecto.Query.t(), String.t()) :: Ecto.Query.t()
  defp where_dm_peer(query, folded_peer) when is_binary(folded_peer) do
    where(
      query,
      [m],
      Identifier.nick_fold(fragment("COALESCE(?, ?)", m.dm_with, m.channel)) == ^folded_peer
    )
  end

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

  # #458 — when hiding, exclude the narrow presence-noise kinds
  # (@suppressed_presence_kinds) in SQL so `limit` counts VISIBLE rows. The
  # `not in ^...` renders `kind NOT IN (?, ?, ?)` with the atoms dumped to
  # their Ecto.Enum string values (same mechanism as count_after_split/5).
  # There is no index on `messages.kind` (#458 note): the predicate rides the
  # existing composite after the index scan — fine at current volumes.
  defp maybe_exclude_presence(query, false), do: query

  defp maybe_exclude_presence(query, true),
    do: where(query, [m], m.kind not in ^@suppressed_presence_kinds)

  @doc """
  UX-1 (2026-05-17) — deletes all scrollback rows for a DM peer in a
  `(subject, network_id)` pair. Folds the peer nick under the ASCII fold
  (#121/#525) to
  match the IRC-side normalization (`dm_with` is stored case-preserved
  but MATCHED folded, via the shared `where_dm_peer/2` — the same window
  key `channel_or_dm_where/3` reads, #372).

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
    # call is a no-op on nick-shaped input (no sigil → pass-through);
    # `canonical_nick/1` then folds it to the value side of the match.
    canonical_peer = Identifier.canonical_target(peer)
    folded_peer = Identifier.canonical_target(canonical_peer)

    # `where_dm_peer/2` (shared with the read path, #372) matches both
    # DM directions AND the orphan-channel arm. UX-3 Z (2026-05-18): the
    # orphan arm (`dm_with IS NULL` AND folded `channel` = peer) is why a
    # ghost-* nick vjt /msg'd that doesn't exist upstream — server NOTICE
    # 401 persisted as channel=nick, dm_with=NULL via
    # `numeric_router.scan_params/2` — is deletable; pre-fix it appeared
    # in archive (surfaced by `list_archive/3`'s COALESCE) yet
    # `delete_for_dm` returned a silent `{:ok, 0}` and the operator's
    # "really delete" tap did nothing.
    {count, _} =
      Message
      |> subject_where(subject)
      |> where([m], m.network_id == ^network_id)
      |> where_dm_peer(folded_peer)
      |> Repo.delete_all()

    {:ok, count}
  end

  @doc """
  #373 — migrates every DM scrollback row for `old_nick` to `new_nick`
  in `(subject, network_id)`, so a query window that followed a peer's
  NICK change keeps its history (`channel_or_dm_where/3` reads a peer
  window by the ASCII fold of the peer nick).

  Case-insensitive on both nicks (ASCII fold, #121/#525). A case-only
  change (`fold(old) == fold(new)`) is a noop (`{:ok, 0}`): the read
  path already resolves both to one folded window, and `dm_with` /
  `channel` are stored case-preserved for display (#372), so nothing
  needs rewriting.

  Two scoped column updates (the DM row shapes are `dm_peer/4`'s):

    * `dm_with := new_nick` where `fold(dm_with) == fold(old)` — the peer
      column on BOTH inbound (`channel = own_nick, dm_with = peer`) AND
      outbound (`channel = peer, dm_with = peer`) rows.
    * `channel := new_nick` where `fold(channel) == fold(old)` — the
      outbound + orphan (`dm_with IS NULL, channel = peer`, e.g. a 401
      NOTICE) rows. Inbound rows carry `channel = own_nick` (folds to
      own_nick, not `old`) so they are left untouched; channels carry a
      sigil so `#old` never folds to a bare nick — no cross-hit.

  Returns `{:ok, count}` where `count` is the number of DISTINCT DM rows
  migrated (the row-set `delete_for_dm/3` matches via the shared
  `where_dm_peer/2`); `0` on empty / noop.

  Sole production caller: `Grappa.Session.Server.apply_effects/2` on the
  `{:peer_nick_renamed, old, new}` effect, AFTER `QueryWindows.rename/4`
  reports `:renamed` — so history migrates exactly when the window moved.
  """
  @spec rename_dm_peer(subject(), integer(), String.t(), String.t()) ::
          {:ok, non_neg_integer()}
  def rename_dm_peer(subject, network_id, old_nick, new_nick)
      when is_integer(network_id) and is_binary(old_nick) and is_binary(new_nick) do
    folded_old = Identifier.canonical_target(old_nick)
    folded_new = Identifier.canonical_target(new_nick)

    if folded_old == folded_new do
      {:ok, 0}
    else
      base =
        Message
        |> subject_where(subject)
        |> where([m], m.network_id == ^network_id)

      # DISTINCT migrated-row count via the shared DM-peer predicate — the
      # union of the two column updates below, so no double-count.
      count = base |> where_dm_peer(folded_old) |> Repo.aggregate(:count)

      if count > 0 do
        # `dm_with` is the DISPLAY column → set the RAW new nick.
        base
        |> where([m], Identifier.nick_fold(m.dm_with) == ^folded_old)
        |> Repo.update_all(set: [dm_with: new_nick])

        # #537 — `channel` is the window KEY → set the FOLDED new nick,
        # not the raw one. `Repo.update_all` bypasses the changeset fold
        # (`Message.canonicalize_channel/1`), so a raw value here would
        # re-fork the window the moment the next persist folds its key
        # and misses these migrated rows.
        base
        |> where([m], Identifier.nick_fold(m.channel) == ^folded_old)
        |> Repo.update_all(set: [channel: folded_new])
      end

      {:ok, count}
    end
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
    canonical = Identifier.canonical_target(channel)

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

  Sole consumer is `Grappa.Networks.delete_network/1`'s teardown gate:
  the `messages.network_id` FK is `:restrict`, so an explicit network
  delete refuses with `{:error, :scrollback_present}` while any archival
  scrollback still references it. The operator must delete the messages
  first (Phase 5 `mix grappa.delete_scrollback`). Unbind no longer
  consults this — it never deletes the network (GH #105).

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
