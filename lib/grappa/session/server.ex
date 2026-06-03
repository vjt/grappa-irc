defmodule Grappa.Session.Server do
  @moduledoc """
  GenServer that owns one `(user_id, network_id)` upstream IRC session.

  Supervises one `Grappa.IRC.Client` (linked via `start_link`) which owns
  the TCP/TLS socket. Inbound parsed `Grappa.IRC.Message` structs arrive
  in this GenServer's mailbox as `{:irc, msg}` tuples; outbound
  protocol-level work (handshake on init, PONG on PING, JOIN on autojoin)
  is performed via the high-level `Grappa.IRC.Client` helpers.

  Registered under `{:via, Registry, {Grappa.SessionRegistry, {:session,
  user_id, network_id}}}` so the public `Grappa.Session.whereis/2`
  facade can resolve a pid from the internal identifiers (UUID +
  integer FK) that every authn'd request handler already has.

  ## Cluster 2 — A2 cycle inversion

  `init/1` is a pure data consumer: it takes the fully-resolved
  `t:Grappa.Session.start_opts/0` map (host / port / tls / nick /
  realname / sasl_user / password / auth_method / autojoin_channels
  / subject / subject_label / network_slug, plus network_id merged
  in by `Grappa.Session.start_session/3`) and does NO DB reads — no
  `Grappa.Accounts`, no `Grappa.Networks`, no `Grappa.Repo`,
  no `Grappa.Visitors`. The
  server-pick policy + credential resolution live on
  `Grappa.Networks.SessionPlan.resolve/1` (Networks owns the data, Session
  owns the connection).

  `:transient` restart replays the SAME cached opts the supervisor
  child spec captured at first start, BUT `init/1` re-resolves the
  plan from the DB on every invocation via the injected
  `refresh_plan` closure — credential / visitor row rotations
  (`update_nick/2`, `update_last_joined_channels/2`, operator
  config edits) propagate to live state on the very next restart.
  See `t:refresh_plan_check/0` for the contract + the Azzurra
  2026-05-27 incident driver.

  ## Phase 1 protocol scope

  This is the walking-skeleton implementation:

    * Upstream registration handshake (PASS, CAP LS, NICK, USER,
      AUTHENTICATE, CAP END) is owned by `Grappa.IRC.Client` —
      `init/1` drives the state machine per `:auth_method`.
    * Autojoin fires on `001 RPL_WELCOME`. Phase 5 hardens this to also
      handle `376 RPL_ENDOFMOTD` / `422 ERR_NOMOTD` and a watchdog
      timeout in case neither arrives.
    * `PRIVMSG` is the only inbound event that gets persisted to
      `Grappa.Scrollback` AND broadcast over `Phoenix.PubSub`. Other
      event types (`JOIN`, `PART`, `QUIT`, `NICK`, `MODE`, `TOPIC`,
      `KICK`) get a `Logger.info` line only — broadcasting them
      requires channel-membership tracking that lands in Phase 5.
    * No reconnect/backoff. A socket close stops the linked Client,
      which kills this Session via the link signal; the
      `DynamicSupervisor` restart policy (`:transient`) brings it back
      with a fresh socket. Phase 5 adds exponential backoff inside
      the Client's connect path.

  ## Wire shape (broadcast contract)

  PRIVMSG broadcasts emit `Grappa.Scrollback.Wire.message_payload/1`
  via `Grappa.PubSub.broadcast_event/2` on the per-(subject, network,
  channel) topic built via `Grappa.PubSub.Topic.channel/3`.
  `state.subject_label` is the first segment (sub-task 2h, generalized
  in Task 6.5) so multi-user + visitor instances cannot leak broadcasts
  across subjects — payload-level iso (decision G3 dropped `user_id`
  from the wire) needed routing-level iso to actually keep alice / vjt
  / visitor PubSub mailboxes separate.

  ## Outbound API (Task 9)

  `handle_call({:send_privmsg, target, body}, _, state)` persists a
  scrollback row with `sender = state.nick`, broadcasts on the
  per-channel PubSub topic, AND sends the PRIVMSG upstream — atomic
  from the caller's view, single source for the row + wire event.
  `{:send_join, ch}` / `{:send_part, ch}` are upstream-only
  (channel-membership tracking lands in Phase 5 alongside JOIN/PART
  persistence).
  """
  use GenServer, restart: :transient

  alias Grappa.IRC.{AuthFSM, Client, Identifier, Message}
  alias Grappa.{Log, Mentions, Scrollback, Session, UserSettings}
  alias Grappa.PubSub.Topic
  alias Grappa.Push.Triggers, as: PushTriggers
  alias Grappa.Scrollback.Wire

  alias Grappa.Session.{
    AwayState,
    Backoff,
    EventRouter,
    GhostRecovery,
    ModeChunker,
    NSInterceptor,
    NumericRouter,
    PartCleanup,
    WindowState
  }

  alias Grappa.Session.Wire, as: SessionWire

  require Logger

  @typedoc """
  A window reference — the `kind:` discriminator plus optional `target:` name.
  Used as the value type for `last_command_window` and `labels_pending` entries.
  The `kind:` closed set mirrors `NumericRouter.window_kind()`.

  Declared here (not in NumericRouter) because Session.Server owns the state;
  NumericRouter imports the type. Matching the exact shape lets NumericRouter
  pattern-match on it directly.
  """
  @type window_ref :: %{kind: NumericRouter.window_kind(), target: String.t() | nil}

  # 30-second debounce before issuing AWAY after all WS connections drop.
  # Gives the user time to open a new tab without going away. The auto-away
  # reason string itself lives on `AwayState.auto_away_reason/0` (moved
  # there in cluster #7 — single injection site is `set_auto_away/1`).
  @auto_away_debounce_ms 30_000

  # 10s is generous for an upstream NickServ → +r MODE round-trip; even
  # a sluggish ircd should confirm in <2s. The timer is a fail-safe so
  # an unconfirmed password doesn't sit on the heap forever, NOT an SLA.
  # Wrong passwords get wiped after this window, so the visitor DB
  # never sees them.
  @pending_auth_timeout_ms 10_000

  # 8s is the GhostRecovery 4-step round-trip budget (NICK_ → GHOST →
  # NickServ NOTICE → WHOIS → 401-vs-311). NickServ acknowledgements
  # are typically sub-second; an 8s ceiling protects against an upstream
  # services outage holding the FSM open indefinitely.
  @ghost_recovery_timeout_ms 8_000

  @typedoc """
  Optional opaque callback the visitor-side `SessionPlan` injects into
  every visitor plan. Invoked by `apply_effects/2` when EventRouter
  emits `:visitor_r_observed` so the captured NickServ password can
  land on the visitors row atomically. The function shape mirrors
  `Grappa.Visitors.commit_password/2` exactly. Carried as an opaque
  function reference (not a module name) to avoid a static
  `Session → Visitors` boundary alias — Visitors already deps Session
  via `Visitors.Login`, so a literal alias would close a cycle.
  """
  @type visitor_committer ::
          (Ecto.UUID.t(), String.t() ->
             {:ok, struct()} | {:error, :not_found | Ecto.Changeset.t()})

  @typedoc """
  V9 (visitor-parity cluster, 2026-05-15) — opaque callback the
  visitor-side `SessionPlan` injects so `apply_effects/2` can rotate
  `visitors.nick` after EventRouter observes the upstream NICK
  self-echo. Same Boundary-cycle reasoning as `visitor_committer`:
  Visitors deps Session via Login, so a static
  `Session → Grappa.Visitors` alias would close the cycle. The
  function shape mirrors `Grappa.Visitors.update_nick/2` exactly.
  """
  @type visitor_nick_persister ::
          (Ecto.UUID.t(), String.t() ->
             {:ok, struct()} | {:error, :not_found | Ecto.Changeset.t()})

  @typedoc """
  Optional opaque callback injected by `Networks.SessionPlan.resolve/1`
  into every user-session plan. Called from `handle_terminal_failure/2`
  when a hard upstream error (k-line / permanent SASL) means the session
  should never be restarted without operator action.

  The closure captures `user_id` + `network_id` and calls
  `Networks.mark_failed_by_ids/3` — a static Networks alias is avoided
  here for the same Boundary reason as `visitor_committer` (Networks
  already deps Session; closing the cycle is banned by `use Boundary`).

  Calling convention: fire inside `Task.start/1` BEFORE `{:stop, :normal}`
  so the Server's GenServer exit is truly `:normal` and the `:transient`
  supervisor doesn't restart. The Task's async execution means
  `mark_failed_by_ids` runs after the process has exited — `stop_session`
  inside `mark_failed` finds `whereis → nil` and is a no-op.
  """
  @type credential_failer :: (String.t() -> :ok)

  @typedoc """
  CP22 cluster B (channel-client-polish #14, B-restart) — opaque
  callback that persists the current `Map.keys(state.members)` snapshot
  so a graceful or crash restart can rehydrate the channel list at boot.

  Boundary-clean: Session.Server cannot reference `Grappa.Networks`
  directly (the cycle is banned — Networks already deps Session for
  stop_session calls on /disconnect). The callback wraps a closure
  that knows the (user_id, network_id) pair and forwards to
  `Grappa.Networks.Credentials.update_last_joined_channels/3`.
  Returns `:ok` on success or `{:error, reason}`; Session.Server logs
  failures but does not retry — the next channels-list mutation
  overwrites, and a missing snapshot only forces the next restart to
  fall back to operator autojoin.
  """
  @type last_joined_persister :: ([String.t()] -> :ok | {:error, term()})

  @typedoc """
  Opaque function-reference indirection that lets `Session.Server`
  ask the producing context (Networks / Visitors) "re-resolve the
  fresh plan from the DB" without statically aliasing either module.
  Boundary-clean for the same reason as `visitor_committer` +
  `credential_failer`: both context boundaries already deps
  `Grappa.Session` for `stop_session`, so the reverse direction
  cannot be expressed without closing a cycle.

  Called at the top of `Session.Server.init/1` on EVERY init —
  both first boot AND `:transient` respawn. The closure returns
  `{:ok, plan}` where `plan` is the fresh `t:Grappa.Session.start_opts/0`
  the producer just re-derived from the current DB row(s); init then
  merges it over the cached opts via `Map.merge(opts, plan)` so DB
  values win on shared keys (`:nick`, `:autojoin_channels`,
  `:password`, `:host`, `:port`, `:tls`, etc) while opts-only keys
  (`:network_id`, `:notify_pid`, `:notify_ref`, test fixtures) survive.

  `{:error, :not_found}` replaces the prior `subject_row_present? ->
  false` branch — same `:ignore` semantics, strictly more
  informative shape (the producer says "row is gone" with the same
  call that would otherwise return the fresh plan).

  ## Why this matters — the zombie-respawn class of bug

  `DynamicSupervisor.start_child/2` caches the original child spec
  (`{Server, opts}`) at spawn time. A `:transient` restart replays
  the SAME cached opts — credential / visitor row changes in the DB
  do NOT propagate. Pre-`refresh_plan`, every restart re-registered
  upstream with the boot-time nick and the boot-time autojoin set,
  even if the user had `/NICK`ed away or joined channels since.

  Incident driver (2026-05-27 Azzurra): visitor connected as
  `kazam02`, `/NICK kazamobile` persisted (`visitors.nick` rotated),
  upstream `:ssl_closed` triggered restart, respawn used the cached
  `kazam02` + empty autojoin → zombie session, DB and live state
  divergent, no channels rejoined.

  The closure also subsumes the prior delete-race fix: if the
  operator removes the row between spawn and restart, `:not_found`
  ends the restart loop on the very first cycle (same outcome as
  the old `subject_row_present? -> false`).
  """
  @type refresh_plan_check :: (-> {:ok, map()} | {:error, :not_found})

  @typedoc """
  Per-channel window state (CP15 — event-driven windows). The Session
  Server is the single source of truth; cic projects from broadcast
  events on the per-channel topic.

  Storage owned by `Grappa.Session.WindowState` (cluster #6 extraction).
  This typedef is the on-process atom shape; see that module for the
  full state-machine documentation.

  - `:joined` — own-nick JOIN echo received (B1).
  - `:failed` — server replied with a join failure numeric (B2).
  - `:kicked` — own-nick was the target of a KICK (B3).
  - `:parted` — currently unused (PART removes the entry entirely; cic
    derives `:archived` from absence + scrollback presence via B4 archive
    surface).
  - `:parked` — T32 disconnect/connect: connection is intentionally idle
    (B3 wires the broadcast).
  - `:pending` — outbound JOIN recorded as in-flight (CP17). Written
    by `record_in_flight_join/2`; cleared when the channel transitions
    to `:joined` / `:failed` / `:kicked` or removed on PART. Broadcast
    on `Topic.user/1` (NOT per-channel — chicken-and-egg: cic only
    subscribes to per-channel after seeing `:pending`).
  """
  @type window_state :: WindowState.window_state()

  @typedoc """
  In-flight JOIN tracking entry (CP15 B2). Recorded on every outbound
  JOIN — both cic-initiated `Session.send_join/4` calls and the 001
  RPL_WELCOME autojoin loop — keyed by `String.downcase/1` of the
  channel so a 471/473/474/475/403/405 failure numeric can correlate
  even when the upstream echoes a case-folded channel name.

  - `channel` — case-preserved as written by the caller (the form we
    use when broadcasting `kind: "join_failed"`, so cic addresses the
    same window the user typed).
  - `at_ms` — `System.monotonic_time(:millisecond)` at insert time.
    Drives the lazy 30s TTL sweep on next insert.
  - `label` — labeled-response correlation tag if the upstream caps
    `labeled-response`; else `nil`. Layer 1 (label-match) and layer 2
    (channel-param fallback) per the impl plan Q8 resolution.
  """
  @type in_flight_join :: {channel :: String.t(), at_ms :: integer(), label :: String.t() | nil}

  @typedoc """
  Internal init arg — `t:Grappa.Session.start_opts/0` plus the
  `network_id` key `Grappa.Session.start_session/3` merges in. The
  `subject` field is already in `start_opts/0` (Task 6.5 — subject
  is no longer a separate positional, it's part of the resolved plan
  alongside `subject_label`).
  """
  @type init_opts :: %{
          required(:subject) => Grappa.Session.subject(),
          required(:subject_label) => String.t(),
          required(:network_id) => integer(),
          required(:network_slug) => String.t(),
          required(:nick) => String.t(),
          required(:realname) => String.t(),
          required(:sasl_user) => String.t(),
          required(:auth_method) => AuthFSM.auth_method(),
          required(:password) => String.t() | nil,
          required(:autojoin_channels) => [String.t()],
          required(:host) => String.t(),
          required(:port) => :inet.port_number(),
          required(:tls) => boolean(),
          required(:source_address) => String.t() | nil,
          optional(:notify_pid) => pid(),
          optional(:notify_ref) => reference(),
          optional(:visitor_committer) => visitor_committer(),
          optional(:visitor_nick_persister) => visitor_nick_persister(),
          optional(:credential_failer) => credential_failer(),
          optional(:last_joined_persister) => last_joined_persister(),
          optional(:refresh_plan) => refresh_plan_check()
        }

  @type t :: %{
          subject: Grappa.Session.subject(),
          subject_label: String.t(),
          network_id: integer(),
          network_slug: String.t(),
          nick: String.t(),
          members: %{String.t() => %{String.t() => [String.t()]}},
          seeded_channels: MapSet.t(String.t()),
          topics: %{String.t() => EventRouter.topic_entry()},
          channel_modes: %{String.t() => EventRouter.channel_mode_entry()},
          # Cluster `channel-created-notice` 2026-05-13 — per-channel
          # creation timestamp from 329 RPL_CREATIONTIME. Lifecycle
          # mirrors `topics` (populated on JOIN-time numeric, dropped on
          # self-PART/self-KICK). Empty map until first 329 lands;
          # Azzurra/Bahamut historically don't emit 329 so this stays
          # empty for that network. Wire event `channel_created` carries
          # the DateTime (via SessionWire.channel_created/3) so cic's
          # `channelCreated` store seeds JoinBanner's "Channel was created
          # on …" line.
          channels_created: %{String.t() => DateTime.t()},
          userhost_cache: EventRouter.userhost_cache(),
          # CP15 B1 + cluster #6 extraction: per-channel window state
          # bundle (states + failure_reasons + failure_numerics +
          # kicked_meta in one struct). Sibling to `members` —
          # identical lifetime + supervision (in-process struct,
          # derived on boot from autojoin's natural transition flow
          # per Q5; no persistence). CP17 made `:pending` explicit
          # (written by `record_in_flight_join/2`); self-JOIN echo
          # writes :joined; B2 adds :failed, B3 adds :kicked /
          # :parted / :parked. Absence after PART = :archived (derived
          # externally by cic from the archive surface, B4). See
          # `Grappa.Session.WindowState` for the full state machine.
          window_state: WindowState.t(),
          # CP15 B2: in-flight JOINs awaiting upstream confirmation
          # (self-JOIN echo) or failure numeric (471/473/474/475/403/405).
          # Keyed by lowercase channel so the failure-numeric correlation
          # is case-insensitive per RFC 2812 §2.2; entry is stripped on
          # either resolution. Lazy 30s TTL sweep on next insert keeps the
          # map bounded under upstream silence.
          in_flight_joins: %{String.t() => in_flight_join()},
          autojoin: [String.t()],
          client: pid() | nil,
          notify_pid: pid() | nil,
          notify_ref: reference() | nil,
          pending_auth: nil | {String.t(), integer()},
          pending_auth_timer: reference() | nil,
          pending_password: String.t() | nil,
          visitor_committer: visitor_committer() | nil,
          visitor_nick_persister: visitor_nick_persister() | nil,
          credential_failer: credential_failer() | nil,
          last_joined_persister: last_joined_persister() | nil,
          ghost_recovery: GhostRecovery.t() | nil,
          ghost_timer: reference() | nil,
          away_state: AwayState.t(),
          auto_away_timer: reference() | nil,
          # S4.2: IRCv3 caps confirmed active by upstream CAP ACK. Keys are
          # lowercase cap names (e.g. "labeled-response"). Empty until the
          # upstream ACKs at least one cap. Caps added on ACK; never removed
          # (a registered-phase CAP DEL is not handled — out of S4 scope).
          caps_active: MapSet.t(String.t()),
          # S4.2: in-flight label → origin_window correlations for the
          # `labeled-response` cap. Bounded to currently-in-flight tracked
          # commands (typically <10 at a time; users issue one command, wait
          # for response, issue next). Entries are removed on numeric arrival
          # (see handle_numeric_with_routing/2) so the map stays small.
          # NOT persisted across crashes — a crash clears the window, and
          # any labeled numerics that arrive post-restart are routed via
          # param-derived or last_command_window fallback.
          labels_pending: %{String.t() => window_ref()},
          # S4.3: last window that originated a cicchetto command. Updated
          # on every `:send_*` call that carries an origin_window. Used by
          # NumericRouter as the `:active` fallback when labeled-response
          # is unavailable and param-derived routing returns {:active, nil}.
          # `nil` until the user issues the first command in this session.
          last_command_window: window_ref() | nil,
          # S5.1: ISUPPORT MODES=N advertised by the upstream server. Bounds
          # how many mode changes a single MODE line may carry. Defaults to 3
          # per IRCv3 spec when the upstream omits MODES= from 005. Updated
          # when 005 RPL_ISUPPORT arrives with a MODES= token. Kept as a
          # bounded integer on state (not a generic ISUPPORT map) to stay
          # minimal — only MODES= is consumed server-side for now.
          modes_per_chunk: pos_integer(),
          # BUGHUNT-1 A — max wire-frame size for outbound PRIVMSG auto-
          # split. Defaults to 512 per RFC 2812 when upstream omits
          # LINELEN= from 005 RPL_ISUPPORT (Bahamut/InspIRCd/UnrealIRCd
          # commonly do). Used by `Grappa.IRC.LineSplit` to compute the
          # body budget = `linelen - byte_size("PRIVMSG <target> :\r\n")`.
          # Sibling shape to `modes_per_chunk` — bounded integer on
          # state, not a generic ISUPPORT map.
          linelen: pos_integer(),
          # C2 — per-target WHOIS accumulator. Keyed by lowercased target
          # nick. Entry shape (all fields optional except target_display):
          # `%{target_display, user, host, realname, server, server_info,
          # is_operator, idle_seconds, signon, channels}`. Populated by
          # EventRouter on 311/312/313/317/319 and drained by 318
          # RPL_ENDOFWHOIS into a `{:whois_bundle, target, accum}` effect.
          # Bounded by in-flight /whois commands (typically 0-1 at a time).
          whois_pending: %{String.t() => map()},
          # CP22 cluster B — per-target WHO accumulator. Keyed by
          # lowercased target channel. Entry shape:
          # `%{target_display: String.t(), replies: [map()]}` where each
          # reply is `%{nick, modes, user, host, server, hops, realname}`.
          # Populated by EventRouter on 352 RPL_WHOREPLY and drained by
          # 315 RPL_ENDOFWHO into N+1 `{:persist, :notice, attrs}` effects
          # (one per reply + one EOF terminator), routed to the target
          # channel if joined or `$server` otherwise. Bounded by in-flight
          # /who commands (typically 0-1 at a time).
          who_pending: %{String.t() => map()},
          # P-0d — pending LUSERS accumulator. Bahamut emits a fixed
          # sequence (251 → 252 → 253? → 254 → 255 → 265 → 266) on connect-
          # welcome AND on operator-issued /lusers; there's NO terminator
          # numeric. Implicit-end strategy: any non-LUSERS-class numeric
          # flushes the accumulator into a `:lusers_bundle` effect.
          # `nil` = no bundle in progress (idle); the map starts on the
          # first LUSERS numeric and fills until flush. NOT persisted
          # across crashes — operator types /lusers to refresh.
          lusers_pending: nil | map(),
          # CP22 cluster B (channel-client-polish #14) — pending NAMES
          # accumulators keyed by lowercased target channel. Set up on
          # `:send_names`; 353 RPL_NAMREPLY rows merge their nick lists
          # into the entry; 366 RPL_ENDOFNAMES emits 2 `{:persist, :notice,
          # attrs}` effects (one carrying the full nick list + one EOF
          # terminator). /names UX cluster N-1+N-2: rows are ALWAYS emitted
          # (silence is the bug); routing channel is `:origin_window` if
          # set (cic-side focused window when /names was issued), else the
          # target if joined, else `$server`. NOT persisted across crashes.
          names_pending: %{String.t() => map()},
          # P-0c — pending WHOWAS accumulators keyed by lowercased target
          # nick. Set up on `:send_whowas`; 314 RPL_WHOWASUSER appends an
          # entry `%{user, host, realname}` to `entries`; 312 (gated for
          # WHOWAS in EventRouter) merges `server` + `logoff_time` into
          # the LAST entry; 369 RPL_ENDOFWHOWAS emits `{:whowas_bundle,
          # target, accum}` and 406 ERR_WASNOSUCHNICK emits a bundle with
          # `not_found: true`. Bounded by in-flight /whowas commands
          # (typically 0-1 at a time). NOT persisted across crashes.
          whowas_pending: %{String.t() => map()}
        }

  ## API

  @spec start_link(init_opts()) :: GenServer.on_start()
  def start_link(%{subject: subject, network_id: network_id} = opts)
      when is_integer(network_id) and is_tuple(subject) do
    GenServer.start_link(__MODULE__, opts, name: via(subject, network_id))
  end

  @doc """
  Returns the registry key for `(subject, network_id)`. Single source
  of truth for the `{:session, subject, network_id}` shape — every
  caller that needs to look up or terminate a session by key must go
  through this. The tagged-tuple `subject` keeps user-side and
  visitor-side sessions on the same `network_id` from colliding.
  """
  @spec registry_key(Grappa.Session.subject(), integer()) ::
          {:session, Grappa.Session.subject(), integer()}
  def registry_key(subject, network_id) when is_tuple(subject) and is_integer(network_id) do
    {:session, subject, network_id}
  end

  @doc "Returns the via-tuple for the session registered for `(subject, network_id)`."
  @spec via(Grappa.Session.subject(), integer()) ::
          {:via, Registry, {atom(), {:session, Grappa.Session.subject(), integer()}}}
  def via(subject, network_id) when is_tuple(subject) and is_integer(network_id) do
    {:via, Registry, {Grappa.SessionRegistry, registry_key(subject, network_id)}}
  end

  ## GenServer callbacks

  # `init/1` is intentionally non-blocking — `Client.start_link/1` runs
  # in `handle_continue(:start_client, _)` so a slow upstream cannot
  # serialize Bootstrap's per-credential `Enum.reduce` start_child
  # loop. Pairs with `Grappa.IRC.Client.init/1`'s own `{:continue,
  # :connect}` deferral; together they keep boot O(1) per session
  # regardless of upstream reachability.
  @impl GenServer
  def init(opts) do
    :ok = Log.set_session_context(opts.subject_label, opts.network_slug)

    # Operator-deleted subject row → terminate cleanly so the
    # DynamicSupervisor stops the `:transient` respawn loop.
    # Stale-cached-opts (the zombie respawn class — 2026-05-27
    # Azzurra `kazamobile`/`kazam02` incident) → re-resolve the plan
    # from the DB so `state.nick` / `state.autojoin` / credentials
    # reflect live truth instead of the supervisor's frozen child
    # spec. Both failure modes share one closure: `refresh_plan`
    # returns `{:ok, plan}` (we merge it over the cached opts so DB
    # wins on shared keys) or `{:error, :not_found}` (`:ignore`
    # breaks the respawn loop — `:transient` treats init's `:ignore`
    # as normal termination, supervisor drops the child permanently).
    #
    # The closure is optional: test fixtures + the original Bootstrap
    # call site that doesn't supply it stay on the cached-opts path.
    # Production call sites (`Networks.SessionPlan.resolve/1` +
    # `Visitors.SessionPlan.resolve/1`) inject it.
    case Map.get(opts, :refresh_plan) do
      refresh when is_function(refresh, 0) ->
        case refresh.() do
          {:ok, fresh_plan} ->
            do_init(Map.merge(opts, fresh_plan))

          {:error, :not_found} ->
            Logger.info("session init: subject DB row gone — stopping cleanly to break respawn loop")

            :ignore
        end

      nil ->
        do_init(opts)
    end
  end

  defp do_init(opts) do
    # Trap exits so a `Client` crash arrives as `{:EXIT, client_pid,
    # reason}` in our mailbox instead of brutally killing this Session
    # via the link. Lets us record a Backoff failure BEFORE returning
    # `{:stop, _, _}` to the supervisor — without trap_exit the crash
    # would propagate through the link and the failure count would
    # never be incremented (the `:transient` respawn would then read
    # 0 ms wait, defeating the whole backoff).
    #
    # Safe because `Client.start_link/1` is the only linked spawn from
    # this process — see `start_link` block + `do_start_client/2`. The
    # supervisor's :shutdown EXIT is handled by GenServer's default
    # behaviour (it stops cleanly even under trap_exit).
    Process.flag(:trap_exit, true)

    state = %{
      subject: opts.subject,
      subject_label: opts.subject_label,
      network_id: opts.network_id,
      network_slug: opts.network_slug,
      nick: opts.nick,
      members: %{},
      # CP24 bucket E web/S8: tracks per-channel "366 RPL_ENDOFNAMES
      # observed at least once" so `list_members/3` can discriminate
      # `{:ok, :uninitialized}` (joined, no NAMES burst yet) from
      # `{:ok, []}` (joined, NAMES emitted empty list). MapSet of
      # channel name (case-sensitive — matches `state.members` key
      # casing). Wiped on self-PART of a channel + on self-JOIN
      # (reconnect path resets per-channel NAMES expectations
      # symmetrically with `state.members[channel]`).
      seeded_channels: MapSet.new(),
      topics: %{},
      channel_modes: %{},
      channels_created: %{},
      userhost_cache: %{},
      window_state: WindowState.new(),
      in_flight_joins: %{},
      # UX-4 bucket A — canonicalise the autojoin list at boot so the
      # 001 RPL_WELCOME loop sends `JOIN #chan` (canonical) regardless
      # of whether the operator typed `#Chan` in a mix task pre-
      # bucket-A or the credentials row was migrated post-bucket-A.
      # Symmetric with `Session.send_join/4`'s entry-point canonical
      # rebind. Sigil-aware: nick-shape entries (not valid here, but
      # the predicate is defensive) pass through unchanged.
      autojoin: Enum.map(opts.autojoin_channels, &Grappa.IRC.Identifier.canonical_channel/1),
      client: nil,
      notify_pid: Map.get(opts, :notify_pid),
      notify_ref: Map.get(opts, :notify_ref),
      pending_auth: nil,
      pending_auth_timer: nil,
      pending_password: pending_password_from_opts(opts),
      visitor_committer: Map.get(opts, :visitor_committer),
      visitor_nick_persister: Map.get(opts, :visitor_nick_persister),
      credential_failer: Map.get(opts, :credential_failer),
      last_joined_persister: Map.get(opts, :last_joined_persister),
      ghost_recovery: nil,
      ghost_timer: nil,
      away_state: AwayState.new(),
      auto_away_timer: nil,
      caps_active: MapSet.new(),
      labels_pending: %{},
      last_command_window: nil,
      modes_per_chunk: 3,
      linelen: 512,
      # C2 — pending WHOIS accumulators keyed by lowercased target nick.
      # Set up on `:send_whois` (the operator issued /whois); 311/312/313/
      # 317/319 fold into the entry; 318 emits `{:whois_bundle, ...}` and
      # drops it. Bounded by in-flight WHOIS commands (typically 0-1 at a
      # time). NOT persisted across crashes.
      whois_pending: %{},
      # CP22 cluster B — pending WHO accumulators keyed by lowercased
      # target channel. Set up on `:send_who`; 352 RPL_WHOREPLY rows fold
      # into the entry; 315 RPL_ENDOFWHO emits N+1 `{:persist, :notice,
      # attrs}` effects (one per reply + one EOF) and drops the entry.
      # Bounded by in-flight /who commands (typically 0-1 at a
      # time). NOT persisted across crashes.
      who_pending: %{},
      # P-0d — pending LUSERS accumulator. nil when idle; map populated
      # by EventRouter on 251/252/253/254/255/265/266 folds; flushed via
      # `{:lusers_bundle, accum}` on the next non-LUSERS numeric (implicit
      # end). Bounded by the fixed 7-numeric sequence Bahamut emits;
      # NOT persisted across crashes.
      lusers_pending: nil,
      # CP22 cluster B — pending NAMES accumulators keyed by lowercased
      # target channel. Set up on `:send_names`; 353 RPL_NAMREPLY rows
      # merge nick lists into the entry; 366 RPL_ENDOFNAMES drains via
      # 2 `{:persist, :notice, attrs}` effects (one row carrying the
      # full nick list + one EOF) when NOT joined to target — joined
      # targets defer to the existing members_seeded refresh path. NOT
      # persisted across crashes.
      names_pending: %{},
      # P-0c — pending WHOWAS accumulators keyed by lowercased target nick.
      # Set up on `:send_whowas`; 314 appends entries; 312 (gated) merges
      # logoff_time into the last entry; 369 emits :whowas_bundle and 406
      # emits a not_found bundle. Bounded by in-flight /whowas commands
      # (typically 0-1 at a time). NOT persisted across crashes.
      whowas_pending: %{}
    }

    # S3.1 / S3.2: subscribe to the WSPresence PubSub topic for this user so
    # auto-away debounce and cancel fire on WS connect/disconnect events.
    # Only user sessions (not visitor sessions) participate in auto-away;
    # visitor disconnect = bouncer disconnect (ephemeral credential).
    if match?({:user, _}, opts.subject) do
      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.ws_presence(opts.subject_label)
        )
    end

    emit_lifecycle(:spawned, state)

    {:ok, state, {:continue, {:start_client, client_opts(opts)}}}
  end

  # `Grappa.IRC.AuthFSM.step/2` already emits the wire `PRIVMSG NickServ
  # :IDENTIFY <pw>` on `{:numeric, 1}` for `auth_method:
  # :nickserv_identify` — that emission goes through `IRC.Client`'s
  # socket and bypasses `handle_call({:send_privmsg, _, _}, _, _)`, so
  # `NSInterceptor` never sees it. Server therefore must carry the
  # password forward in state and stage `pending_auth` at 001 itself
  # so the +r MODE observer (Task 15) finds it ready when NickServ
  # confirms. Anon visitors (`auth_method: :none`) and SASL/server-pass
  # users keep `pending_password = nil`.
  @spec pending_password_from_opts(init_opts()) :: String.t() | nil
  defp pending_password_from_opts(%{auth_method: :nickserv_identify, password: pw})
       when is_binary(pw),
       do: pw

  defp pending_password_from_opts(_), do: nil

  # Backoff layer: read the per-(subject, network_id) failure count via
  # `Grappa.Session.Backoff.wait_ms/2` and defer the actual Client spawn
  # by that many milliseconds. The count survives `:transient` restart
  # so a crash-respawn cycle (k-line bounce, repeat ECONNREFUSED, etc.)
  # waits exponentially longer between attempts. Fresh sessions read
  # 0 ms and start the Client immediately.
  #
  # The defer is non-blocking: `Process.send_after/3` schedules the
  # `:start_client_now` info, init/1 returns to the supervisor
  # immediately. Bootstrap's per-credential start_child loop stays O(1)
  # regardless of how deep into the backoff curve a particular session
  # is — pairs with the Client's own non-blocking `init/1`.
  @impl GenServer
  def handle_continue({:start_client, client_opts}, state) do
    case Backoff.wait_ms(state.subject, state.network_id) do
      0 ->
        do_start_client(client_opts, state)

      ms when is_integer(ms) and ms > 0 ->
        Logger.info("backoff delaying connect",
          delay_ms: ms,
          failure_count: Backoff.failure_count(state.subject, state.network_id)
        )

        Process.send_after(self(), {:start_client_after_backoff, client_opts}, ms)
        {:noreply, state}
    end
  end

  defp do_start_client(client_opts, state) do
    case Client.start_link(client_opts) do
      {:ok, client} ->
        {:noreply, %{state | client: client}}

      {:error, reason} ->
        # Inline start failure (Client.init/1 rejected the opts —
        # malformed AuthFSM state, etc.). Treat as a failure for
        # backoff purposes: respawn-cycle on this would be the same
        # hammer pattern as a connect-fail loop. The `:client_start_failed`
        # stop reason routes through terminate/2's abnormal-reason
        # clause which is the single record_failure funnel (H12, REV-D).
        {:stop, {:client_start_failed, reason}, state}
    end
  end

  # Clean shutdown — bouncer stopping (SIGTERM, `Application.stop`,
  # `scripts/deploy.sh` recreate). Send `QUIT :grappa shutting down`
  # upstream so peer IRC servers see a graceful disconnect ("vjt has
  # quit (grappa shutting down)") instead of a connection-drop
  # ("vjt has quit (Connection reset by peer)").
  #
  # Only fires for `:shutdown` / `{:shutdown, _}` reasons — that's the
  # supervisor-driven path. `:normal` is the operator-driven
  # `stop_session/2` path which already emits its own QUIT via the
  # `:send_quit` handle_call dance (see Networks.disconnect/2). Crash
  # reasons (any other term) skip the QUIT — the Client is in unknown
  # state, sending might block on a half-closed socket and stall the
  # supervisor's shutdown_timeout.
  #
  # `state.client` is `nil` in the brief window between init/1 and
  # handle_continue completing — silently skip in that case (no
  # connection exists yet to QUIT cleanly).
  #
  # try/catch wraps the GenServer.call: the linked Client may be dead
  # (test races), the socket may be already closed (`{:error, :closed}`
  # from transport_send raises a MatchError inside the Client's
  # handle_call), or the call may time out. Any of those is benign at
  # shutdown — peer just sees a connection drop instead of a graceful
  # QUIT, no worse than the pre-handler behavior. The shutdown still
  # completes in bounded time.
  #
  # HIGH-16 (no-silent-drops B6.8 2026-05-14): narrowed `catch :exit, _`
  # to the precise reasons the Client may legitimately exit during
  # graceful shutdown — `:noproc` (Client GenServer already dead),
  # `:timeout` (call exceeded the default 5s), `:normal | :shutdown |
  # {:shutdown, _}` (Client cleanly stopping concurrently). Any other
  # exit reason (e.g. `:killed`, an `{:exception, _}` shape) is a real
  # bug and must surface — pre-fix the wide `catch :exit, _` swallowed
  # crashes that would otherwise have been visible in supervisor logs.
  #
  # U-cluster cleanup (2026-05-17): the dead-socket SEND class
  # (`:gen_tcp.send(nil, _)` raising FunctionClauseError; `:ok =
  # transport_send` raising MatchError on `{:error, :closed}`) was
  # fixed at the IRC.Client boundary — `transport_send/2` now has a
  # nil-socket guard returning `{:error, :no_socket}`, and
  # `handle_call({:send, _}, _, _)` returns the tagged tuple instead
  # of `:ok =`-matching. `Client.send_quit/2` returns `{:error, _}`
  # cleanly on a dead socket; the `_ =` discard here absorbs it. The
  # pre-fix `:exit, {{%FunctionClauseError{}, _}, _}` catches were
  # dead code post-boundary-fix and removed per
  # `feedback_no_silent_drops_closed` (a safety net that catches an
  # impossible exception silently absorbs the next class of bug).
  @impl GenServer
  def terminate(reason, state)
      when reason == :shutdown or (is_tuple(reason) and elem(reason, 0) == :shutdown) do
    emit_lifecycle(:terminated, state)

    case state.client do
      nil ->
        :ok

      client when is_pid(client) ->
        try do
          _ = Client.send_quit(client, "grappa shutting down")
          :ok
        catch
          :exit, :noproc -> :ok
          :exit, :timeout -> :ok
          :exit, :normal -> :ok
          :exit, :shutdown -> :ok
          :exit, {:shutdown, _} -> :ok
          :exit, {:noproc, _} -> :ok
          :exit, {:timeout, _} -> :ok
        end
    end
  end

  def terminate(:normal, state) do
    emit_lifecycle(:terminated, state)
    :ok
  end

  # Abnormal teardown — every non-`:normal` / non-`:shutdown` reason
  # funnels here. Single source of truth for Backoff bookkeeping (H12,
  # REV-D): pre-fix `record_failure` was called from the linked-Client
  # EXIT clause + `do_start_client/2` only, so crash classes that
  # bypass those paths (callback raise inside `handle_info` /
  # `handle_call` / `handle_cast`, mailbox-overflow exit, an
  # `EXIT` from a non-Client linked process, …) skipped the bump.
  # The `:transient` supervisor respawned with no delay, defeating
  # the per-(subject, network_id) ladder exactly when it mattered
  # most (recurring server-internal bug → tight crash loop).
  #
  # `terminate/2` is best-effort per OTP — `:brutal_kill` and BEAM
  # shutdown skip it — but the supervisor's `:transient` policy here
  # uses the default `:shutdown` (5s graceful), so every crash class
  # we care about reaches this clause.
  def terminate(_, state) do
    emit_lifecycle(:terminated, state)
    :ok = Backoff.record_failure(state.subject, state.network_id)
    :ok
  end

  # U-5: lifecycle telemetry → AdminEvents synthesizes :cap_counts_changed.
  # Fires on EVERY init/1 success and EVERY terminate/2 invocation
  # (graceful shutdown, link-death from Client crash, supervisor stop).
  # Metadata-only emit — no DB read here (Server's no-DB contract per
  # cluster 2 A2). The AdminEvents handle_cast consults Admission +
  # Networks in its own process.
  #
  # `state` may be the initial map built in init/1 or any later mutated
  # variant; we touch only `subject` + `network_id` which are immutable
  # for the lifetime of this GenServer.
  #
  # ## Known stall window (S1 of U-5 review)
  #
  # `:spawned` fires near the END of init/1 (just before the
  # `{:continue, _}` return) — so if init/1 raises BEFORE the emit
  # (e.g. inside the Phoenix.PubSub.subscribe at line ~535), no
  # telemetry fires and the counter stays accurate. If init/1 raises
  # AFTER the emit but BEFORE handle_continue completes,
  # `:spawned` was broadcast but `terminate/2` does NOT run (OTP
  # contract: terminate only fires after init/1 returns successfully).
  # Result: the live counter latches +1 until the next genuine
  # lifecycle event on that network rebases it. The Networks tab
  # `onMount` refetch of `GET /admin/networks` re-baselines from the
  # Registry-canonical projection, so the staleness heals on the
  # next admin pane open. Accepted trade-off: emitting from a
  # `handle_continue(:emit_spawned, ...)` instead would close the
  # window but add a mailbox round-trip per spawn for a narrow case.
  @spec emit_lifecycle(:spawned | :terminated, %{
          :subject => Grappa.Session.subject(),
          :network_id => integer(),
          optional(any()) => any()
        }) :: :ok
  defp emit_lifecycle(lifecycle, %{subject: {kind, _}, network_id: nid})
       when lifecycle in [:spawned, :terminated] and kind in [:user, :visitor] and is_integer(nid) do
    :telemetry.execute(
      [:grappa, :session, :lifecycle, lifecycle],
      %{},
      %{network_id: nid, subject_kind: kind}
    )
  end

  # Persist-then-send is intentional Phase 1. Rationale: if the persist
  # fails (validation), we surface the changeset error to the caller
  # without ever touching the wire — clean rollback. If the persist
  # succeeds and the upstream send subsequently fails, the linked
  # Client crashes, kills this Session via the link, the
  # DynamicSupervisor (`:transient`) restarts a fresh Session — but
  # the row is already in scrollback so the sender's view is
  # consistent (they see what they typed). Reversing the order would
  # give worse UX: message visible to other users on the channel but
  # absent from the sender's own scrollback after refresh. Phase 5
  # reconnect/backoff inside Client may revisit this when send
  # gains an error return.
  @impl GenServer
  def handle_call({:send_privmsg, target, body}, _, state)
      when is_binary(target) and is_binary(body) do
    line = "PRIVMSG #{target} :#{body}"

    state =
      case NSInterceptor.intercept(line) do
        {:capture, password} -> stage_pending_auth(state, password)
        :passthrough -> state
      end

    if service_target?(target) do
      handle_service_target_send(target, body, state)
    else
      handle_persisting_send(target, body, state)
    end
  end

  # Sends `TOPIC <channel> :<body>` upstream. NO optimistic persist +
  # broadcast here — issue #22: the upstream IRC server echoes the TOPIC
  # back, EventRouter's unsolicited-TOPIC handler builds the canonical
  # :topic persist effect + :topic_changed broadcast. Persisting here
  # too duplicated the scrollback row + emitted a second topic_changed
  # event. UX trade-off accepted: topic visibly updates after one RTT.
  def handle_call({:send_topic, channel, body}, _, state)
      when is_binary(channel) and is_binary(body) do
    case Client.send_topic(state.client, channel, body) do
      :ok -> {:reply, :ok, state}
      {:error, _} = err -> {:reply, err, state}
    end
  end

  # Sends `NICK <new>` upstream. No scrollback row written here — the
  # upstream replays the NICK back; EventRouter's NICK handler then
  # reconciles `state.nick` (state.nick == old_nick path) and emits the
  # per-channel `:nick_change` persist effects. Nick validation lives at
  # the facade boundary (`Session.send_nick/3` calls
  # `Identifier.safe_line_token?/1` before this handler fires); the
  # `Client.send_nick/2` byte-boundary gate is the second line of
  # defense for malformed values that bypass the facade.
  def handle_call({:send_nick, new_nick}, _, state) when is_binary(new_nick) do
    case Client.send_nick(state.client, new_nick) do
      :ok -> {:reply, :ok, state}
      {:error, _} = err -> {:reply, err, state}
    end
  end

  # T32 (channel-client-polish S1.2): writes `QUIT :<reason>` upstream.
  # Synchronous so the caller (`Grappa.Networks.disconnect/2`) can follow
  # up with `Session.stop_session/2` knowing the QUIT line is on the
  # wire — otherwise the abrupt `:shutdown` would close the socket
  # before `Client.send_quit/2` got a chance to run.
  def handle_call({:send_quit, reason}, _, state) when is_binary(reason) do
    case Client.send_quit(state.client, reason) do
      :ok -> {:reply, :ok, state}
      {:error, _} = err -> {:reply, err, state}
    end
  end

  # Bundle C — /oper <name> <password> upstream. Password REDACTED from
  # any log line: this handler emits a STATIC message body (no string
  # interpolation of user input) and threads the operator name through
  # the already-allowlisted `:nick` Logger metadata key. Static message
  # body is load-bearing — if the operator inverts arg order and types
  # `/oper <password> <name>`, the password lands in the `name` slot;
  # an interpolated message would write that password to disk. The
  # Client.send_oper call wraps a private send_line which only logs
  # `reject_invalid_line/1` on the rejection path (which carries no
  # body), so the secret can't leak there either.
  def handle_call({:send_oper, name, password}, _, state)
      when is_binary(name) and is_binary(password) do
    Logger.info("OPER request submitted", verb: :oper, nick: name)

    case Client.send_oper(state.client, name, password) do
      :ok -> {:reply, :ok, state}
      {:error, _} = err -> {:reply, err, state}
    end
  end

  # Bundle C — /quote <raw IRC line> escape hatch. Whole line is
  # validated (no embedded CRLF/NUL) at the Client boundary then sent
  # verbatim. We log the byte size (not the body) to keep operator
  # observability without dumping arbitrary user input — operators
  # who need to debug the wire can use the existing IRC log stream.
  def handle_call({:send_raw, line}, _, state) when is_binary(line) do
    Logger.debug("raw IRC line submitted via /quote (#{byte_size(line)} bytes)",
      verb: :raw
    )

    case Client.send_raw(state.client, line) do
      :ok -> {:reply, :ok, state}
      {:error, _} = err -> {:reply, err, state}
    end
  end

  # ---------------------------------------------------------------------------
  # S5.2 — Channel-ops verb handlers
  # ---------------------------------------------------------------------------
  # All chunked verbs (/op /deop /voice /devoice /ban /unban) delegate to
  # ModeChunker.chunk/3 with state.modes_per_chunk (ISUPPORT MODES= value,
  # default 3). The chunker splits the param list into N-mode slices and
  # returns one {mode_str, params_slice} per chunk; we send each as a
  # separate MODE line. The mode letter is repeated once per param by the
  # chunker ("+ooo alice bob carol").
  #
  # The /mode raw verb is verbatim pass-through — NO chunking applies; the
  # caller is responsible for parameter count. This is the power-user
  # escape hatch and intentionally bypasses the MODES= limit guard.
  #
  # All verbs use handle_call (not handle_cast) so the caller can observe
  # the `:ok` reply and know the send path has been queued to the socket.

  def handle_call({:send_op, channel, nicks}, _, state)
      when is_binary(channel) and is_list(nicks) do
    send_chunked_mode(state, channel, "+o", nicks)
  end

  def handle_call({:send_deop, channel, nicks}, _, state)
      when is_binary(channel) and is_list(nicks) do
    send_chunked_mode(state, channel, "-o", nicks)
  end

  def handle_call({:send_voice, channel, nicks}, _, state)
      when is_binary(channel) and is_list(nicks) do
    send_chunked_mode(state, channel, "+v", nicks)
  end

  def handle_call({:send_devoice, channel, nicks}, _, state)
      when is_binary(channel) and is_list(nicks) do
    send_chunked_mode(state, channel, "-v", nicks)
  end

  def handle_call({:send_kick, channel, nick, reason}, _, state)
      when is_binary(channel) and is_binary(nick) and is_binary(reason) do
    {:reply, Client.send_kick(state.client, channel, nick, reason), state}
  end

  # :send_ban — derive ban mask from userhost_cache when the arg is a bare nick
  # (no `!` or `@`). Explicit mask passes through unchanged. Derivation:
  #   - Cache hit → `*!*@host` (host-ban, preferred over nick-ban for stickiness)
  #   - Cache miss → `nick!*@*` (nick-ban fallback; best-effort without WHOIS)
  def handle_call({:send_ban, channel, mask_or_nick}, _, state)
      when is_binary(channel) and is_binary(mask_or_nick) do
    mask = derive_ban_mask(mask_or_nick, state)
    send_chunked_mode(state, channel, "+b", [mask])
  end

  def handle_call({:send_unban, channel, mask}, _, state)
      when is_binary(channel) and is_binary(mask) do
    send_chunked_mode(state, channel, "-b", [mask])
  end

  # INVITE wire order: RFC 2812 §3.2.7 — `INVITE <nick> <channel>`.
  def handle_call({:send_invite, channel, nick}, _, state)
      when is_binary(channel) and is_binary(nick) do
    {:reply, Client.send_invite(state.client, channel, nick), state}
  end

  # P-0d — bare LUSERS upstream. Reply numerics fold into
  # state.lusers_pending; 266 RPL_GLOBALUSERS flushes the bundle.
  # No accumulator priming needed — 251 RPL_LUSERCLIENT resets the
  # accumulator on arrival.
  def handle_call(:send_lusers, _, state) do
    {:reply, Client.send_lusers(state.client), state}
  end

  # Banlist query form — no sign, just the mode letter.
  def handle_call({:send_banlist, channel}, _, state) when is_binary(channel) do
    {:reply, Client.send_banlist(state.client, channel), state}
  end

  # C2 — /whois <nick>. Two effects: (1) prime the accumulator entry in
  # state.whois_pending so EventRouter folds 311/312/313/317/319 into it;
  # (2) emit `WHOIS nick\r\n`. The entry's `target_display` is the user-
  # typed nick (case preserved); EventRouter normalises to lowercase for
  # the lookup key. Replaces any prior accumulator for the same target
  # (running /whois twice without an 318 in between drops the first).
  # On send_line failure the accumulator stays primed — a transient send
  # error doesn't strand the whois flow because no numerics will arrive
  # to drain it; harmless until the next /whois replaces the entry.
  def handle_call({:send_whois, target}, _, state) when is_binary(target) do
    nick_key = String.downcase(target)
    next_pending = Map.put(state.whois_pending, nick_key, %{target_display: target})
    next_state = %{state | whois_pending: next_pending}
    {:reply, Client.send_whois(state.client, target), next_state}
  end

  # P-0c — /whowas <nick>. Mirror of :send_whois shape. Two effects:
  # (1) prime the accumulator entry in state.whowas_pending so EventRouter
  # appends 314 RPL_WHOWASUSER entries + folds 312 logoff_time into the
  # last entry; (2) emit `WHOWAS nick\r\n`. The entry's `target_display`
  # is the user-typed nick (case preserved); EventRouter normalises to
  # lowercase for the lookup key. Replaces any prior accumulator for the
  # same target (running /whowas twice without a 369 in between drops
  # the first). On send_line failure the accumulator stays primed —
  # harmless until the next /whowas replaces the entry.
  def handle_call({:send_whowas, target}, _, state) when is_binary(target) do
    nick_key = String.downcase(target)

    next_pending =
      Map.put(state.whowas_pending, nick_key, %{target_display: target, entries: []})

    next_state = %{state | whowas_pending: next_pending}
    {:reply, Client.send_whowas(state.client, target), next_state}
  end

  # CP22 cluster B (channel-client-polish #14) — /who <#channel>. Two
  # effects: (1) prime the accumulator entry in state.who_pending so
  # EventRouter folds 352 RPL_WHOREPLY rows into it; (2) emit
  # `WHO #channel\r\n`. The entry's `target_display` matches `target`
  # — UX-4 bucket A canonicalises the channel arg at `Session.send_who/3`
  # so `target` here is already lowercase; the scrollback 315 EOF row
  # body (`*** End of /WHO list for #chan`) shows the canonical form.
  # Pre-bucket-A the docstring claimed "case preserved" — that was
  # the upstream-echoed case; now the canonical form is the single
  # form everywhere (members map, persist channel, EOF body).
  # Replaces any prior accumulator for the same target (running /who
  # twice without an 315 in between drops the first).
  # On send_line failure the accumulator stays primed — a transient
  # send error doesn't strand the WHO flow because no numerics will
  # arrive to drain it; harmless until the next /who replaces the entry.
  def handle_call({:send_who, target}, _, state) when is_binary(target) do
    chan_key = String.downcase(target)
    next_pending = Map.put(state.who_pending, chan_key, %{target_display: target, replies: []})
    next_state = %{state | who_pending: next_pending}
    {:reply, Client.send_who(state.client, target), next_state}
  end

  # CP22 cluster B (channel-client-polish #14) — /names <#channel>. Two
  # effects: (1) prime the accumulator entry in state.names_pending so
  # EventRouter folds 353 RPL_NAMREPLY rows into it; (2) emit
  # `NAMES #channel\r\n`. `target_display` matches `target` — UX-4 A
  # canonicalises at `Session.send_names/4` so the scrollback display
  # is canonical (see /who docstring above for the rationale).
  # Replaces any prior accumulator for the same target (running /names
  # twice without a 366 in between drops the first).
  # On send_line failure the accumulator stays primed — a transient
  # send error doesn't strand the NAMES flow because no numerics will
  # arrive to drain it; harmless until the next /names replaces the entry.
  #
  # /names UX cluster bucket N-1+N-2: `origin_window` (cic-side focused
  # window when the operator typed /names) is captured in the accumulator
  # so the 366 drain routes the 2 :notice rows to the originating window
  # rather than always landing in $server. nil falls back to legacy
  # routing (target if joined, $server otherwise).
  def handle_call({:send_names, target, origin_window}, _, state)
      when is_binary(target) and (is_nil(origin_window) or is_binary(origin_window)) do
    chan_key = String.downcase(target)

    next_pending =
      Map.put(state.names_pending, chan_key, %{
        target_display: target,
        names: [],
        origin_window: origin_window
      })

    next_state = %{state | names_pending: next_pending}
    {:reply, Client.send_names(state.client, target), next_state}
  end

  # User-mode change on own nick. Uses state.nick (reconciled at 001).
  def handle_call({:send_umode, modes}, _, state) when is_binary(modes) do
    {:reply, Client.send_umode(state.client, state.nick, modes), state}
  end

  # Raw verbatim MODE — no chunking. Target can be channel or nick.
  # The params list is joined with spaces.
  def handle_call({:send_mode, target, modes, params}, _, state)
      when is_binary(target) and is_binary(modes) and is_list(params) do
    line =
      case params do
        [] -> "MODE #{target} #{modes}\r\n"
        _ -> "MODE #{target} #{modes} #{Enum.join(params, " ")}\r\n"
      end

    {:reply, Client.send_line(state.client, line), state}
  end

  # S5.4: irssi-convention topic clear — sends `TOPIC #chan :` (empty trailing).
  # This clears the channel topic on servers that honour RFC 2812 §3.2.4:
  # an empty trailing parameter signals "no topic". The inbound TOPIC event
  # that the server echoes back will update the topic cache via EventRouter.
  def handle_call({:send_topic_clear, channel}, _, state) when is_binary(channel) do
    {:reply, Client.send_topic_clear(state.client, channel), state}
  end

  # Issues `AWAY :<reason>` upstream and records the timestamp + reason.
  # Safe_line_token guard lives on the facade (`Session.set_explicit_away/3`)
  # so injection-attempt vs no-session ordering is consistent.
  #
  # S4.3: the origin_window variant is the cicchetto-originated path where
  # GrappaChannel passes the window that issued the /away command. Updates
  # `last_command_window` so NumericRouter can correlate 305/306 replies.
  # S4.2: if labeled-response is active, generate + track a label for the
  # AWAY command so 305/306 echo it back.
  def handle_call({:set_explicit_away, reason, origin_window}, _, state)
      when is_binary(reason) do
    {label, next_state} = prepare_label(state, origin_window)
    final_state = set_explicit_away_internal(next_state, reason, label)
    {:reply, :ok, final_state}
  end

  def handle_call({:set_explicit_away, reason}, _, state) when is_binary(reason) do
    next_state = set_explicit_away_internal(state, reason, nil)
    {:reply, :ok, next_state}
  end

  # S3.2: explicit away unset — user issued bare `/away`. Only honours the
  # call when currently `:away_explicit`; any other state is a no-op that
  # returns `{:error, :not_explicit}` so callers can surface "you weren't
  # away explicitly" feedback to the user.
  #
  # S4.3: the origin_window variant updates last_command_window.
  def handle_call({:unset_explicit_away, origin_window}, _, %{away_state: %AwayState{state: :away_explicit}} = state) do
    {label, next_state} = prepare_label(state, origin_window)
    final_state = unset_away_internal(next_state, label)
    {:reply, :ok, final_state}
  end

  def handle_call({:unset_explicit_away, origin_window}, _, state) do
    # Not currently away_explicit — no-op, but still update last_command_window.
    {_, next_state} = prepare_label(state, origin_window)
    {:reply, {:error, :not_explicit}, next_state}
  end

  def handle_call({:unset_explicit_away}, _, %{away_state: %AwayState{state: :away_explicit}} = state) do
    next_state = unset_away_internal(state, nil)
    {:reply, :ok, next_state}
  end

  def handle_call({:unset_explicit_away}, _, state) do
    {:reply, {:error, :not_explicit}, state}
  end

  # S3.2: auto-away set — driven by the WSPresence debounce. No-op when
  # `:away_explicit` (explicit takes precedence). Otherwise issues `AWAY
  # :<AwayState.auto_away_reason()>` upstream and transitions to `:away_auto`.
  def handle_call({:set_auto_away}, _, %{away_state: %AwayState{state: :away_explicit}} = state) do
    # Explicit takes precedence — ignore the auto signal entirely.
    {:reply, :ok, state}
  end

  def handle_call({:set_auto_away}, _, state) do
    next_state = set_auto_away_internal(state)
    {:reply, :ok, next_state}
  end

  # S3.2: auto-away unset — driven by the WSPresence reconnect event. No-op
  # when `:away_explicit` (don't clear an explicit away on reconnect) or
  # `:present` (nothing to do). Only acts on `:away_auto`.
  def handle_call({:unset_auto_away}, _, %{away_state: %AwayState{state: :away_auto}} = state) do
    next_state = unset_away_internal(state, nil)
    {:reply, :ok, next_state}
  end

  def handle_call({:unset_auto_away}, _, state) do
    # :away_explicit or :present — no-op.
    {:reply, :ok, state}
  end

  # Returns the live IRC nick for this session — the nick that was
  # actually registered with the upstream server (which may differ from
  # the credential's configured nick after NickServ ghost recovery,
  # nick collision suffixing, or an explicit /nick change). Public via
  # `Grappa.Session.current_nick/2`.
  def handle_call({:current_nick}, _, state) do
    {:reply, {:ok, state.nick}, state}
  end

  # Returns a snapshot of currently-joined channels
  # (`Map.keys(state.members)`) sorted alphabetically. Public via
  # `Grappa.Session.list_channels/2`. The "currently-joined" invariant
  # is preserved by EventRouter's self-JOIN wipe + self-PART/KICK
  # delete (Q1 of P4-1 cluster).
  def handle_call({:list_channels}, _, state) do
    channels = state.members |> Map.keys() |> Enum.sort()
    {:reply, {:ok, channels}, state}
  end

  @doc """
  Returns a snapshot of `state.members[channel]` in mIRC sort order
  (`@` ops alphabetical → `+` voiced alphabetical → plain alphabetical).
  Each entry: `%{nick: String.t(), modes: [String.t()]}`. Public via
  `Grappa.Session.list_members/3`.

  CP24 bucket E web/S8: returns `{:ok, :uninitialized}` if the
  channel has not yet observed a 366 RPL_ENDOFNAMES (joined but
  pre-NAMES, OR not joined at all). Returns `{:ok, [member()]}` —
  possibly empty — once NAMES has completed at least once. The
  REST `/members` controller maps `:uninitialized` to HTTP 204
  (cic shows "loading…") and the empty list to HTTP 200 + `{members:
  []}` (cic shows "no members"). Channel cold-snapshot
  (`push_members_if_seeded/4`) skips on `:uninitialized` so cic's
  WS surface stays consistent with REST.
  """
  def handle_call({:list_members, channel}, _, state) when is_binary(channel) do
    if MapSet.member?(state.seeded_channels, channel) do
      members =
        state.members
        |> Map.get(channel, %{})
        |> Enum.map(fn {nick, modes} -> %{nick: nick, modes: modes} end)
        |> Enum.sort_by(&{member_sort_tier(&1.modes), &1.nick})

      {:reply, {:ok, members}, state}
    else
      {:reply, {:ok, :uninitialized}, state}
    end
  end

  # Returns a snapshot of the topic cache for `channel`. Serves from cache —
  # no upstream query. Public via `Grappa.Session.get_topic/3`.
  def handle_call({:get_topic, channel}, _, state) when is_binary(channel) do
    chan_key = String.downcase(channel)

    case Map.get(state.topics, chan_key) do
      nil -> {:reply, {:error, :no_topic}, state}
      entry -> {:reply, {:ok, entry}, state}
    end
  end

  # Returns a snapshot of the channel_modes cache for `channel`. Serves from
  # cache — no upstream query. Public via `Grappa.Session.get_channel_modes/3`.
  def handle_call({:get_channel_modes, channel}, _, state) when is_binary(channel) do
    chan_key = String.downcase(channel)

    case Map.get(state.channel_modes, chan_key) do
      nil -> {:reply, {:error, :no_modes}, state}
      entry -> {:reply, {:ok, entry}, state}
    end
  end

  # CP15 B3 + cluster #6: returns the snapshot-ready window-state
  # payload for `channel`. Single source of truth for the snapshot
  # projection lives on `WindowState.to_wire/3` — same Wire verbs the
  # apply_effects arms use at event-time, so snapshot + event are
  # LITERALLY the same expression.
  #
  # Returns `{:error, :not_tracked}` for absent / `:pending` / `:parked`
  # channels (cic learned `:pending` via the user-topic dispatch; cic
  # doesn't yet render `:parked`). Returns `{:ok, payload}` for the
  # three terminal states cic mirrors on the per-channel topic.
  def handle_call({:get_window_state, channel}, _, state) when is_binary(channel) do
    {:reply, WindowState.to_wire(state.window_state, state.network_slug, channel), state}
  end

  # Returns the userhost cache entry for `nick`. Nick lookup is case-insensitive
  # (RFC 2812 §2.2) — normalise to downcase at read time, mirroring write-time
  # normalisation in EventRouter. Returns {:ok, entry} or {:error, :not_cached}.
  # Public via `Grappa.Session.lookup_userhost/3`.
  #
  # This cache is NOT broadcast over PubSub — it is consumed internally by
  # S5's /ban mask derivation (Session.lookup_userhost/3 is the single
  # access path). A future reader should not add a broadcast "for consistency"
  # — the data goes stale fast (users change hosts) and the cache is an
  # optimistic performance hint, not a source of truth. Only the IRC upstream
  # is authoritative; WHOIS is the fallback when the cache misses.
  def handle_call({:lookup_userhost, nick}, _, state) when is_binary(nick) do
    nick_key = String.downcase(nick)

    case Map.get(state.userhost_cache, nick_key) do
      nil -> {:reply, {:error, :not_cached}, state}
      entry -> {:reply, {:ok, entry}, state}
    end
  end

  @impl GenServer
  def handle_call({:send_join, channel, key}, _, state)
      when is_binary(channel) and (is_nil(key) or is_binary(key)) do
    # Code-review CRIT-1 (bucket C): post-irc/S2 `Client.send_join`
    # returns `{:error, :invalid_line}` for malformed channels. The
    # `Session.send_join/4` facade gates `valid_channel?` before the
    # call (CRIT-1 fix), so reaching this clause with a malformed
    # channel requires a caller bypassing the facade. Defensive
    # `{:error, :invalid_line}` arm mirrors the autojoin loop pattern
    # at handle_info({:irc, %Message{command: {:numeric, 1}}}, …) so
    # a future bypass-caller logs + drops instead of MatchError-crashing
    # the Session.
    #
    # PHASE-1 (post-cr-review cluster): converted from cast to call so
    # the `window_pending` broadcast inside `record_in_flight_join/2`
    # fires BEFORE the REST controller returns 202. Pre-conversion the
    # cast sat in the Session.Server mailbox under CI load, delaying
    # the broadcast by >5s and making cp15-b6-kicked time out at the
    # sidebar-row assertion. See `Session.send_join/4` doc for the full
    # rationale. Reply `:ok` AFTER `record_in_flight_join` so the
    # caller's wall clock includes the broadcast.
    #
    # UX-4 bucket F: `key` is the optional +k channel key (nil for
    # keyless channels). Client.send_join/3 emits the wire frame in
    # the keyed or keyless shape based on key.
    case Client.send_join(state.client, channel, key) do
      :ok ->
        {:reply, :ok, record_in_flight_join(state, channel)}

      {:error, :invalid_line} = err ->
        Logger.warning("send_join call rejected: invalid channel name", channel: inspect(channel))
        {:reply, err, state}

      # Transport-level failure: client has no live socket (upstream
      # TLS handshake failed, k-line tore down the connection, Session
      # is in backoff between reconnect attempts, etc.). Surface as
      # `{:error, :not_connected}` so FallbackController emits a clean
      # 400 with the existing `not_connected` wire body instead of
      # bubbling a CaseClauseError that 500s the cic /join request.
      # Don't crash the Session — it's mid-reconnect and the next
      # backoff tick will retry the socket.
      {:error, reason} ->
        Logger.warning("send_join call rejected: transport unavailable",
          channel: inspect(channel),
          reason: inspect(reason)
        )

        {:reply, {:error, :not_connected}, state}
    end
  end

  @impl GenServer
  def handle_cast({:send_part, channel}, state) when is_binary(channel) do
    # UX-4 bucket H — eager local-state cleanup regardless of upstream
    # PART outcome. Pre-fix the operator's window stayed in the sidebar
    # forever if upstream rejected PART (442 ERR_NOTONCHANNEL on PART
    # against a chan we never joined; 403 ERR_NOSUCHCHANNEL on a
    # never-existed chan). No PART echo → EventRouter never runs its
    # cleanup → state.members keeps the (possibly absent) key → no
    # channels_changed broadcast → cic's channelsBySlug refetch never
    # fires → sidebar entry persists.
    #
    # Per the plan ("server best-effort sends PART but doesn't gate
    # window close") we now drop the per-channel local state right at
    # the cast handler. `PartCleanup.cleanup_local/2` is the single
    # source — same helper EventRouter's PART-echo self-arm calls when
    # upstream DOES echo PART successfully. Idempotent in both
    # directions: eager wipe of an unknown channel is a no-op except
    # for the channels_changed broadcast we always fire (it forces cic
    # to refetch GET /channels, which already won't include the
    # channel since the controller removed it from autojoin); upstream
    # PART echo arriving after our eager wipe sees the channel already
    # absent and runs the same cleanup harmlessly.
    #
    # Race trade: if upstream really keeps us in the channel (unusual —
    # PART is best-effort wire-level, the RFC doesn't permit servers
    # to refuse a member's PART), future PRIVMSGs on the channel would
    # land at scrollback channel=#ch with no state.members entry. cic
    # would render them on the (now-absent) window and the operator
    # would see a "ghost" channel resurface. Plan accepts this trade —
    # the race is theoretical (PART is wire-fast, ms-scale) and the
    # alternative is the persistent-ghost bug this bucket closes.
    state = PartCleanup.cleanup_local(state, channel)
    broadcast_channels_changed(state)

    case Client.send_part(state.client, channel) do
      :ok ->
        {:noreply, state}

      {:error, :invalid_line} ->
        Logger.warning("send_part cast rejected: invalid channel name", channel: inspect(channel))
        {:noreply, state}

      # Transport-level failure (no socket, closed, etc.). Local
      # cleanup already ran above (PartCleanup.cleanup_local +
      # broadcast_channels_changed); the upstream PART wire frame is
      # the best-effort echo that doesn't gate the operator's intent.
      # Log + swallow so a mid-reconnect /part doesn't crash the
      # Session.Server (it would respawn cleanly but the cast caller
      # has no way to surface a tagged error anyway).
      {:error, reason} ->
        Logger.warning("send_part cast rejected: transport unavailable",
          channel: inspect(channel),
          reason: inspect(reason)
        )

        {:noreply, state}
    end
  end

  # Deferred Client.start_link/1 from `handle_continue({:start_client, _}, _)`'s
  # backoff branch. Pairs with the Backoff lookup at start: when the
  # delay timer fires, do the actual start. Same `do_start_client/2`
  # path so the `:client_start_failed` shape is identical.
  @impl GenServer
  def handle_info({:start_client_after_backoff, client_opts}, state) do
    do_start_client(client_opts, state)
  end

  # U-2 (UD7): IRC.Client signals `:irc_connected` when TCP/TLS handshake
  # succeeded and NICK/USER were sent — the "connect phase" boundary.
  # Re-fire it as `{:session_phase, ref, :connected}` toward `notify_pid`
  # so `Visitors.Login.wait_for_ready/5` can distinguish a TCP-blackhole
  # `:connect_timeout` from a rDNS-blocked `:welcome_timeout`. Does NOT
  # clear the notify slot — that happens at 001 via `maybe_fire_notify/1`
  # (the `:welcomed` phase + outer `:session_ready` contract).
  def handle_info(:irc_connected, %{notify_pid: pid, notify_ref: ref} = state)
      when is_pid(pid) and is_reference(ref) do
    send(pid, {:session_phase, ref, :connected})
    {:noreply, state}
  end

  def handle_info(:irc_connected, state), do: {:noreply, state}

  # S3.2 — WS reconnect: a new browser tab opened for this user. Cancel
  # any pending auto-away debounce timer and (if currently :away_auto)
  # unset auto-away. Explicit away is left untouched — reconnecting a tab
  # should not silently clear a `/away` the user issued deliberately.
  def handle_info({:ws_connected, _}, state) do
    :ok = cancel_and_drain(state.auto_away_timer, :auto_away_debounce_fire)
    state1 = %{state | auto_away_timer: nil}

    state2 =
      if AwayState.state_of(state1.away_state) == :away_auto do
        unset_away_internal(state1, nil)
      else
        state1
      end

    {:noreply, state2}
  end

  # S3.2 — WS disconnect: the last browser tab for this user closed.
  # Schedule the 30s debounce before issuing auto-away. If already
  # `:away_explicit`, skip entirely — the user intentionally went away.
  def handle_info({:ws_all_disconnected, _}, %{away_state: %AwayState{state: :away_explicit}} = state) do
    {:noreply, state}
  end

  def handle_info({:ws_all_disconnected, _}, state) do
    # Cancel any existing debounce timer + drain a possibly-already-fired
    # :auto_away_debounce_fire from the mailbox. Two rapid disconnects
    # ~30s apart used to leave the OLD timer's fire queued ahead of the
    # second handler, which then ran set_auto_away_internal at T=30s
    # instead of T=60s — and the second timer would later fire again,
    # producing a duplicate upstream AWAY + an away_started_at jump that
    # broke maybe_broadcast_mentions_bundle's window-boundary aggregation
    # (lifecycle review HIGH S3).
    :ok = cancel_and_drain(state.auto_away_timer, :auto_away_debounce_fire)

    timer = Process.send_after(self(), :auto_away_debounce_fire, @auto_away_debounce_ms)
    {:noreply, %{state | auto_away_timer: timer}}
  end

  # S3.2 — Auto-away debounce fired. If still `:away_explicit`, skip (user
  # may have issued `/away` in the window between disconnect and fire).
  # Otherwise issue the upstream AWAY and transition to `:away_auto`.
  def handle_info(:auto_away_debounce_fire, %{away_state: %AwayState{state: :away_explicit}} = state) do
    {:noreply, %{state | auto_away_timer: nil}}
  end

  def handle_info(:auto_away_debounce_fire, state) do
    next_state = set_auto_away_internal(%{state | auto_away_timer: nil})
    {:noreply, next_state}
  end

  # Linked Client crashed abnormally. Record a backoff failure (so the
  # next respawn waits longer) then propagate the stop. The Backoff call
  # is synchronous (HIGH-15 cast→call flip): the dying Server's
  # handle_info returns `{:stop, ...}` only after Backoff has flushed
  # the bumped count to ETS. SessionSupervisor's restart waits on the
  # previous child fully exiting, so by the time the new `init/1`
  # reads `wait_ms/2` the bumped count is visible. Pre-flip the cast
  # raced the supervisor's restart and the new init read the OLD count.
  #
  # Reason guard excludes :normal / :shutdown — those are clean teardown
  # paths (operator-initiated park via T32 disconnect, supervisor-driven
  # shutdown, future Client.stop/1 for planned teardown). A clean exit
  # bumping the backoff counter would gate the next /connect for the
  # full backoff window — false-failure backoff (lifecycle review HIGH
  # S2). Clean exits fall through to the next clause for plain
  # propagation without Backoff bookkeeping.
  def handle_info({:EXIT, client_pid, reason}, %{client: client_pid} = state)
      when client_pid != nil and reason != :normal and reason != :shutdown do
    # Backoff bookkeeping runs in terminate/2's abnormal-reason clause
    # (H12, REV-D) so every crash class — not just linked-Client EXIT —
    # advances the failure counter. The `:client_exit` reason wrapper
    # is preserved for supervisor-log fidelity (distinguishes upstream
    # disconnect from a Session-internal crash).
    {:stop, {:client_exit, reason}, %{state | client: nil}}
  end

  # Clean linked-Client exit (operator stop / planned teardown / supervisor
  # shutdown) — propagate as `:normal` so the `:transient` supervisor does
  # NOT auto-restart this Session. Bucket H lifecycle/S3 fix: pre-fix this
  # wrapped `:normal/:shutdown` into `{:client_exit, _}` which the
  # supervisor classifies as ABNORMAL (anything other than
  # `:normal | :shutdown | {:shutdown, _}`), so the Session would have
  # been silently re-spawned by the supervisor — directly contradicting
  # CLAUDE.md "Restart strategy: :transient … don't restart on :normal
  # shutdown" and the "Bootstrap won't respawn unless asked via T32
  # unpark" intent of the comment itself. Today the clause is unreachable
  # in production (Client has no self-stop path; supervisor :shutdown of
  # the parent bypasses via terminate/2), but the structural bug needed
  # closing before a future caller introducing `Client.stop/1` trips
  # the silent restart.
  def handle_info({:EXIT, client_pid, reason}, %{client: client_pid} = state)
      when client_pid != nil and (reason == :normal or reason == :shutdown) do
    {:stop, :normal, %{state | client: nil}}
  end

  # OTP convention: a trap_exit GenServer that receives a clean
  # `:shutdown` / `:normal` signal stops with the same reason. Two
  # real callers reach this clause:
  #   * external `Process.exit(pid, :shutdown)` — e.g. the test-helper
  #     orphan sweep in `Grappa.Test.AdmissionStateHelpers` (and any
  #     future supervisor-style external teardown).
  #   * a future linked sibling process (Task / async probe) exiting
  #     cleanly — Client is the only `Process.link/1` site in `init/1`
  #     today, so the only production sender today is `Process.exit/2`
  #     from outside.
  #
  # REV-J M7 added a raise here to surface design violations where a
  # caller introduced `Process.link/1` outside of `init/1` and the
  # linked process exited cleanly. The intent — "Client is the only
  # linked process" — is right; the implementation conflated two
  # distinct OTP signal classes. `{:EXIT, sender, reason}` carries no
  # marker for `Process.exit/2` vs. an actual linked-process exit:
  # both arrive as the same mailbox tuple. The raise made every
  # external `Process.exit(pid, :shutdown)` a false-positive crash
  # (test-helper teardown → orphan crash → supervisor respawn race
  # → `reset_session_supervisor` 15s timeout — the failure mode that
  # tripped CI run 26371004010).
  #
  # The OTP-convention stop honours the external-signal case AND, for
  # the future linked-sibling case, propagates the linked process's
  # clean exit reason cleanly through the supervisor: `:shutdown` and
  # `:normal` are non-restart reasons for `:transient` children, so
  # the Session is NOT respawned spuriously. New `Process.link/1`
  # sites within this module MUST add an explicit
  # `{:EXIT, linked_pid, ...}` clause BEFORE this catch-all if they
  # need bespoke handling (the earlier client-bound clauses at the
  # top of this block are the template).
  def handle_info({:EXIT, _, reason}, state)
      when reason == :shutdown or reason == :normal do
    {:stop, reason, %{state | client: nil}}
  end

  def handle_info({:irc, %Message{command: :ping, params: [token | _]}}, state) do
    # send_pong/2 returns {:error, :invalid_line} on empty/unsafe token
    # (S9). The parser strips CRLF/NUL at the byte boundary so a normal
    # PING produces a safe token here; a malformed `PING :` (empty
    # trailing) is the only realistic miss and we drop it on the floor
    # rather than emit `PONG :\r\n` — pinging clients re-issue PINGs on
    # liveness loss, so a single dropped reply is not load-bearing.
    case Client.send_pong(state.client, token) do
      :ok ->
        :ok

      {:error, :invalid_line} ->
        Logger.warning("upstream PING token rejected by send_pong guard",
          reason: :invalid_line,
          raw: inspect(token)
        )
    end

    {:noreply, state}
  end

  # 001 RPL_WELCOME: autojoin BEFORE delegating to EventRouter. Autojoin
  # reads `state.autojoin` and writes via `state.client` — both are
  # transport-side concerns the pure router doesn't carry. Nick
  # reconciliation (state.nick = welcomed_nick) lives in EventRouter.
  #
  # Task 8 — `maybe_fire_notify/1` is the single source of truth for
  # "we just got 001." When `notify_pid` + `notify_ref` were threaded
  # through `start_opts` (the synchronous `Visitors.Login` probe-connect
  # path, W5), send `{:session_ready, ref}` to the waiter and clear
  # the notify fields. One-shot — a future reconnect-001 will not
  # re-fire to a long-dead login probe.
  def handle_info(
        {:irc, %Message{command: {:numeric, 1}, params: [welcomed_nick | _]} = msg},
        state
      )
      when is_binary(welcomed_nick) do
    state =
      state.autojoin
      |> Enum.reduce(state, fn channel, acc ->
        # Autojoin channels are operator-configured (or persisted from
        # last_joined_channels at reboot). Keys are NOT persisted —
        # operator must re-join with /join #chan key for +k channels.
        # UX-4 bucket F: explicit nil here keeps the autojoin wire
        # frame shape stable (`JOIN #chan\r\n` only).
        case Client.send_join(acc.client, channel, nil) do
          :ok ->
            record_in_flight_join(acc, channel)

          {:error, :invalid_line} ->
            Logger.warning("autojoin skipped: invalid channel name", channel: inspect(channel))
            acc

          # Transport gone between RPL_WELCOME and this iteration of
          # the autojoin reduce — extremely rare (we just received a
          # 001 numeric ON this socket) but possible if upstream tore
          # the connection down between the 001 reply and the autojoin
          # loop tick. Skip + log; next reconnect's RPL_WELCOME will
          # re-fire the autojoin loop from scratch.
          {:error, reason} ->
            Logger.warning("autojoin skipped: transport unavailable",
              channel: inspect(channel),
              reason: inspect(reason)
            )

            acc
        end
      end)
      |> maybe_fire_notify()
      |> maybe_stage_pending_password()

    if welcomed_nick != state.nick do
      Logger.info("nick reconciled at registration",
        from: state.nick,
        to: welcomed_nick
      )
    end

    # Backoff success: 001 RPL_WELCOME proves upstream accepted us. Any
    # prior failure history is stale — clear the entry so the next
    # failure starts the exponential ladder at count=1 again instead of
    # whatever depth the previous outage reached.
    Backoff.record_success(state.subject, state.network_id)

    delegate(msg, state)
  end

  # Cleared 10s after the last NSInterceptor capture if no +r MODE
  # confirmation arrived (Task 15 lands the +r observer + atomic commit).
  # Wrong passwords never reach the visitor DB by virtue of this clear.
  def handle_info(:pending_auth_timeout, state) do
    Logger.debug("pending_auth discarded — +r MODE timeout")
    {:noreply, %{state | pending_auth: nil, pending_auth_timer: nil}}
  end

  # Task 18 — visitor 433 with cached NickServ password starts ghost
  # recovery. AuthFSM's `:nickserv_identify`-specific 432/433 :cont
  # clause keeps the connection alive long enough for this handler to
  # drive the underscore-NICK + GHOST + WHOIS + IDENTIFY flow. The
  # `pending_password` discriminator is stricter than the subject —
  # mode-1 sessions and anon visitors both have nil here so they fall
  # through to the catch-all and AuthFSM's :nick_rejected stop (mode-1)
  # OR a benign no-op delegate (anon visitor — AuthFSM stops Client and
  # the supervisor restarts).
  def handle_info(
        {:irc, %Message{command: {:numeric, 433}} = msg},
        %{pending_password: pwd, ghost_recovery: nil} = state
      )
      when is_binary(pwd) do
    fsm = GhostRecovery.init(state.nick, pwd)

    case GhostRecovery.step(fsm, msg) do
      {:cont, next, lines} ->
        state = flush_lines(state, lines)
        timer = Process.send_after(self(), :ghost_timeout, @ghost_recovery_timeout_ms)
        {:noreply, %{state | ghost_recovery: next, ghost_timer: timer}}

      {:stop, _, lines} ->
        state = flush_lines(state, lines)
        {:noreply, state}
    end
  end

  # NickServ NOTICE while ghost recovery is armed — feed into the FSM.
  # GhostRecovery's own clauses guard against non-NickServ sources and
  # off-phase notices, so any benign NOTICE that doesn't belong to the
  # ghost flow is a no-op there.
  def handle_info(
        {:irc, %Message{command: :notice} = msg},
        %{ghost_recovery: %GhostRecovery{}} = state
      ) do
    advance_ghost(state, msg)
  end

  # 401 / 311 while ghost recovery is armed — feed into the FSM.
  def handle_info(
        {:irc, %Message{command: {:numeric, code}} = msg},
        %{ghost_recovery: %GhostRecovery{}} = state
      )
      when code in [401, 311] do
    advance_ghost(state, msg)
  end

  def handle_info(:ghost_timeout, %{ghost_recovery: %GhostRecovery{} = gr} = state) do
    {_, _, lines} = GhostRecovery.step(gr, :timeout)
    state = flush_lines(state, lines)
    {:noreply, %{state | ghost_recovery: nil, ghost_timer: nil}}
  end

  def handle_info(:ghost_timeout, state), do: {:noreply, state}

  # 465 ERR_YOUREBANNEDCREEP — k-line / g-line. Hard, terminal,
  # non-recoverable: the upstream network operator has explicitly banned
  # this host/mask. No amount of reconnect will help — the ban must be
  # lifted by a network admin. Transition credential to :failed so
  # Bootstrap skips this session on the next deploy and cicchetto can
  # surface a visible reason badge.
  #
  # The trailing param (upstream's human-readable ban reason) is captured
  # verbatim so operators can diagnose which rule matched (e.g. "You are
  # k-lined" vs a DNSBL reason). The "k-line: " prefix is added for
  # disambiguation in the DB reason column.
  def handle_info(
        {:irc, %Message{command: {:numeric, 465}, params: params}},
        state
      ) do
    trailing = List.last(params) || "k-line"
    reason = "k-line: #{trailing}"

    Logger.error(
      "k-line received — session marked :failed (network_id=#{state.network_id})",
      reason: reason
    )

    handle_terminal_failure(reason, state)
  end

  # 904 ERR_SASLFAIL — SASL authentication numeric. The trailing text
  # discriminates permanent failures (wrong credentials → mark :failed)
  # from transient ones (timeout / abort / network hiccup → continue
  # backoff). Decision C (locked): transient 904 stays in continuous
  # reconnect; only permanent failures escalate to :failed.
  #
  # Classifier: see `sasl_terminal?/1` for the exact matching rules.
  def handle_info(
        {:irc, %Message{command: {:numeric, 904}, params: params}},
        state
      ) do
    trailing = List.last(params) || ""

    if sasl_terminal?(trailing) do
      reason = "sasl: #{trailing}"

      Logger.error(
        "permanent SASL failure — session marked :failed " <>
          "(network_id=#{state.network_id} trailing=#{inspect(trailing)})"
      )

      handle_terminal_failure(reason, state)
    else
      Logger.warning(
        "transient SASL failure — staying in backoff " <>
          "(network_id=#{state.network_id} trailing=#{inspect(trailing)})"
      )

      {:noreply, state}
    end
  end

  # S4.2 — CAP ACK: detect labeled-response being granted by the upstream.
  # IRC.Client dispatches ALL parsed messages to Session.Server (including
  # CAP messages that AuthFSM also processes). This handler fires for any
  # CAP ACK that contains "labeled-response" in the ACK'd caps list. It
  # is not phase-guarded — a stray post-registration CAP ACK from a CAP
  # NEW or similar extension is benign here (we just add the cap name to
  # caps_active, which is a no-op if it's already there or useless if
  # the session never issues labeled commands).
  def handle_info(
        {:irc, %Message{command: :cap, params: [_, "ACK", caps_blob | _]}},
        state
      )
      when is_binary(caps_blob) do
    acked = caps_blob |> String.split(" ", trim: true) |> Enum.map(&String.trim/1)

    caps_active =
      if "labeled-response" in acked do
        MapSet.put(state.caps_active, "labeled-response")
      else
        state.caps_active
      end

    {:noreply, %{state | caps_active: caps_active}}
  end

  # S5.1 — 005 RPL_ISUPPORT: extract MODES=N + LINELEN=N if advertised.
  # Params are space-separated ISUPPORT tokens (e.g. ["grappa-test",
  # "MODES=4", "LINELEN=512", "CHANTYPES=#", "are supported ..."]).  We
  # scan every param for the known prefixes. Defaults (3 modes,
  # 512-byte linelen) are preserved when the token is absent. Only the
  # first occurrence of each token is honoured (ircd should emit at
  # most one per 005 line; idempotent values — use the first advertised
  # and ignore later ones to avoid a misbehaving server downgrading us
  # mid-session).
  def handle_info(
        {:irc, %Message{command: {:numeric, 5}} = msg},
        state
      ) do
    modes_per_chunk = extract_modes_isupport(msg.params, state.modes_per_chunk)
    linelen = extract_linelen_isupport(msg.params, state.linelen)
    {:noreply, %{state | modes_per_chunk: modes_per_chunk, linelen: linelen}}
  end

  # CP13 server-window cluster: numeric routing produces a persisted
  # `:notice` row carrying the human-readable trailing text + meta
  # `%{numeric: code, severity: :ok | :error}`. Pre-CP13 this path
  # broadcast a `numeric_routed` event over the user topic + an
  # ephemeral cicchetto-side store; the new shape uses the same
  # `:persist` effect every other scrollback writer uses, so numerics
  # appear inline in the routed window's scrollback (queryable via
  # REST, replayable on reconnect, indexed by (network, channel,
  # server_time) like everything else).
  #
  # Routing decisions from NumericRouter map to the `channel` field
  # of the persisted row:
  #   `{:server, nil}` → `"$server"` (synthetic window)
  #   `{:channel, c}`  → `c`
  #   `{:query, n}`    → `n` (query window for nick `n`)
  #   `:delegated`     → bypass; existing handlers own the numeric.
  #
  # The `labels_pending` entry for the matched label (if any) is
  # consumed here (removed from state) so the map stays bounded.
  # `last_command_window` is NOT updated here — it's a command-send-
  # time snapshot, not a numeric-arrival-time one.
  def handle_info({:irc, %Message{command: {:numeric, _}} = msg}, state) do
    router_state = build_router_state(state)

    case NumericRouter.route(msg, router_state) do
      :delegated ->
        # Delegated: existing handlers own this numeric via EventRouter.
        delegate(msg, state)

      routing ->
        # Consume label if matched (keeps labels_pending bounded).
        label = Message.tag(msg, "label")
        labels_pending = if label, do: Map.delete(state.labels_pending, label), else: state.labels_pending
        state_with_labels = %{state | labels_pending: labels_pending}

        numeric_code = numeric_code(msg)
        trailing = List.last(msg.params)
        sender = Message.sender_nick(msg)

        # Persist the numeric as a `:notice` row in the routed window —
        # iff the trailing param is a string (defensive: malformed numerics
        # with no trailing text are dropped silently rather than crashing
        # the changeset on body=nil for body-required kind :notice).
        persist_state =
          if is_binary(trailing) do
            channel = routing_to_channel(routing)
            severity = NumericRouter.severity(numeric_code)
            meta = %{numeric: numeric_code, severity: severity}

            attrs =
              Session.put_subject_id(
                %{
                  network_id: state.network_id,
                  channel: channel,
                  server_time: System.system_time(:millisecond),
                  sender: sender,
                  body: trailing,
                  meta: meta
                },
                state.subject
              )

            apply_effects([{:persist, :notice, attrs}], state_with_labels)
          else
            state_with_labels
          end

        # Also delegate so EventRouter can update state (e.g. 305/306
        # away_confirmed). EventRouter's catch-all returns `[]` for
        # numerics we haven't given dedicated handlers, so this is a
        # no-op for most numerics; the state mutations it owns (e.g.
        # AWAY confirmation) still flow.
        {:cont, next_state, effects} = EventRouter.route(msg, persist_state)
        final_state = effects |> apply_effects(next_state) |> prune_seeded_channels()
        maybe_broadcast_channels_changed(state, final_state)
        maybe_broadcast_own_nick_changed(state, final_state)
        {:noreply, final_state}
    end
  end

  def handle_info({:irc, %Message{} = msg}, state), do: delegate(msg, state)

  # Terminal failure handling — k-line or permanent SASL (Decision C,
  # locked). Fires the `credential_failer` callback (if present) in a
  # detached Task so the DB transition + PubSub broadcast happen AFTER
  # this GenServer has exited. Calling mark_failed synchronously would
  # deadlock: mark_failed calls Session.stop_session → DynamicSupervisor
  # .terminate_child → the server can't exit while blocked in the call.
  # The Task's async execution is safe: by the time it calls
  # mark_failed_by_ids → stop_session → whereis, the process is already
  # gone (whereis returns nil → stop_session is a no-op → DB transition
  # and broadcast proceed normally).
  #
  # CP24 bucket E lifecycle/S1: visitor sessions ALSO carry a
  # `credential_failer` now — `Visitors.SessionPlan` injects a closure
  # that calls `Visitors.mark_failed/2` to expire the visitor row
  # immediately. Pre-bucket-E visitors had no failer and Bootstrap
  # would respawn k-lined visitors forever with no operator signal.
  # The is_function/1 guard already accepted both shapes; only the
  # injection site was missing for visitors.
  #
  # `{:stop, :normal, state}` causes the `:transient` restart strategy
  # to NOT respawn: `:transient` only restarts on ABNORMAL exits.
  @spec handle_terminal_failure(String.t(), t()) :: {:stop, :normal, t()}
  defp handle_terminal_failure(reason, state) when is_binary(reason) do
    _ =
      if is_function(state.credential_failer, 1) do
        failer = state.credential_failer
        Task.start(fn -> failer.(reason) end)
      end

    {:stop, :normal, state}
  end

  # SASL terminal-failure classifier (Decision C, locked).
  #
  # Permanent (credentials misconfigured — operator must fix):
  #   "SASL authentication failed" — upstream rejected our credentials
  #     definitively. The exact wording varies slightly across IRCds but
  #     always contains "authentication failed".
  #   "Invalid username/password" — some IRCds use this phrasing for
  #     PLAIN auth failures.
  #   "Password incorrect" — alternate wording for credential rejection.
  #
  # Transient (network hiccup — bouncer should keep trying):
  #   "SASL authentication aborted" — client or server aborted mid-exchange.
  #   "SASL authentication timed out" — timeout, not a credential error.
  #   Everything else — unknown reasons default to TRANSIENT to avoid
  #     falsely parking a session on an unrecognized error message from
  #     a non-standard IRCd. Permanent-fail must be an affirmative match.
  #
  # Case-insensitive substring matching: IRCd phrasing varies; targeting
  # the distinctive substring is more robust than exact string equality.
  @spec sasl_terminal?(String.t()) :: boolean()
  defp sasl_terminal?(trailing) when is_binary(trailing) do
    lower = String.downcase(trailing)

    String.contains?(lower, "authentication failed") or
      String.contains?(lower, "invalid username") or
      String.contains?(lower, "password incorrect")
  end

  # IRC services suite — delegates to `Grappa.IRC.Identifier.services_sender?/1`
  # (UX-4 bucket G unified the closed allowlist there so EventRouter
  # inbound NOTICE/PRIVMSG routing and this outbound path read from a
  # single source). PRIVMSG to one is a credential or control command
  # (NickServ IDENTIFY, ChanServ REGISTER, OperServ ROOMS, etc.) —
  # never persist body to scrollback (cleartext password leak, W12) and
  # never broadcast over PubSub (other tabs of the same user shouldn't
  # see the password). Generic rule, not NSInterceptor-specific:
  # NSInterceptor's regex matches NickServ only; this scrollback skip
  # is broader.
  #
  # Bucket H — lifecycle/S4 history: pre-fix this used
  # `String.ends_with?(target, "serv")` which silently misclassified
  # ANY target ending in those bytes — channels like `#dataserv` /
  # `#aiserv`, nicks like `Conserv` / `Dataserv` / `Reserv` (real ops
  # nicks on some networks) — and silently dropped them from
  # scrollback. The closed allowlist (now in Identifier) is the
  # privacy contract.
  defp service_target?(target), do: Identifier.services_sender?(target)

  # Existing behavior — persist scrollback row, broadcast on per-channel
  # PubSub topic, send the wire line. Reply carries the persisted row.
  # BUGHUNT-1 A: a body larger than the wire-frame budget (LINELEN -
  # envelope overhead) is auto-split into N fragments via
  # `Grappa.IRC.LineSplit.split_privmsg_body/3`; each fragment becomes
  # its OWN persist_event + broadcast + Client.send_privmsg, matching
  # what every other IRC client renders (and what other channel members
  # see — upstream relays each PRIVMSG as a separate row). The HTTP
  # reply returns the LAST fragment's persisted message so cic's
  # scrollback view aligns with the final row id. Default linelen=512
  # makes the fast-path `[body]` for typical-length messages — no
  # behavior change vs the pre-BUGHUNT-1 single-fragment loop.
  defp handle_persisting_send(target, body, state) do
    fragments = Grappa.IRC.LineSplit.split_privmsg_body(body, target, state.linelen)

    case persist_and_send_fragments(target, fragments, state, nil) do
      {:ok, last_message} -> {:reply, {:ok, last_message}, state}
      {:error, _} = err -> {:reply, err, state}
    end
  end

  @spec persist_and_send_fragments(
          String.t(),
          [String.t()],
          t(),
          Scrollback.Message.t() | nil
        ) ::
          {:ok, Scrollback.Message.t()} | {:error, term()}
  defp persist_and_send_fragments(_, [], _, last_message),
    do: {:ok, last_message}

  defp persist_and_send_fragments(target, [fragment | rest], state, _) do
    attrs =
      Session.put_subject_id(
        %{
          network_id: state.network_id,
          channel: target,
          server_time: System.system_time(:millisecond),
          kind: :privmsg,
          sender: state.nick,
          body: fragment,
          meta: %{},
          # CP14 B3 — outbound DM detection. `Scrollback.dm_peer/4` is
          # the single source for the rule (channel msg vs DM): for
          # outbound, target is the peer iff target is nick-shaped (no
          # #/&/!/+ sigil and not "$server"). The EventRouter inbound
          # path uses the same fn, so both halves of every DM thread
          # land with matching `dm_with` values.
          dm_with: Scrollback.dm_peer(:privmsg, target, state.nick, state.nick)
        },
        state.subject
      )

    with {:ok, message} <- Scrollback.persist_event(attrs),
         :ok <-
           Grappa.PubSub.broadcast_event(
             Topic.channel(state.subject_label, state.network_slug, target),
             Wire.message_payload(message)
           ),
         # `Client.send_privmsg` returns `:ok | {:error, :invalid_line}`
         # since S29 C1. The Session facade pre-validates so the error
         # branch is unreachable on the documented path; forward-compat
         # insurance against a future caller bypassing the facade.
         :ok <- send_privmsg_or_log(state.client, target, fragment) do
      persist_and_send_fragments(target, rest, state, message)
    else
      {:error, _} = err -> err
    end
  end

  @spec send_privmsg_or_log(pid(), String.t(), String.t()) ::
          :ok | {:error, :invalid_line}
  defp send_privmsg_or_log(client, target, body) do
    case Client.send_privmsg(client, target, body) do
      :ok ->
        :ok

      {:error, :invalid_line} = err ->
        Logger.error("client rejected privmsg AFTER persist — facade bypass?",
          channel: target
        )

        err
    end
  end

  # Service-target path — wire-only, no Scrollback row, no PubSub
  # broadcast. Reply tag `{:ok, :no_persist}` keeps callers' `{:ok, _}`
  # match-shape working (Visitors.Login.send_post_login_identify).
  defp handle_service_target_send(target, body, state) do
    case Client.send_privmsg(state.client, target, body) do
      :ok ->
        {:reply, {:ok, :no_persist}, state}

      {:error, :invalid_line} = err ->
        Logger.error("client rejected service-target privmsg",
          target: target
        )

        {:reply, err, state}
    end
  end

  # Latest-wins serialization for concurrent IDENTIFYs is automatic via
  # Session.Server mailbox FIFO (W8): if a second IDENTIFY arrives
  # before the first's +r confirmation, the second overwrites and the
  # first's password is lost (correct — the user changed their mind
  # between the two send_privmsg calls). Cancel the in-flight timer
  # before arming a fresh one so timeouts always reflect the most-recent
  # capture.
  # AuthFSM (inside `Grappa.IRC.Client`) emits the wire IDENTIFY at 001
  # for `:nickserv_identify` plans — that emission bypasses
  # `handle_call({:send_privmsg, ...})`, so NSInterceptor doesn't fire.
  # This helper stages `pending_auth` directly so the +r observer
  # (`apply_effects/2 → :visitor_r_observed`) can commit when NickServ
  # confirms. One-shot — `pending_password` is cleared after first 001
  # to prevent a Phase-5 reconnect-001 from re-staging stale credentials.
  @spec maybe_stage_pending_password(t()) :: t()
  defp maybe_stage_pending_password(%{pending_password: nil} = state), do: state

  defp maybe_stage_pending_password(%{pending_password: pwd} = state)
       when is_binary(pwd) do
    state
    |> stage_pending_auth(pwd)
    |> Map.put(:pending_password, nil)
  end

  defp stage_pending_auth(state, password) do
    :ok = cancel_and_drain(state.pending_auth_timer, :pending_auth_timeout)

    timer = Process.send_after(self(), :pending_auth_timeout, @pending_auth_timeout_ms)
    deadline = System.monotonic_time(:millisecond) + @pending_auth_timeout_ms

    %{state | pending_auth: {password, deadline}, pending_auth_timer: timer}
  end

  # Drive the GhostRecovery FSM forward by one input. Terminal phases
  # (`:succeeded`, `:failed`) cancel the 8s timer and wipe both ghost
  # fields; non-terminal transitions just update the FSM struct.
  defp advance_ghost(state, input) do
    {_, next, lines} = GhostRecovery.step(state.ghost_recovery, input)
    state = flush_lines(state, lines)

    case next.phase do
      terminal when terminal in [:succeeded, :failed] ->
        :ok = cancel_and_drain(state.ghost_timer, :ghost_timeout)

        {:noreply, %{state | ghost_recovery: nil, ghost_timer: nil}}

      _ ->
        {:noreply, %{state | ghost_recovery: next}}
    end
  end

  # Lines emitted by GhostRecovery bypass `handle_call({:send_privmsg,
  # ...})`, so manually run NSInterceptor over each line and stage
  # `pending_auth` on capture. This is what keeps the +r MODE rendezvous
  # (Task 15) firing for the `IDENTIFY` GhostRecovery emits on
  # `:succeeded` — same one-feature-one-code-path discipline as the
  # AuthFSM-emitted IDENTIFY at 001 (handled via
  # `maybe_stage_pending_password/1`).
  defp flush_lines(state, lines) do
    Enum.reduce(lines, state, fn line, acc ->
      acc =
        case NSInterceptor.intercept(line) do
          :passthrough -> acc
          {:capture, password} -> stage_pending_auth(acc, password)
        end

      # REV-E (H11): pre-fix this strict-bound `:ok =` and MatchError'd
      # on a dead socket mid-recovery (e.g., NickServ ghost dance racing
      # an upstream RST). Fire-and-forget + Logger: ghost recovery is
      # already a fragile rendezvous; a dead socket mid-flow means the
      # next reconnect will retry GHOST + IDENTIFY from scratch. The
      # `pending_auth` staging that already happened in `acc` is
      # discarded harmlessly on terminate/2.
      case Client.send_line(acc.client, line) do
        :ok ->
          :ok

        {:error, reason} ->
          Logger.warning("ghost-recovery flush_lines: send_line failed",
            reason: inspect(reason)
          )
      end

      acc
    end)
  end

  # Build the IRC.Client opts map from the pre-resolved primitive
  # plan. Nick-fallback + Cloak password decryption already happened
  # in `Grappa.Networks.SessionPlan.resolve/1`'s `build_plan/4` — the
  # Server is a pass-through here. Same `Client.opts()` shape
  # contract carried in via A23.
  @spec client_opts(init_opts()) :: Client.opts()
  defp client_opts(opts) do
    %{
      host: opts.host,
      port: opts.port,
      tls: opts.tls,
      source_address: opts.source_address,
      dispatch_to: self(),
      logger_metadata: Log.session_context(opts.subject_label, opts.network_slug),
      nick: opts.nick,
      realname: opts.realname,
      sasl_user: opts.sasl_user,
      auth_method: opts.auth_method,
      password: opts.password
    }
  end

  # ---------------------------------------------------------------------------
  # S4.2 — labeled-response label generation + tracking
  # ---------------------------------------------------------------------------

  # If the upstream has ACK'd `labeled-response`, generates a new label,
  # records the label → origin_window correlation in labels_pending, and
  # returns `{label_string, new_state}`. If the cap is not active or
  # origin_window is nil, returns `{nil, state}` (caller sends without label).
  # Last_command_window is always updated when origin_window is non-nil.
  @spec prepare_label(t(), window_ref() | nil) :: {String.t() | nil, t()}
  defp prepare_label(state, nil) do
    {nil, state}
  end

  defp prepare_label(state, origin_window) when is_map(origin_window) do
    state = %{state | last_command_window: origin_window}

    if MapSet.member?(state.caps_active, "labeled-response") do
      label = generate_label()
      labels_pending = Map.put(state.labels_pending, label, origin_window)
      {label, %{state | labels_pending: labels_pending}}
    else
      {nil, state}
    end
  end

  # Generates a new UUID label string. RFC 4122 UUID v4 via `:crypto` —
  # sufficient uniqueness for in-flight correlation (bounded, short-lived map).
  @spec generate_label() :: String.t()
  defp generate_label, do: Ecto.UUID.generate()

  # ---------------------------------------------------------------------------
  # NumericRouter state builder
  # ---------------------------------------------------------------------------

  # Builds the `NumericRouter.router_state()` view from full Session.Server
  # state. CP13: the router only needs `own_nick` (to skip the params[0]
  # echo and exclude self-mentions from query candidates) and
  # `labels_pending` (for labeled-response correlation). It no longer reads
  # `last_command_window` or `open_query_nicks` — the new "scan-then-server"
  # fallback is purely syntactic on params.
  defp build_router_state(state) do
    NumericRouter.new_router_state(state.nick, state.labels_pending)
  end

  # Extracts the integer numeric code from a numeric Message.
  @spec numeric_code(Message.t()) :: 1..999
  defp numeric_code(%Message{command: {:numeric, code}}), do: code

  # Maps a NumericRouter routing decision (non-:delegated branch) to the
  # `channel` field of the persisted `:notice` row. CP13: `{:server, nil}`
  # routes to the synthetic `"$server"` window; `{:channel, c}` and
  # `{:query, n}` route directly to the named target. Mirrors
  # `Grappa.Scrollback.Message.@valid_target?` accept set.
  @spec routing_to_channel({:channel, String.t()} | {:query, String.t()} | {:server, nil}) ::
          String.t()
  defp routing_to_channel({:channel, c}) when is_binary(c), do: c
  defp routing_to_channel({:query, n}) when is_binary(n), do: n
  defp routing_to_channel({:server, nil}), do: "$server"
  #
  # Channels-list mutation (self-JOIN / self-PART / self-KICK changes the
  # `state.members` keyset) fires a fan-out broadcast on the per-user
  # topic so every connected tab refetches GET /channels and re-subscribes
  # to per-channel WS topics. Direction-agnostic: grow + shrink share the
  # same heartbeat shape; the cause is irrelevant to subscribers, the
  # REST endpoint is the source of truth for the new list.
  @spec delegate(Message.t(), t()) :: {:noreply, t()}
  defp delegate(msg, state) do
    {:cont, derived_state, effects} = EventRouter.route(msg, state)
    next_state = effects |> apply_effects(derived_state) |> prune_seeded_channels()
    maybe_broadcast_channels_changed(state, next_state)
    maybe_broadcast_own_nick_changed(state, next_state)
    {:noreply, next_state}
  end

  # CP24 bucket E web/S8: keep `seeded_channels` consistent with
  # `state.members` keys. EventRouter mutates `state.members` for
  # self-PART (`Map.delete(state.members, channel)`) and self-KICK
  # (same), but doesn't know about the bucket-E sentinel set. A
  # post-route intersect drops stale entries — symmetric with the
  # JOIN-time wipe (self-JOIN reseeds `state.members[channel] =
  # %{nick => []}` so the next 366 fires `apply_effects` and re-adds
  # to `seeded_channels`).
  @spec prune_seeded_channels(t()) :: t()
  defp prune_seeded_channels(state) do
    member_keys = MapSet.new(Map.keys(state.members))
    %{state | seeded_channels: MapSet.intersection(state.seeded_channels, member_keys)}
  end

  @spec maybe_broadcast_channels_changed(t(), t()) :: :ok
  defp maybe_broadcast_channels_changed(prev, next) do
    prev_keys = prev.members |> Map.keys() |> Enum.sort()
    next_keys = next.members |> Map.keys() |> Enum.sort()

    if prev_keys != next_keys do
      broadcast_channels_changed(next)

      # CP22 cluster B (channel-client-polish #14, B-restart) — persist
      # the snapshot so a graceful or crash restart can rehydrate. Same
      # change-detection (sorted keyset diff) as the broadcast above —
      # the keyset is the only field that affects rejoin. Single Repo
      # write per channels-list mutation (a typical session sees a
      # handful of these per hour). Failure logged but NOT fatal: the
      # next mutation overwrites, and a missing snapshot only forces
      # the next restart to fall back to operator autojoin.
      :ok = persist_last_joined(prev.subject, prev.network_id, next_keys, prev.last_joined_persister)
    end

    :ok
  end

  # UX-4 bucket H — `handle_cast({:send_part, _})` calls this directly
  # to force a `channels_changed` broadcast regardless of whether the
  # state.members keyset changed. The eager-PART cleanup may be a no-op
  # (operator PARTed a chan they never joined), but cic's channelsBySlug
  # still needs to refetch — the controller-side autojoin removal already
  # happened, and a stale autojoin entry would leave the row in the
  # sidebar without a refetch trigger. Mirror of the broadcast inside
  # `maybe_broadcast_channels_changed/2` so the wire shape stays single-
  # sourced.
  @spec broadcast_channels_changed(t()) :: :ok
  defp broadcast_channels_changed(state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(state.subject_label),
        SessionWire.channels_changed()
      )
  end

  # UX-5 bucket BK (2026-05-19): every `apply_effects` arm that creates
  # archive-eligible scrollback content (`:join_failed`, `:kicked`,
  # `:parted`) calls this so cic's `archivedBySlug` cache refreshes
  # without waiting for a manual archive-section toggle. Symmetric with
  # `ArchiveController.broadcast_archive_changed/2`'s envelope; single
  # source of truth for the broadcast shape. Without this, the operator
  # dismisses a pseudo-row via the Sidebar × and the archive section
  # stays empty until they toggle it open. The cic-side handler is
  # `userTopic.ts`'s `archive_changed` arm — idempotent `loadArchive`
  # refetch, so redundant broadcasts are cheap.
  @spec broadcast_archive_changed(t()) :: :ok
  defp broadcast_archive_changed(state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(state.subject_label),
        Wire.archive_changed_payload(state.network_slug)
      )
  end

  @spec persist_last_joined(Grappa.Session.subject(), pos_integer(), [String.t()], last_joined_persister() | nil) :: :ok
  defp persist_last_joined(_, _, _, nil), do: :ok

  defp persist_last_joined(_, _, channels, fun)
       when is_function(fun, 1) do
    case fun.(channels) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("last_joined_channels persist failed",
          reason: inspect(reason)
        )

        :ok
    end
  end

  # Broadcasts `own_nick_changed` on the user-level PubSub topic when the
  # live IRC nick changes (NICK event, 001 RPL_WELCOME nick reconciliation).
  # Cicchetto's userTopic handler updates the per-network nick in the
  # networks store, which triggers reactive re-subscription to the correct
  # own-nick DM topic. Without this broadcast, cicchetto subscribes to the
  # CREDENTIAL nick (e.g. "grappa") while the live nick is "vjt-grappa" —
  # inbound DMs are silently dropped.
  @spec maybe_broadcast_own_nick_changed(t(), t()) :: :ok
  defp maybe_broadcast_own_nick_changed(%{nick: prev_nick}, %{nick: next_nick} = next_state)
       when prev_nick != next_nick do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(next_state.subject_label),
        SessionWire.own_nick_changed(next_state.network_id, next_nick)
      )
  end

  defp maybe_broadcast_own_nick_changed(_, _), do: :ok

  # Push notifications cluster B4 (2026-05-14) — fire-and-forget
  # trigger eval after a successful Scrollback.persist_event/1 in the
  # `:persist` apply_effects/2 arm. Subject-aware as of visitor-parity
  # V3 (2026-05-15) — both `{:user, _}` and `{:visitor, _}` subjects
  # dispatch through `Push.Triggers`.
  #
  # Two short-circuits before delegating:
  #
  #   1. Self-echoes never push. Outbound PRIVMSG / ACTION rows have
  #      `sender == state.nick` (the per-network IRC nick reconciled at
  #      001). Pushing an OS notification for messages the operator
  #      typed themselves would be obviously wrong.
  #   2. Kind gate is enforced inside `Triggers.evaluate_and_dispatch/2`
  #      — only `:privmsg` and `:action` proceed past it. Filtering
  #      here too would be belt-and-braces; let the canonical predicate
  #      live in one place.
  #
  # `Triggers` itself spawns the unlinked Task for prefs lookup +
  # Sender fan-out, so this call site is sub-microsecond on the hot
  # path. No state mutation — Session.Server's struct shape is
  # untouched, keeping the deploy preflight in HOT mode.
  @spec maybe_dispatch_push(Scrollback.Message.t(), t()) :: :ok
  defp maybe_dispatch_push(%Scrollback.Message{sender: sender}, %{nick: own_nick})
       when sender == own_nick,
       do: :ok

  defp maybe_dispatch_push(message, %{subject: subject} = state) do
    PushTriggers.evaluate_and_dispatch(message, %{
      subject: subject,
      network_slug: state.network_slug,
      own_nick: state.nick
    })
  end

  @spec apply_effects([EventRouter.effect()], t()) :: t()
  defp apply_effects([], state), do: state

  defp apply_effects([{:topic_changed, channel, entry} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.channel(state.subject_label, state.network_slug, channel),
        SessionWire.topic_changed(state.network_slug, channel, entry)
      )

    apply_effects(rest, state)
  end

  defp apply_effects([{:channel_modes_changed, channel, entry} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.channel(state.subject_label, state.network_slug, channel),
        SessionWire.channel_modes_changed(state.network_slug, channel, entry)
      )

    apply_effects(rest, state)
  end

  defp apply_effects([{:channel_created, channel, %DateTime{} = dt} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.channel(state.subject_label, state.network_slug, channel),
        SessionWire.channel_created(state.network_slug, channel, dt)
      )

    apply_effects(rest, state)
  end

  # Emitted on 366 RPL_ENDOFNAMES — tells cicchetto that state.members[channel]
  # is now fully populated and any racing GET /members can be re-issued.
  # Without this, a fresh /join lands in the sidebar before bahamut's 353
  # arrives; cicchetto's MembersPane fetch returns an empty list and the
  # one-shot loadedChannels gate prevents a re-fetch until page reload.
  defp apply_effects([{:members_seeded, channel, members_map} | rest], state) do
    # Sort + serialize the same way list_members/3 does — the wire payload
    # is identical to a GET /members snapshot, so the cicchetto seed path
    # is a single signal write with no extra fetch (the race window between
    # WS subscribe and HTTP fetch is what made the old re-fetch design
    # flaky on slow JOIN sequences).
    members =
      members_map
      |> Enum.map(fn {nick, modes} -> %{nick: nick, modes: modes} end)
      |> Enum.sort_by(&{member_sort_tier(&1.modes), &1.nick})

    # CP24 bucket E web/S8: mark channel as NAMES-seeded so
    # `list_members/3` discriminates `{:ok, :uninitialized}` (pre-NAMES)
    # from `{:ok, []}` (NAMES emitted empty). Channel keys match
    # `state.members` casing.
    state = %{state | seeded_channels: MapSet.put(state.seeded_channels, channel)}

    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.channel(state.subject_label, state.network_slug, channel),
        SessionWire.members_seeded(state.network_slug, channel, members)
      )

    apply_effects(rest, state)
  end

  # CP15 B1 + cluster #6: own-nick JOIN echo received → window
  # transitions to :joined. Delegates state mutation to
  # `WindowState.set_joined/2` (which clears any prior :failed /
  # :kicked metadata — see that fn's doc) and broadcasts the typed
  # `joined` event on `Topic.user/1` so cic's userTopic.ts dispatcher
  # flips render state without polling. F1 (2026-05-15) moved the
  # broadcast off the per-channel topic to close the
  # subscribe-then-broadcast race documented at
  # `broadcast_window_state/2`.
  defp apply_effects([{:joined, channel} | rest], state) do
    broadcast_window_state(state, SessionWire.joined(state.network_slug, channel))

    # In-flight-JOIN tracker stays here — it's not part of WindowState
    # (different lifetime: TTL-swept, not state-driven). Stripped on
    # successful echo to keep the failure-numeric correlation map
    # bounded; symmetric with event_router.ex:698 stripping on the
    # failure side. Without this strip an unsolicited late 471/473
    # within the 30s TTL window can correlate against the ghost and
    # corrupt window state from :joined back to :failed (lifecycle
    # review HIGH S1).
    state = %{
      state
      | window_state: WindowState.set_joined(state.window_state, channel),
        in_flight_joins: Map.delete(state.in_flight_joins, String.downcase(channel))
    }

    apply_effects(rest, state)
  end

  # CP15 B2 + cluster #6: JOIN failure numeric (471/473/474/475/403/405)
  # correlated against an in-flight JOIN. Three concerns, one arm:
  #   1. State — `WindowState.set_failed/4` records :failed +
  #      reason + numeric in one struct field. Cic projects from
  #      these via the typed broadcast below; the WindowState struct
  #      is the source of truth for any future REST snapshot fetch.
  #   2. Persistence — write a :notice row on the channel scrollback so
  #      the failure shows in window history (and survives reconnect).
  #      `sender = state.nick` matches Identifier.valid_sender? same as
  #      MOTD's BUG2 fix; meta.numeric is the only structured datum cic
  #      needs to render the failure differently from a regular notice.
  #   3. Event broadcast — typed `kind: "join_failed"` payload on the
  #      per-channel topic (sibling to the B1 `joined` event). Cic flips
  #      the window's render state without polling.
  defp apply_effects([{:join_failed, channel, reason, numeric} | rest], state) do
    attrs =
      Session.put_subject_id(
        %{
          network_id: state.network_id,
          channel: channel,
          server_time: System.system_time(:millisecond),
          kind: :notice,
          sender: state.nick,
          body: reason,
          meta: %{numeric: numeric}
        },
        state.subject
      )

    case Scrollback.persist_event(attrs) do
      {:ok, message} ->
        # Broadcast the persisted notice as a regular `kind: "message"`
        # wire event so cic appends it to the channel's scrollback in
        # real time. Without this push, the notice row exists in the DB
        # but cic only sees it on the NEXT loadInitialScrollback (which
        # is `loadedChannels`-gated and won't re-fire). Symmetric with
        # the `:persist` effect arm — the only difference is that
        # `:join_failed` carries an extra typed event below for the
        # state-machine flip.
        :ok =
          Grappa.PubSub.broadcast_event(
            Topic.channel(state.subject_label, state.network_slug, channel),
            Wire.message_payload(message)
          )

        # UX-5 bucket BK (2026-05-19): the persisted notice qualifies
        # as archive content (`Scrollback.list_archive/3` filters by
        # `active_keyset`; the failed channel was never JOINed so it's
        # absent from the keyset → archive includes it). Gated on
        # `{:ok, _}` so a persist failure doesn't fire a spurious
        # archive_changed (cic would refetch the unchanged archive set).
        broadcast_archive_changed(state)

      {:error, changeset} ->
        Logger.error("scrollback insert failed for join_failed",
          channel: channel,
          numeric: numeric,
          error: inspect(changeset.errors)
        )
    end

    broadcast_window_state(
      state,
      SessionWire.join_failed(state.network_slug, channel, reason, numeric)
    )

    state = %{
      state
      | window_state: WindowState.set_failed(state.window_state, channel, reason, numeric)
    }

    apply_effects(rest, state)
  end

  # CP15 B3 + cluster #6: own-PART acked by upstream → window archived.
  # Delegates to `WindowState.set_parted/2` which drops the channel
  # from every sibling map; cic projects "no key + scrollback present"
  # as `:archived`. The :persist :part row that ships alongside is the
  # UI feed-line — there is intentionally NO `kind: "parted"` broadcast
  # (absence is the signal).
  #
  # No `archive_changed` broadcast here (unlike the BK :join_failed /
  # :kicked arms): every PART path that reaches this arm is preceded
  # by `ChannelsController.delete/2`'s eager `broadcast_archive_changed`
  # at the REST boundary, OR by the eager PartCleanup path that fires
  # `channels_changed` (which triggers cic to refetch). Broadcasting
  # again here would double-fire (idempotent on cic but adds noise to
  # e2e specs that count archive rows post-PART). Phase 6 listener-
  # facade self-PART (or any future non-REST entry point) will need
  # its own broadcast at its boundary.
  defp apply_effects([{:parted, channel} | rest], state) do
    state = %{state | window_state: WindowState.set_parted(state.window_state, channel)}

    apply_effects(rest, state)
  end

  # CP15 B3 + cluster #6: own-target KICK → window transitions to
  # :kicked. Two concerns, one arm:
  #   1. State — `WindowState.set_kicked/4` records :kicked + by +
  #      reason. The window stays in the active sidebar (greyed) so
  #      the operator can /join to retry; archiving on KICK would
  #      punish the victim.
  #   2. Event broadcast — typed `kind: "kicked"` payload on the
  #      per-channel topic carrying `by` + `reason` so cic can render the
  #      kick reason banner without parsing the scrollback row. The
  #      :persist :kick row alongside is the audit trail.
  defp apply_effects([{:kicked, channel, by, reason} | rest], state) do
    broadcast_window_state(
      state,
      SessionWire.kicked(state.network_slug, channel, by, reason)
    )

    # UX-5 bucket BK (2026-05-19): symmetric with `:join_failed` above
    # — the kick audit row + accumulated channel scrollback land in the
    # archive once the operator dismisses the pseudo-row via the
    # Sidebar × button. Pre-BK the kick row was already archive-
    # eligible (self-KICK drops the channel from state.members so
    # `Session.list_channels` excludes it), but cic's `archivedBySlug`
    # was stale until manual archive-section toggle.
    broadcast_archive_changed(state)

    state = %{
      state
      | window_state: WindowState.set_kicked(state.window_state, channel, by, reason)
    }

    apply_effects(rest, state)
  end

  # C2 — WHOIS bundle complete (318 RPL_ENDOFWHOIS). Broadcast the
  # aggregated payload on the user-level topic. Per spec #2: ephemeral
  # — NOT persisted in scrollback. cic's `whoisCard.ts` keys by network
  # and replaces on each new bundle.
  defp apply_effects([{:whois_bundle, target, accum} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(state.subject_label),
        SessionWire.whois_bundle(state.network_slug, target, accum)
      )

    apply_effects(rest, state)
  end

  # P-0c — WHOWAS bundle ephemeral. Broadcast on the user-level topic
  # (mirrors :whois_bundle — single-entity historical-user data routed
  # via Topic.user/1 because the wire payload carries its own `network`
  # field). cic dispatches in `userTopic.ts`'s `whowas_bundle` arm into
  # the per-network `whowasCard.ts` store (last-write-wins replacement
  # per network). NOT persisted — operator types /whowas to refresh.
  defp apply_effects([{:whowas_bundle, target, accum} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(state.subject_label),
        SessionWire.whowas_bundle(state.network_slug, target, accum)
      )

    apply_effects(rest, state)
  end

  # P-0b — standalone 301 RPL_AWAY ephemeral. Broadcast on the
  # user-level topic (mirrors :whois_bundle); cic's dm-listener routes
  # by `peer:` field and renders inline in the peer's DM window. No
  # server-side dedup / rate-limit: display rate is a UI concern.
  defp apply_effects([{:peer_away, peer, message} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(state.subject_label),
        SessionWire.peer_away(state.network_slug, peer, message)
      )

    apply_effects(rest, state)
  end

  # P-0e + P-0f — 341 RPL_INVITING ephemeral. Broadcast on the
  # USER-level topic (NOT the per-channel topic of the channel invited
  # to). Operators usually invite peers to channels they are NOT in
  # (e.g. `/invite grappa #it-opers` from #bofh) — routing on the
  # target channel's per-topic dropped the broadcast on the floor for
  # everyone except the operator who already happened to be in the
  # target channel. P-0f flips the route to user-topic so the always-
  # subscribed $server window is the canonical surface; the wire
  # payload's `channel` field becomes informational ("→ invited
  # <peer> to <channel>") rather than a routing key. Mirrors the
  # LUSERS routing precedent — ephemerals carrying their own `network`
  # field (and now `channel`) route via Topic.user/1.
  defp apply_effects([{:invite_ack, channel, peer} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(state.subject_label),
        SessionWire.invite_ack(state.network_slug, channel, peer)
      )

    apply_effects(rest, state)
  end

  # P-0d — LUSERS bundle ephemeral. Broadcast on the user-level topic
  # (mirrors `:whois_bundle` — ephemerals carrying their own `network`
  # field route via Topic.user/1). cic dispatches in `userTopic.ts`'s
  # `lusers_bundle` arm into the per-network `lusersBundle.ts` store
  # (last-write-wins replacement). NOT persisted — operator types
  # /lusers to refresh.
  defp apply_effects([{:lusers_bundle, accum} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(state.subject_label),
        SessionWire.lusers_bundle(state.network_slug, accum)
      )

    apply_effects(rest, state)
  end

  defp apply_effects([{:persist, kind, attrs} | rest], state) do
    full_attrs = Map.put(attrs, :kind, kind)

    case Scrollback.persist_event(full_attrs) do
      {:ok, message} ->
        # Topic shape is `(subject_label, network_slug, channel)` —
        # sub-task 2h roots every Grappa topic in the subject
        # discriminator (Task 6.5 generalized "user_name" to
        # opaque subject_label so visitors map to a parallel
        # `"visitor:<uuid>"` root). `:network` is preloaded by
        # `Scrollback.persist_event/1`; Wire.message_payload
        # pattern-matches on it.
        :ok =
          Grappa.PubSub.broadcast_event(
            Topic.channel(state.subject_label, state.network_slug, attrs.channel),
            Wire.message_payload(message)
          )

        # Push notifications cluster B4 — fire-and-forget trigger
        # eval on inbound PRIVMSG / ACTION. Triggers spawns its own
        # unlinked Task; this call is sub-microsecond. See
        # `maybe_dispatch_push/2` for the user-only + non-self-echo
        # short-circuit logic.
        :ok = maybe_dispatch_push(message, state)

      {:error, changeset} ->
        Logger.error("scrollback insert failed",
          command: kind,
          channel: attrs.channel,
          error: inspect(changeset.errors)
        )
    end

    apply_effects(rest, state)
  end

  defp apply_effects([{:reply, line} | rest], state) do
    # REV-E (H11): EventRouter-emitted outbound (e.g., CTCP VERSION NOTICE
    # reply). Fire-and-forget: a dead socket here means the reply doesn't
    # land on the wire, but the paired `:persist` effect (emitted in the
    # SAME effect list — EventRouter.do_route/2 emits `[{:reply, _},
    # {:persist, _, _}]`) will run on the NEXT recursion regardless of
    # send_line's outcome, so the user-visible scrollback row lands
    # either way. Pre-fix this strict-bound `:ok =` and MatchError-
    # crashed the Session on dead socket, swallowing the persist too.
    # Supervisor restart owns reconnect.
    case Client.send_line(state.client, line) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("event-router reply dropped: send_line failed",
          reason: inspect(reason)
        )
    end

    apply_effects(rest, state)
  end

  # S3.4: 305 RPL_UNAWAY / 306 RPL_NOWAWAY confirmed by the upstream.
  # Broadcast `{:event, %{kind: "away_confirmed", state: "present" | "away"}}`
  # on the user-level PubSub topic so cicchetto can update its status display.
  # REV-H H3: the atom→string conversion lives at the Wire boundary
  # (`SessionWire.away_confirmed/2` accepts the `:present | :away` atom
  # directly), mirroring `Scrollback.Wire.to_json/1`'s `Atom.to_string(m.kind)`.
  defp apply_effects([{:away_confirmed, away_atom} | rest], state)
       when away_atom in [:present, :away] do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(state.subject_label),
        SessionWire.away_confirmed(state.network_slug, away_atom)
      )

    apply_effects(rest, state)
  end

  # Task 15: NickServ-as-IDP confirmed our pending IDENTIFY by setting
  # +r on our nick. Invoke the opaque `visitor_committer` callback
  # (`Grappa.Visitors.commit_password/2`, injected by
  # `Grappa.Visitors.SessionPlan` into every visitor plan) so the
  # captured password lands on the visitors row + bumps `expires_at`
  # to the registered TTL. Then clear pending state + cancel the
  # fail-safe timer. The function-reference indirection keeps Session
  # free of a static `Grappa.Visitors` alias — Visitors deps Session
  # via `Visitors.Login`, so a literal alias would close a Boundary
  # cycle. User sessions don't carry a committer; if a {:user, _}
  # somehow staged pending_auth (e.g. operator manually issued
  # NickServ IDENTIFY), the +r is logged and dropped.
  defp apply_effects([{:visitor_r_observed, password} | rest], state) do
    case {state.subject, state.visitor_committer} do
      {{:visitor, visitor_id}, committer} when is_function(committer, 2) ->
        case committer.(visitor_id, password) do
          {:ok, _} ->
            Logger.info("visitor +r observed → password committed",
              visitor_id: visitor_id
            )

          {:error, reason} ->
            Logger.error("visitor +r observed but commit failed",
              visitor_id: visitor_id,
              reason: inspect(reason)
            )
        end

      {{:visitor, visitor_id}, nil} ->
        Logger.error("visitor +r observed but no committer in plan — drop",
          visitor_id: visitor_id
        )

      {{:user, _}, _} ->
        Logger.warning("visitor_r_observed effect on user session — ignored")
    end

    :ok = cancel_and_drain(state.pending_auth_timer, :pending_auth_timeout)

    apply_effects(rest, %{state | pending_auth: nil, pending_auth_timer: nil})
  end

  # V9 (visitor-parity cluster, 2026-05-15): EventRouter observed our
  # own NICK self-echo (`old_nick == state.nick`) on a visitor session.
  # Persist the new nick onto the visitors row via the injected
  # `visitor_nick_persister` callback (mirror of `visitor_committer`).
  # The `(nick, network_slug)` UNIQUE constraint catches the
  # near-zero-probability concurrent-rename race; controller-boundary
  # `Visitors.nick_in_use?/3` is the fast-path 409. User sessions
  # don't carry a persister — their nick lives in `Networks.Credential`,
  # which is operator-driven and rotated via the user-side path
  # documented in `nick_controller.ex`.
  defp apply_effects([{:visitor_nick_changed, new_nick} | rest], state) do
    case {state.subject, state.visitor_nick_persister} do
      {{:visitor, visitor_id}, persister} when is_function(persister, 2) ->
        case persister.(visitor_id, new_nick) do
          {:ok, _} ->
            Logger.info("visitor NICK echoed → row rotated",
              visitor_id: visitor_id,
              new_nick: new_nick
            )

          {:error, reason} ->
            Logger.error("visitor NICK echoed but row update failed",
              visitor_id: visitor_id,
              new_nick: new_nick,
              reason: inspect(reason)
            )
        end

      {{:visitor, visitor_id}, nil} ->
        Logger.error("visitor NICK echoed but no persister in plan — drop",
          visitor_id: visitor_id
        )

      {{:user, _}, _} ->
        Logger.warning("visitor_nick_changed effect on user session — ignored")
    end

    apply_effects(rest, state)
  end

  # One-shot send + clear of the synchronous-login readiness signal
  # (Task 8). Pattern-matches both fields populated to avoid
  # half-state misuse — caller MUST set both opts together.
  @spec maybe_fire_notify(t()) :: t()
  defp maybe_fire_notify(%{notify_pid: pid, notify_ref: ref} = state)
       when is_pid(pid) and is_reference(ref) do
    send(pid, {:session_ready, ref})
    %{state | notify_pid: nil, notify_ref: nil}
  end

  defp maybe_fire_notify(state), do: state

  # CP15 B2: record an outbound JOIN as in-flight, keyed by lowercase
  # channel for case-insensitive correlation against failure-numeric
  # echoes (RFC 2812 §2.2). Both `Session.send_join/4` calls and the
  # 001 RPL_WELCOME autojoin loop call through here so the tracking
  # behavior is identical regardless of who initiated the JOIN.
  # Label is `nil` for now — labeled-response correlation lands later.
  #
  # Lazy O(1)-amortized TTL: every insert sweeps entries older than
  # @in_flight_join_ttl_ms first. Bounds the map under upstream silence
  # without a separate Process.send_after timer.
  #
  # CP17 — also flips the per-channel window state to `:pending` and
  # broadcasts `SessionWire.window_pending/2` on the user-level topic.
  # Single producer for both `{:send_join, _}` call and 001 RPL_WELCOME
  # autojoin paths. Broadcast goes on `Topic.user/1` (NOT per-channel)
  # because cic only subscribes to per-channel after seeing `:pending`
  # — chicken-and-egg if we used the channel topic. cic's userTopic.ts
  # createRoot effect joins `Topic.user/1` from boot, so delivery is
  # guaranteed to every connected tab.
  #
  # Idempotency rule: a JOIN issued for a channel ALREADY in `:joined`
  # is a no-op state transition. Skip the `:pending` mutation + the
  # broadcast in that case so connected cic tabs don't briefly flip
  # from `:joined` back to `:pending` (the visual flicker would
  # mid-render the MembersPane "not joined" fallback). The in-flight
  # entry is still recorded — a downstream failure numeric (e.g. 443
  # ERR_USERONCHANNEL) still needs correlation against the in-flight
  # window. The cic-side subscriber is `setPending`-driven; if the
  # broadcast doesn't fire, no spurious state change reaches cic.
  @in_flight_join_ttl_ms 30_000

  @spec record_in_flight_join(t(), String.t()) :: t()
  defp record_in_flight_join(state, channel) when is_binary(channel) do
    now_ms = System.monotonic_time(:millisecond)
    cutoff = now_ms - @in_flight_join_ttl_ms

    swept =
      state.in_flight_joins
      |> Enum.reject(fn {_, {_, at_ms, _}} -> at_ms < cutoff end)
      |> Map.new()

    key = String.downcase(channel)
    entry = {channel, now_ms, nil}
    in_flight_joins = Map.put(swept, key, entry)

    case WindowState.state_of(state.window_state, channel) do
      :joined ->
        # Idempotent re-JOIN: don't downgrade state + don't broadcast.
        %{state | in_flight_joins: in_flight_joins}

      _ ->
        :ok =
          Grappa.PubSub.broadcast_event(
            Topic.user(state.subject_label),
            SessionWire.window_pending(state.network_slug, channel)
          )

        %{
          state
          | in_flight_joins: in_flight_joins,
            window_state: WindowState.set_pending(state.window_state, channel)
        }
    end
  end

  # F1 (visitor-parity-and-nickserv cluster, 2026-05-15): emit the
  # typed window-state terminal events (`joined`, `join_failed`,
  # `kicked`) on `Topic.user/1` (NOT the per-channel topic). Closes
  # a structural Phoenix.PubSub no-replay race documented at
  # `cp15-b6-pending-to-failed-invite-only.spec.ts` flake on
  # 2026-05-15.
  #
  # ## The race (cp15-b6-pending → failed shape, pre-F1)
  #
  #   1. cic POST /join → server.send_join (call) →
  #      `record_in_flight_join/2` broadcasts `window_pending` on
  #      `Topic.user/1`. Cic IS subscribed to user-topic at boot →
  #      `setPending(channelKey)` runs.
  #   2. Cic's `subscribe.ts:533` createEffect on
  #      `windowStateByChannel` fires → `joinChannel(...)` opens an
  #      ASYNC phx.join roundtrip on the per-channel topic.
  #   3. Upstream IRC immediately replies 473. EventRouter emits
  #      `{:join_failed, ch, reason, 473}`. Pre-F1 `apply_effects`
  #      broadcast the typed `join_failed` payload on the per-channel
  #      topic — the SAME topic cic was mid-handshake on. Phoenix
  #      PubSub is no-replay; the broadcast lands before the cic-side
  #      `phx.on("event", ...)` registration.
  #   4. Cic's phx.join completes → handler installed → too late.
  #      `setFailed` never runs. State stays at `:pending`. Sidebar
  #      doesn't show `.sidebar-window-greyed`. Cold-start CI has
  #      higher first-handshake latency → race is wider → flake.
  #
  # The persisted notice scrollback row is recovered via the
  # `applyJoinReply` HTTP refresh path (subscribe.ts:502-509), so
  # the failure body appears in the channel — but the typed
  # state-machine event has no equivalent backfill, hence the
  # `pending → terminal` transition never lands client-side.
  #
  # ## The fix
  #
  # Symmetric with how `window_pending` already uses user-topic for
  # the inverse (origination) edge per CP17 design. The user-topic
  # is joined at cic boot via `userTopic.ts` createRoot effect, so
  # delivery cannot race a subscribe — guaranteed delivery.
  # `userTopic.ts` dispatcher fans out to the same
  # `setJoined/setFailed/setKicked` setters cic already uses for the
  # cold-reconnect snapshot path (per-socket `push/3` from
  # `push_window_state_if_known/4`, NOT a broadcast — survives F1).
  # Per-channel topic remains the carrier for messages, topic, modes,
  # members, read_cursor — events that are ALWAYS post-join-handshake
  # by definition.
  @spec broadcast_window_state(t(), map()) :: :ok
  defp broadcast_window_state(state, payload) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(state.subject_label),
        payload
      )
  end

  # mIRC sort: ops (@) → voiced (+) → plain (no prefix). Within tier,
  # alphabetical by nick (caller `Enum.sort_by` does the secondary).
  defp member_sort_tier(modes) do
    cond do
      "@" in modes -> 0
      "+" in modes -> 1
      true -> 2
    end
  end

  @doc false
  # Cancel `ref` and consume its message from the mailbox if it had already
  # fired. `Process.cancel_timer/1` returns `false` when the timer has
  # already delivered its message — without a follow-up selective receive,
  # that stale message sits in the mailbox and runs the next time the
  # GenServer dispatches, racing whatever fresh state was set up after the
  # cancel call (lifecycle review HIGH S3).
  #
  # Public-with-`@doc false` so unit tests can exercise the primitive
  # directly: every call site (auto-away debounce, pending-auth timeout,
  # ghost-recovery timeout) shares this exact shape and the only way to
  # cover the post-fire branch deterministically is to drive a real timer
  # from the test process.
  # REV-J M8: pre-fix the drain was a single-shot `receive ... after 0`
  # which assumed an invariant — "at most one stale message of each
  # kind in the mailbox at a time" — that was only as strong as the
  # call sites enforcing it. A future handler that armed a fresh timer
  # without canceling the prior ref could queue two `:auto_away_debounce_fire`
  # messages; the single-shot drain would leak one. Constant overhead
  # in the steady state (queue empty), zero correctness obligation on
  # call sites.
  @spec cancel_and_drain(reference() | nil, atom()) :: :ok
  def cancel_and_drain(nil, _), do: :ok

  def cancel_and_drain(ref, msg) when is_reference(ref) and is_atom(msg) do
    case Process.cancel_timer(ref) do
      ms_left when is_integer(ms_left) ->
        :ok

      false ->
        drain_all(msg)
    end
  end

  defp drain_all(msg) do
    receive do
      ^msg -> drain_all(msg)
    after
      0 -> :ok
    end
  end

  # ---------------------------------------------------------------------------
  # S5.1 — ISUPPORT MODES= extraction
  # ---------------------------------------------------------------------------

  @doc """
  The default max-modes-per-chunk when upstream omits MODES= from ISUPPORT.
  IRCv3 spec and RFC 2812 §3.2.3 both cite 3 as the de-facto minimum; all
  major IRCds (bahamut, ircd-seven, UnrealIRCd) default to at least 3.
  """
  @spec default_modes_per_chunk() :: 3
  def default_modes_per_chunk, do: 3

  # ---------------------------------------------------------------------------
  # S5.2 — ops verb private helpers
  # ---------------------------------------------------------------------------

  # Sends one or more MODE lines for chunked verbs (/op /deop /voice /devoice
  # /ban /unban). Delegates splitting to ModeChunker.chunk/3, then flushes each
  # chunk as a separate MODE line through the Client socket.
  #
  # REV-E (H11): walks chunks one at a time and halts on the first
  # `{:error, _}` from `Client.send_line/2`. Returns the error from the
  # failed chunk so the caller (Session.send_op/4 et al.) can surface it.
  # Pre-fix this strict-bound `:ok =` on each chunk, which post-U-cluster
  # MatchError'd on a dead socket. Idempotency note: a partial chunk flush
  # (chunk 0 succeeded, chunk 1 failed mid-burst) leaves the upstream
  # state ambiguous, but the dead-socket case ends with NO chunks landing
  # on the wire anyway (transport returns `:no_socket` before bytes go
  # out). Per-chunk wire failures (`:closed`, `:einval`) are observable
  # post-fact; the inbound MODE echo via EventRouter is the source of
  # truth for the actual mode state.
  @spec send_chunked_mode(t(), String.t(), String.t(), [String.t()]) ::
          {:reply, :ok | {:error, atom()}, t()}
  defp send_chunked_mode(state, channel, mode_str, params) do
    chunks = ModeChunker.chunk(mode_str, params, state.modes_per_chunk)
    {:reply, flush_mode_chunks(state.client, channel, chunks), state}
  end

  @spec flush_mode_chunks(pid(), String.t(), [{String.t(), [String.t()]}]) ::
          :ok | {:error, atom()}
  defp flush_mode_chunks(_, _, []), do: :ok

  defp flush_mode_chunks(client, channel, [{modes, chunk_params} | rest]) do
    line =
      case chunk_params do
        [] -> "MODE #{channel} #{modes}\r\n"
        _ -> "MODE #{channel} #{modes} #{Enum.join(chunk_params, " ")}\r\n"
      end

    case Client.send_line(client, line) do
      :ok ->
        flush_mode_chunks(client, channel, rest)

      {:error, _} = err ->
        err
    end
  end

  # Derives a ban mask from a bare nick or passes an explicit mask through.
  # A bare nick (no `!` or `@`) is looked up in the userhost_cache:
  #   - Cache hit → `*!*@host` (host-ban; preferred for stickiness).
  #   - Cache miss → `nick!*@*` (nick-ban fallback).
  # An explicit mask (contains `!` or `@` or `*`) passes through unchanged.
  @spec derive_ban_mask(String.t(), t()) :: String.t()
  defp derive_ban_mask(mask_or_nick, state) do
    if String.contains?(mask_or_nick, ["!", "@", "*"]) do
      # Looks like an explicit mask — pass through verbatim.
      mask_or_nick
    else
      # Bare nick — attempt userhost_cache lookup.
      nick_key = String.downcase(mask_or_nick)

      case Map.get(state.userhost_cache, nick_key) do
        %{host: host} when is_binary(host) -> "*!*@#{host}"
        _ -> "#{mask_or_nick}!*@*"
      end
    end
  end

  # Scans 005 RPL_ISUPPORT params for a "MODES=N" token and returns N as
  # an integer. Returns the current value unchanged when no MODES= is found.
  # Silently ignores malformed tokens (e.g. "MODES=" with no number) — the
  # default is always a safe fallback.
  @spec extract_modes_isupport([String.t()], pos_integer()) :: pos_integer()
  defp extract_modes_isupport(params, current) when is_list(params) do
    Enum.reduce_while(params, current, &parse_modes_token/2)
  end

  @spec parse_modes_token(String.t(), pos_integer()) ::
          {:cont, pos_integer()} | {:halt, pos_integer()}
  defp parse_modes_token("MODES=" <> rest, _) do
    case Integer.parse(rest) do
      {n, ""} when n > 0 -> {:halt, n}
      _ -> {:cont, 3}
    end
  end

  defp parse_modes_token(_, acc), do: {:cont, acc}

  # BUGHUNT-1 A — Scans 005 RPL_ISUPPORT params for a "LINELEN=N" token
  # and returns N as an integer. Returns the current value unchanged
  # when no LINELEN= is found (default 512 per RFC 2812). Silently
  # ignores malformed tokens (e.g. "LINELEN=0" or "LINELEN=" with no
  # number) — the prior value is always a safe fallback.
  @spec extract_linelen_isupport([String.t()], pos_integer()) :: pos_integer()
  defp extract_linelen_isupport(params, current) when is_list(params) do
    Enum.reduce_while(params, current, &parse_linelen_token/2)
  end

  @spec parse_linelen_token(String.t(), pos_integer()) ::
          {:cont, pos_integer()} | {:halt, pos_integer()}
  defp parse_linelen_token("LINELEN=" <> rest, current) do
    case Integer.parse(rest) do
      {n, ""} when n > 0 -> {:halt, n}
      _ -> {:cont, current}
    end
  end

  defp parse_linelen_token(_, acc), do: {:cont, acc}

  # ---------------------------------------------------------------------------
  # S3.2 — away state internal helpers
  # ---------------------------------------------------------------------------

  # Set explicit away: unconditional, always wins. Issues `AWAY :<reason>`
  # upstream. The `AwayState` mutator records started_at + reason so
  # Mentions aggregation (S3.5) has the precise window.
  #
  # S4.2: `label` is a UUID string when labeled-response cap is active;
  # `nil` otherwise. When non-nil, the AWAY line is prefixed with `@label=<uuid>`
  # so the upstream echoes it back on the 305/306 numeric reply.
  @spec set_explicit_away_internal(t(), String.t(), String.t() | nil) :: t()
  defp set_explicit_away_internal(state, reason, nil) when is_binary(reason) do
    maybe_log_send_failure("set_explicit_away", Client.send_away(state.client, reason))
    %{state | away_state: AwayState.set_explicit_away(state.away_state, reason)}
  end

  defp set_explicit_away_internal(state, reason, label)
       when is_binary(reason) and is_binary(label) do
    maybe_log_send_failure(
      "set_explicit_away_labeled",
      Client.send_line(state.client, "@label=#{label} AWAY :#{reason}\r\n")
    )

    %{state | away_state: AwayState.set_explicit_away(state.away_state, reason)}
  end

  # Set auto-away: only when not already `:away_explicit` (caller guards).
  # Issues `AWAY :<auto_away_reason>` upstream. The constant is fixed
  # wire protocol — see `AwayState.auto_away_reason/0`.
  @spec set_auto_away_internal(t()) :: t()
  defp set_auto_away_internal(state) do
    maybe_log_send_failure(
      "set_auto_away",
      Client.send_away(state.client, AwayState.auto_away_reason())
    )

    %{state | away_state: AwayState.set_auto_away(state.away_state)}
  end

  # Clear any active away state (explicit or auto). Issues bare `AWAY` upstream
  # to clear the status. Resets all away fields to idle defaults via the
  # `AwayState.unset_away/1` mutator.
  #
  # C8: before clearing the away window, aggregate mentions for user sessions
  # (not visitors — they have no persisted scrollback) and broadcast a
  # `mentions_bundle` event on the user-level PubSub topic when matches exist.
  # The broadcast fires on BOTH explicit-away and auto-away cancel paths since
  # both ultimately call this helper. Zero-match result suppresses the broadcast
  # (no empty-window noise per spec #19). The broadcast must read away metadata
  # BEFORE the unset mutator clears it.
  #
  # S4.2: `label` is a UUID string when labeled-response cap is active;
  # `nil` otherwise.
  @spec unset_away_internal(t(), String.t() | nil) :: t()
  defp unset_away_internal(state, nil) do
    maybe_log_send_failure("unset_away", Client.send_away_unset(state.client))
    maybe_broadcast_mentions_bundle(state)
    %{state | away_state: AwayState.unset_away(state.away_state)}
  end

  defp unset_away_internal(state, label) when is_binary(label) do
    maybe_log_send_failure(
      "unset_away_labeled",
      Client.send_line(state.client, "@label=#{label} AWAY\r\n")
    )

    maybe_broadcast_mentions_bundle(state)
    %{state | away_state: AwayState.unset_away(state.away_state)}
  end

  # REV-E (H11): single fire-and-forget Logger helper for AWAY-internal
  # send paths. Pre-fix each call site strict-bound `:ok =` and
  # MatchError-crashed on dead socket. Local AwayState mutation still
  # happens for the LIVE process (so the cic `away_confirmed` broadcast
  # fires + Mentions aggregation tracks the window), but a Session
  # crash + supervisor restart wipes AwayState (no DB persistence, no
  # Registry handoff at init/1) — the operator's `/away` is effectively
  # lost on the next reconnect.
  #
  # That's acceptable per "Log honesty": the Logger.warning is the
  # honest signal that the wire write didn't land; the operator can
  # observe the failure and re-issue `/away` post-reconnect (a UX-7-ish
  # follow-up could surface a "your AWAY was lost on reconnect" hint
  # via the same channel that posts the bundle-refresh banner, but it's
  # out of REV-E scope). Error narrowed to `atom()` to mirror
  # IRC.Client's success-typed send_result (`:invalid_line | :no_socket
  # | :closed | :inet.posix()` — all atoms; Dialyzer flagged the wider
  # `term()` as supertype).
  @spec maybe_log_send_failure(String.t(), :ok | {:error, atom()}) :: :ok
  defp maybe_log_send_failure(_, :ok), do: :ok

  defp maybe_log_send_failure(label, {:error, reason}) do
    Logger.warning("#{label}: Client.send failed",
      reason: inspect(reason)
    )
  end

  # C8: aggregate mentions during the away interval and broadcast
  # `mentions_bundle` on the user-level PubSub topic when matches exist.
  # Only runs for user sessions (not visitors); silently skips when
  # `started_at` is nil (present state — should not happen in normal flow
  # but guards against double-unset edge cases).
  @spec maybe_broadcast_mentions_bundle(t()) :: :ok
  defp maybe_broadcast_mentions_bundle(%{subject: {:user, user_id}} = state)
       when is_binary(user_id) do
    case AwayState.started_at(state.away_state) do
      nil ->
        :ok

      started_at ->
        away_start_ms = DateTime.to_unix(started_at, :millisecond)
        away_end_ms = System.system_time(:millisecond)
        watchlist = UserSettings.get_highlight_patterns({:user, user_id})

        messages =
          Mentions.aggregate_mentions(
            user_id,
            state.network_id,
            away_start_ms,
            away_end_ms,
            watchlist,
            state.nick
          )

        if messages != [] do
          away_started_iso = DateTime.to_iso8601(started_at)
          away_ended_iso = DateTime.to_iso8601(DateTime.utc_now())

          :ok =
            Grappa.PubSub.broadcast_event(
              Topic.user(state.subject_label),
              SessionWire.mentions_bundle(
                state.network_slug,
                away_started_iso,
                away_ended_iso,
                AwayState.reason(state.away_state),
                messages
              )
            )
        end

        :ok
    end
  end

  defp maybe_broadcast_mentions_bundle(_), do: :ok
end
