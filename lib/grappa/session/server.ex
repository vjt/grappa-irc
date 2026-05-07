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

  Trade-off: a `:transient` restart replays the SAME cached opts
  the supervisor child spec captured at first start — credential
  changes in the DB don't propagate until the operator forces a
  re-spawn through the LIVE BEAM (via `bin/grappa rpc` calling
  into `Credentials.unbind_credential/2`, NOT bare
  `mix grappa.unbind_network` which runs in a separate BEAM and
  cannot reach the prod registry) or the next deploy. Full
  rationale on `Grappa.Session` moduledoc; Phase 5 may add
  `Session.refresh/2` if hot-reload is needed.

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

  alias Grappa.IRC.{AuthFSM, Client, Message}
  alias Grappa.{Log, Mentions, Scrollback, Session, UserSettings}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Wire
  alias Grappa.Session.{Backoff, EventRouter, GhostRecovery, ModeChunker, NSInterceptor, NumericRouter}

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

  @typedoc """
  Away state — closed set tracking whether the user is present, manually away
  (via `/away :reason` slash command), or automatically away (web client
  disconnected + 30s debounce elapsed).

  Precedence rule (S3.2): `set_auto_away` is a no-op if state is `:away_explicit`.
  `set_explicit_away` always wins and overwrites any prior auto-away. Both
  `unset_*` verbs are no-ops unless called on the matching state.
  """
  @type away_state :: :present | :away_explicit | :away_auto

  # The auto-away reason string is fixed and documented. Changing it would
  # invalidate any client-side text matching; treat it as a protocol constant.
  @auto_away_reason "auto-away (web client disconnected)"

  # 30-second debounce before issuing AWAY after all WS connections drop.
  # Gives the user time to open a new tab without going away.
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
  Per-channel window state (CP15 — event-driven windows). The Session
  Server is the single source of truth; cic projects from broadcast
  events on the per-channel topic.

  - `:joined` — own-nick JOIN echo received (B1).
  - `:failed` — server replied with a join failure numeric (B2).
  - `:kicked` — own-nick was the target of a KICK (B3).
  - `:parted` — currently unused (PART removes the entry entirely; cic
    derives `:archived` from absence + scrollback presence via B4 archive
    surface).
  - `:parked` — T32 disconnect/connect: connection is intentionally idle
    (B3 wires the broadcast).
  - `:pending` — currently implicit (no entry while a JOIN is in flight);
    B2 may promote to an explicit value when the in-flight map lands.

  Map key is the channel string, case-preserved like `state.members`;
  read sites normalize via `String.downcase/1` when correlating against
  IRC's case-insensitive RFC 2812 §2.2 comparisons.
  """
  @type window_state :: :pending | :joined | :failed | :kicked | :parked

  @typedoc """
  In-flight JOIN tracking entry (CP15 B2). Recorded on every outbound
  JOIN — both cic-initiated `Session.send_join/3` casts and the 001
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
          optional(:notify_pid) => pid(),
          optional(:notify_ref) => reference(),
          optional(:visitor_committer) => visitor_committer(),
          optional(:credential_failer) => credential_failer()
        }

  @type state :: %{
          subject: Grappa.Session.subject(),
          subject_label: String.t(),
          network_id: integer(),
          network_slug: String.t(),
          nick: String.t(),
          members: %{String.t() => %{String.t() => [String.t()]}},
          topics: %{String.t() => EventRouter.topic_entry()},
          channel_modes: %{String.t() => EventRouter.channel_mode_entry()},
          userhost_cache: EventRouter.userhost_cache(),
          # CP15 B1: per-channel window state. Sibling to `members` —
          # identical lifetime + supervision (in-process map, derived on
          # boot from autojoin's natural transition flow per Q5; no
          # persistence). Self-JOIN echo writes :joined; B2 adds :failed,
          # B3 adds :kicked / :parted / :parked. Absence = :pending while
          # an autojoin is in flight; absence after PART = :archived
          # (derived externally by cic from the archive surface, B4).
          window_states: %{String.t() => window_state()},
          # CP15 B2: per-channel failure reason for windows in :failed state
          # (471/473/474/475/403/405). Sibling to `window_states`, separate
          # map because the reason is text and only present for failures —
          # mixing it into the atom-valued window_states map would force a
          # tagged tuple. Cleared when the channel transitions out of
          # :failed (next successful JOIN, /part, etc.).
          window_failure_reasons: %{String.t() => String.t()},
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
          credential_failer: credential_failer() | nil,
          ghost_recovery: GhostRecovery.t() | nil,
          ghost_timer: reference() | nil,
          away_state: away_state(),
          away_started_at: DateTime.t() | nil,
          away_reason: String.t() | nil,
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
          modes_per_chunk: pos_integer()
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
      topics: %{},
      channel_modes: %{},
      userhost_cache: %{},
      window_states: %{},
      window_failure_reasons: %{},
      in_flight_joins: %{},
      autojoin: opts.autojoin_channels,
      client: nil,
      notify_pid: Map.get(opts, :notify_pid),
      notify_ref: Map.get(opts, :notify_ref),
      pending_auth: nil,
      pending_auth_timer: nil,
      pending_password: pending_password_from_opts(opts),
      visitor_committer: Map.get(opts, :visitor_committer),
      credential_failer: Map.get(opts, :credential_failer),
      ghost_recovery: nil,
      ghost_timer: nil,
      away_state: :present,
      away_started_at: nil,
      away_reason: nil,
      auto_away_timer: nil,
      caps_active: MapSet.new(),
      labels_pending: %{},
      last_command_window: nil,
      modes_per_chunk: 3
    }

    # S3.1 / S3.2: subscribe to the WSPresence PubSub topic for this user so
    # auto-away debounce and cancel fire on WS connect/disconnect events.
    # Only user sessions (not visitor sessions) participate in auto-away;
    # visitor disconnect = bouncer disconnect (ephemeral credential).
    if match?({:user, _}, opts.subject) do
      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          "grappa:ws_presence:#{opts.subject_label}"
        )
    end

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
        # hammer pattern as a connect-fail loop. Bumps the same
        # counter the EXIT-path bumps.
        :ok = Backoff.record_failure(state.subject, state.network_id)
        {:stop, {:client_start_failed, reason}, state}
    end
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

  # Sets the topic on `channel` upstream AND persists a `:topic`
  # scrollback row + broadcasts to the per-channel PubSub topic — same
  # atomic-from-caller's-view shape as `:send_privmsg`. Symmetric with
  # how the operator's own outbound TOPIC should appear in their own
  # scrollback view alongside everyone else's.
  def handle_call({:send_topic, channel, body}, _, state)
      when is_binary(channel) and is_binary(body) do
    attrs =
      Session.put_subject_id(
        %{
          network_id: state.network_id,
          channel: channel,
          server_time: System.system_time(:millisecond),
          kind: :topic,
          sender: state.nick,
          body: body,
          meta: %{}
        },
        state.subject
      )

    case Scrollback.persist_event(attrs) do
      {:ok, message} ->
        :ok =
          Grappa.PubSub.broadcast_event(
            Topic.channel(state.subject_label, state.network_slug, channel),
            Wire.message_payload(message)
          )

        case Client.send_topic(state.client, channel, body) do
          :ok ->
            {:reply, {:ok, message}, state}

          {:error, :invalid_line} = err ->
            Logger.error("client rejected topic AFTER persist — facade bypass?",
              channel: channel
            )

            {:reply, err, state}
        end

      {:error, _} = err ->
        {:reply, err, state}
    end
  end

  # Sends `NICK <new>` upstream. No scrollback row written here — the
  # upstream replays the NICK back; EventRouter's NICK handler then
  # reconciles `state.nick` (state.nick == old_nick path) and emits the
  # per-channel `:nick_change` persist effects.
  #
  # S4.3: the origin_window variant updates last_command_window so
  # 432/433/437 NICK-error numerics route back to the right window.
  # S4.2: if labeled-response is active, prepend @label= tag to the
  # NICK line so the numeric response echoes the label back.
  def handle_call({:send_nick, new_nick, origin_window}, _, state) when is_binary(new_nick) do
    {label, next_state} = prepare_label(state, origin_window)

    result =
      if is_nil(label) do
        Client.send_nick(next_state.client, new_nick)
      else
        # labeled-response active: inject tag prefix. Nick validation is skipped
        # here because the label prefix must wrap the full line; Client.send_line
        # is the raw path. The Session facade pre-validates the nick before this
        # handler fires (Identifier.valid_nick? check in Session.send_nick/4).
        Client.send_line(next_state.client, [label_tag(label), "NICK #{new_nick}\r\n"])
      end

    case result do
      :ok -> {:reply, :ok, next_state}
      {:error, _} = err -> {:reply, err, next_state}
    end
  end

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
    :ok = Client.send_line(state.client, "KICK #{channel} #{nick} :#{reason}\r\n")
    {:reply, :ok, state}
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
    :ok = Client.send_line(state.client, "INVITE #{nick} #{channel}\r\n")
    {:reply, :ok, state}
  end

  # Banlist query form — no sign, just the mode letter.
  def handle_call({:send_banlist, channel}, _, state) when is_binary(channel) do
    :ok = Client.send_line(state.client, "MODE #{channel} b\r\n")
    {:reply, :ok, state}
  end

  # User-mode change on own nick. Uses state.nick (reconciled at 001).
  def handle_call({:send_umode, modes}, _, state) when is_binary(modes) do
    :ok = Client.send_line(state.client, "MODE #{state.nick} #{modes}\r\n")
    {:reply, :ok, state}
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

    :ok = Client.send_line(state.client, line)
    {:reply, :ok, state}
  end

  # S5.4: irssi-convention topic clear — sends `TOPIC #chan :` (empty trailing).
  # This clears the channel topic on servers that honour RFC 2812 §3.2.4:
  # an empty trailing parameter signals "no topic". The inbound TOPIC event
  # that the server echoes back will update the topic cache via EventRouter.
  def handle_call({:send_topic_clear, channel}, _, state) when is_binary(channel) do
    :ok = Client.send_line(state.client, "TOPIC #{channel} :\r\n")
    {:reply, :ok, state}
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
  def handle_call({:unset_explicit_away, origin_window}, _, %{away_state: :away_explicit} = state) do
    {label, next_state} = prepare_label(state, origin_window)
    final_state = unset_away_internal(next_state, label)
    {:reply, :ok, final_state}
  end

  def handle_call({:unset_explicit_away, origin_window}, _, state) do
    # Not currently away_explicit — no-op, but still update last_command_window.
    {_, next_state} = prepare_label(state, origin_window)
    {:reply, {:error, :not_explicit}, next_state}
  end

  def handle_call({:unset_explicit_away}, _, %{away_state: :away_explicit} = state) do
    next_state = unset_away_internal(state, nil)
    {:reply, :ok, next_state}
  end

  def handle_call({:unset_explicit_away}, _, state) do
    {:reply, {:error, :not_explicit}, state}
  end

  # S3.2: auto-away set — driven by the WSPresence debounce. No-op when
  # `:away_explicit` (explicit takes precedence). Otherwise issues `AWAY
  # :@auto_away_reason` upstream and transitions to `:away_auto`.
  def handle_call({:set_auto_away}, _, %{away_state: :away_explicit} = state) do
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
  def handle_call({:unset_auto_away}, _, %{away_state: :away_auto} = state) do
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
  """
  def handle_call({:list_members, channel}, _, state) when is_binary(channel) do
    members =
      state.members
      |> Map.get(channel, %{})
      |> Enum.map(fn {nick, modes} -> %{nick: nick, modes: modes} end)
      |> Enum.sort_by(&{member_sort_tier(&1.modes), &1.nick})

    {:reply, {:ok, members}, state}
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
  def handle_cast({:send_join, channel}, state) when is_binary(channel) do
    :ok = Client.send_join(state.client, channel)
    {:noreply, record_in_flight_join(state, channel)}
  end

  def handle_cast({:send_part, channel}, state) when is_binary(channel) do
    :ok = Client.send_part(state.client, channel)
    {:noreply, state}
  end

  # Deferred Client.start_link/1 from `handle_continue({:start_client, _}, _)`'s
  # backoff branch. Pairs with the Backoff lookup at start: when the
  # delay timer fires, do the actual start. Same `do_start_client/2`
  # path so the `:client_start_failed` shape is identical.
  @impl GenServer
  def handle_info({:start_client_after_backoff, client_opts}, state) do
    do_start_client(client_opts, state)
  end

  # S3.2 — WS reconnect: a new browser tab opened for this user. Cancel
  # any pending auto-away debounce timer and (if currently :away_auto)
  # unset auto-away. Explicit away is left untouched — reconnecting a tab
  # should not silently clear a `/away` the user issued deliberately.
  def handle_info({:ws_connected, _}, state) do
    state1 =
      if is_reference(state.auto_away_timer) do
        _ = Process.cancel_timer(state.auto_away_timer)
        %{state | auto_away_timer: nil}
      else
        state
      end

    state2 =
      if state1.away_state == :away_auto do
        unset_away_internal(state1, nil)
      else
        state1
      end

    {:noreply, state2}
  end

  # S3.2 — WS disconnect: the last browser tab for this user closed.
  # Schedule the 30s debounce before issuing auto-away. If already
  # `:away_explicit`, skip entirely — the user intentionally went away.
  def handle_info({:ws_all_disconnected, _}, %{away_state: :away_explicit} = state) do
    {:noreply, state}
  end

  def handle_info({:ws_all_disconnected, _}, state) do
    # Cancel any existing debounce timer (shouldn't happen in normal flow,
    # but guards against two rapid disconnect events — only the last wins).
    _ =
      if is_reference(state.auto_away_timer) do
        Process.cancel_timer(state.auto_away_timer)
      end

    timer = Process.send_after(self(), :auto_away_debounce_fire, @auto_away_debounce_ms)
    {:noreply, %{state | auto_away_timer: timer}}
  end

  # S3.2 — Auto-away debounce fired. If still `:away_explicit`, skip (user
  # may have issued `/away` in the window between disconnect and fire).
  # Otherwise issue the upstream AWAY and transition to `:away_auto`.
  def handle_info(:auto_away_debounce_fire, %{away_state: :away_explicit} = state) do
    {:noreply, %{state | auto_away_timer: nil}}
  end

  def handle_info(:auto_away_debounce_fire, state) do
    next_state = state |> Map.put(:auto_away_timer, nil) |> set_auto_away_internal()
    {:noreply, next_state}
  end

  # Linked Client crashed. Record a backoff failure (so the next
  # respawn waits longer) then propagate the stop. The Backoff cast is
  # asynchronous; the GenServer.cast doesn't block this stop, but the
  # `Backoff` GenServer's mailbox processes it before our respawned
  # init/1 re-reads `wait_ms/2` (the supervisor's restart path is not
  # instant — it runs after this terminate completes).
  def handle_info({:EXIT, client_pid, reason}, %{client: client_pid} = state)
      when client_pid != nil do
    :ok = Backoff.record_failure(state.subject, state.network_id)
    {:stop, {:client_exit, reason}, %{state | client: nil}}
  end

  # Supervisor-issued shutdown — propagate without recording a failure
  # (operator/Bootstrap-driven, not a crash). GenServer's default would
  # do the same; explicit clause for clarity + so the Logger.warning
  # catchall below doesn't fire.
  def handle_info({:EXIT, _, reason}, state)
      when reason == :shutdown or reason == :normal do
    {:stop, reason, state}
  end

  def handle_info({:irc, %Message{command: :ping, params: [token | _]}}, state) do
    :ok = Client.send_pong(state.client, token)
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
        case Client.send_join(acc.client, channel) do
          :ok ->
            record_in_flight_join(acc, channel)

          {:error, :invalid_line} ->
            Logger.warning("autojoin skipped: invalid channel name", channel: inspect(channel))
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

  # S5.1 — 005 RPL_ISUPPORT: extract MODES=N if advertised. Params are space-
  # separated ISUPPORT tokens (e.g. ["grappa-test", "MODES=4", "CHANTYPES=#",
  # "are supported ..."]).  We scan every param for a "MODES=" prefix and parse
  # the integer. The default of 3 is preserved when MODES= is absent.  Only
  # the first MODES= token is honoured (ircd should emit at most one per 005
  # line; multiple 005 lines are additive but MODES= is idempotent — use the
  # first advertised value and ignore later ones to avoid a misbehaving server
  # downgrading us mid-session).
  def handle_info(
        {:irc, %Message{command: {:numeric, 5}} = msg},
        state
      ) do
    modes_per_chunk = extract_modes_isupport(msg.params, state.modes_per_chunk)
    {:noreply, %{state | modes_per_chunk: modes_per_chunk}}
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
        final_state = apply_effects(effects, next_state)
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
  # Visitor sessions carry no credential_failer (ephemeral credential,
  # no connection_state column) — the nil guard is intentional.
  #
  # `{:stop, :normal, state}` causes the `:transient` restart strategy
  # to NOT respawn: `:transient` only restarts on ABNORMAL exits.
  @spec handle_terminal_failure(String.t(), state()) :: {:stop, :normal, state()}
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

  # *Serv suffix is the universal IRC services nick convention
  # (NickServ / ChanServ / MemoServ / OperServ / BotServ / HostServ /
  # HelpServ). Any PRIVMSG to one is a credential or control command,
  # not a chat message — never persist body to scrollback (cleartext
  # password leak, W12) and never broadcast over PubSub (other tabs
  # of the same user shouldn't see the password). Generic rule, not
  # NSInterceptor-specific: NSInterceptor's regex matches NickServ
  # only; this scrollback skip is broader.
  defp service_target?(target) when is_binary(target) do
    target |> String.downcase() |> String.ends_with?("serv")
  end

  # Existing behavior — persist scrollback row, broadcast on per-channel
  # PubSub topic, send the wire line. Reply carries the persisted row.
  # Symmetric with the pre-S9 send_privmsg body.
  defp handle_persisting_send(target, body, state) do
    attrs =
      Session.put_subject_id(
        %{
          network_id: state.network_id,
          channel: target,
          server_time: System.system_time(:millisecond),
          kind: :privmsg,
          sender: state.nick,
          body: body,
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

    case Scrollback.persist_event(attrs) do
      {:ok, message} ->
        :ok =
          Grappa.PubSub.broadcast_event(
            Topic.channel(state.subject_label, state.network_slug, target),
            Wire.message_payload(message)
          )

        # `Client.send_privmsg` returns `:ok | {:error, :invalid_line}`
        # since S29 C1. The Session facade pre-validates so the error
        # branch is unreachable on the documented path; the case below
        # is forward-compat insurance against a future caller that
        # bypasses the facade.
        case Client.send_privmsg(state.client, target, body) do
          :ok ->
            {:reply, {:ok, message}, state}

          {:error, :invalid_line} = err ->
            Logger.error("client rejected privmsg AFTER persist — facade bypass?",
              channel: target
            )

            {:reply, err, state}
        end

      {:error, _} = err ->
        {:reply, err, state}
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
  @spec maybe_stage_pending_password(state()) :: state()
  defp maybe_stage_pending_password(%{pending_password: nil} = state), do: state

  defp maybe_stage_pending_password(%{pending_password: pwd} = state)
       when is_binary(pwd) do
    state
    |> stage_pending_auth(pwd)
    |> Map.put(:pending_password, nil)
  end

  defp stage_pending_auth(state, password) do
    _ =
      if is_reference(state.pending_auth_timer) do
        Process.cancel_timer(state.pending_auth_timer)
      end

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
        _ =
          if is_reference(state.ghost_timer) do
            Process.cancel_timer(state.ghost_timer)
          end

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

      :ok = Client.send_line(acc.client, line)
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
  @spec prepare_label(state(), window_ref() | nil) :: {String.t() | nil, state()}
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

  # Formats the IRCv3 message-tag prefix for a label. Returns "" when label is nil.
  @spec label_tag(String.t() | nil) :: String.t()
  defp label_tag(nil), do: ""
  defp label_tag(label) when is_binary(label), do: "@label=#{label} "

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
  @spec delegate(Message.t(), state()) :: {:noreply, state()}
  defp delegate(msg, state) do
    {:cont, derived_state, effects} = EventRouter.route(msg, state)
    next_state = apply_effects(effects, derived_state)
    maybe_broadcast_channels_changed(state, next_state)
    maybe_broadcast_own_nick_changed(state, next_state)
    {:noreply, next_state}
  end

  @spec maybe_broadcast_channels_changed(state(), state()) :: :ok
  defp maybe_broadcast_channels_changed(prev, next) do
    prev_keys = prev.members |> Map.keys() |> Enum.sort()
    next_keys = next.members |> Map.keys() |> Enum.sort()

    if prev_keys != next_keys do
      :ok =
        Grappa.PubSub.broadcast_event(
          Topic.user(prev.subject_label),
          %{kind: "channels_changed"}
        )
    end

    :ok
  end

  # Broadcasts `own_nick_changed` on the user-level PubSub topic when the
  # live IRC nick changes (NICK event, 001 RPL_WELCOME nick reconciliation).
  # Cicchetto's userTopic handler updates the per-network nick in the
  # networks store, which triggers reactive re-subscription to the correct
  # own-nick DM topic. Without this broadcast, cicchetto subscribes to the
  # CREDENTIAL nick (e.g. "grappa") while the live nick is "vjt-grappa" —
  # inbound DMs are silently dropped.
  @spec maybe_broadcast_own_nick_changed(state(), state()) :: :ok
  defp maybe_broadcast_own_nick_changed(%{nick: prev_nick}, %{nick: next_nick} = next_state)
       when prev_nick != next_nick do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(next_state.subject_label),
        %{
          kind: "own_nick_changed",
          network_id: next_state.network_id,
          nick: next_nick
        }
      )
  end

  defp maybe_broadcast_own_nick_changed(_, _), do: :ok

  @spec apply_effects([EventRouter.effect()], state()) :: state()
  defp apply_effects([], state), do: state

  defp apply_effects([{:topic_changed, channel, entry} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.channel(state.subject_label, state.network_slug, channel),
        %{
          kind: "topic_changed",
          network: state.network_slug,
          channel: channel,
          topic: entry
        }
      )

    apply_effects(rest, state)
  end

  defp apply_effects([{:channel_modes_changed, channel, entry} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.channel(state.subject_label, state.network_slug, channel),
        %{
          kind: "channel_modes_changed",
          network: state.network_slug,
          channel: channel,
          modes: entry
        }
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

    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.channel(state.subject_label, state.network_slug, channel),
        %{
          kind: "members_seeded",
          network: state.network_slug,
          channel: channel,
          members: members
        }
      )

    apply_effects(rest, state)
  end

  # CP15 B1: own-nick JOIN echo received → window transitions to :joined.
  # Updates the in-process window_states map AND broadcasts on the
  # per-channel topic so cic flips render state without polling. Cic
  # subscribes via the same per-channel topic that already carries
  # `members_seeded` + persisted-row events; no new transport.
  defp apply_effects([{:joined, channel} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.channel(state.subject_label, state.network_slug, channel),
        %{
          kind: "joined",
          network: state.network_slug,
          channel: channel,
          state: "joined"
        }
      )

    state = %{state | window_states: Map.put(state.window_states, channel, :joined)}
    apply_effects(rest, state)
  end

  # CP15 B2: JOIN failure numeric (471/473/474/475/403/405) correlated
  # against an in-flight JOIN. Three concerns, one arm:
  #   1. State — window_states[channel] = :failed, window_failure_reasons
  #      records the human-readable reason. Cic projects from these via
  #      the typed broadcast below; the maps are also the source of truth
  #      for any future REST snapshot fetch.
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
      {:ok, _} ->
        :ok

      {:error, changeset} ->
        Logger.error("scrollback insert failed for join_failed",
          channel: channel,
          numeric: numeric,
          error: inspect(changeset.errors)
        )
    end

    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.channel(state.subject_label, state.network_slug, channel),
        %{
          kind: "join_failed",
          network: state.network_slug,
          channel: channel,
          state: "failed",
          reason: reason,
          numeric: numeric
        }
      )

    state = %{
      state
      | window_states: Map.put(state.window_states, channel, :failed),
        window_failure_reasons: Map.put(state.window_failure_reasons, channel, reason)
    }

    apply_effects(rest, state)
  end

  # CP15 B3: own-PART acked by upstream → window archived. Drops the
  # per-channel window_states entry entirely; cic projects "no key +
  # scrollback present" as `:archived`. The :persist :part row that
  # ships alongside in the same effects list is the UI feed-line —
  # there is intentionally NO `kind: "parted"` broadcast (absence is
  # the signal). Also clears any lingering window_failure_reasons entry
  # so a re-join + re-fail cycle gets a fresh reason.
  defp apply_effects([{:parted, channel} | rest], state) do
    state = %{
      state
      | window_states: Map.delete(state.window_states, channel),
        window_failure_reasons: Map.delete(state.window_failure_reasons, channel)
    }

    apply_effects(rest, state)
  end

  # CP15 B3: own-target KICK → window transitions to :kicked. Two
  # concerns, one arm:
  #   1. State — window_states[channel] = :kicked. The window stays in
  #      the active sidebar (greyed) so the operator can /join to retry;
  #      archiving on KICK would punish the victim.
  #   2. Event broadcast — typed `kind: "kicked"` payload on the
  #      per-channel topic carrying `by` + `reason` so cic can render the
  #      kick reason banner without parsing the scrollback row. The
  #      :persist :kick row alongside is the audit trail.
  defp apply_effects([{:kicked, channel, by, reason} | rest], state) do
    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.channel(state.subject_label, state.network_slug, channel),
        %{
          kind: "kicked",
          network: state.network_slug,
          channel: channel,
          state: "kicked",
          by: by,
          reason: reason
        }
      )

    state = %{state | window_states: Map.put(state.window_states, channel, :kicked)}
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
    :ok = Client.send_line(state.client, line)
    apply_effects(rest, state)
  end

  # S3.4: 305 RPL_UNAWAY / 306 RPL_NOWAWAY confirmed by the upstream.
  # Broadcast `{:event, %{kind: "away_confirmed", state: "present" | "away"}}`
  # on the user-level PubSub topic so cicchetto can update its status display.
  # The `:present` / `:away` atom is converted to a string discriminator to
  # match the `kind: STRING` JSON-wire convention used across all events.
  defp apply_effects([{:away_confirmed, away_atom} | rest], state)
       when away_atom in [:present, :away] do
    away_str = Atom.to_string(away_atom)

    :ok =
      Grappa.PubSub.broadcast_event(
        Topic.user(state.subject_label),
        %{
          kind: "away_confirmed",
          network: state.network_slug,
          state: away_str
        }
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

    _ =
      if is_reference(state.pending_auth_timer) do
        Process.cancel_timer(state.pending_auth_timer)
      end

    apply_effects(rest, %{state | pending_auth: nil, pending_auth_timer: nil})
  end

  # One-shot send + clear of the synchronous-login readiness signal
  # (Task 8). Pattern-matches both fields populated to avoid
  # half-state misuse — caller MUST set both opts together.
  @spec maybe_fire_notify(state()) :: state()
  defp maybe_fire_notify(%{notify_pid: pid, notify_ref: ref} = state)
       when is_pid(pid) and is_reference(ref) do
    send(pid, {:session_ready, ref})
    %{state | notify_pid: nil, notify_ref: nil}
  end

  defp maybe_fire_notify(state), do: state

  # CP15 B2: record an outbound JOIN as in-flight, keyed by lowercase
  # channel for case-insensitive correlation against failure-numeric
  # echoes (RFC 2812 §2.2). Both `Session.send_join/3` casts and the
  # 001 RPL_WELCOME autojoin loop call through here so the tracking
  # behavior is identical regardless of who initiated the JOIN.
  # Label is `nil` for now — labeled-response correlation lands later.
  #
  # Lazy O(1)-amortized TTL: every insert sweeps entries older than
  # @in_flight_join_ttl_ms first. Bounds the map under upstream silence
  # without a separate Process.send_after timer.
  @in_flight_join_ttl_ms 30_000

  @spec record_in_flight_join(state(), String.t()) :: state()
  defp record_in_flight_join(state, channel) when is_binary(channel) do
    now_ms = System.monotonic_time(:millisecond)
    cutoff = now_ms - @in_flight_join_ttl_ms

    swept =
      state.in_flight_joins
      |> Enum.reject(fn {_, {_, at_ms, _}} -> at_ms < cutoff end)
      |> Map.new()

    key = String.downcase(channel)
    entry = {channel, now_ms, nil}
    %{state | in_flight_joins: Map.put(swept, key, entry)}
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
  # Returns {:reply, :ok, state} — no state mutation occurs (MODE state updates
  # arrive as inbound MODE events processed by EventRouter).
  @spec send_chunked_mode(state(), String.t(), String.t(), [String.t()]) ::
          {:reply, :ok, state()}
  defp send_chunked_mode(state, channel, mode_str, params) do
    chunks = ModeChunker.chunk(mode_str, params, state.modes_per_chunk)

    Enum.each(chunks, fn {modes, chunk_params} ->
      line =
        case chunk_params do
          [] -> "MODE #{channel} #{modes}\r\n"
          _ -> "MODE #{channel} #{modes} #{Enum.join(chunk_params, " ")}\r\n"
        end

      :ok = Client.send_line(state.client, line)
    end)

    {:reply, :ok, state}
  end

  # Derives a ban mask from a bare nick or passes an explicit mask through.
  # A bare nick (no `!` or `@`) is looked up in the userhost_cache:
  #   - Cache hit → `*!*@host` (host-ban; preferred for stickiness).
  #   - Cache miss → `nick!*@*` (nick-ban fallback).
  # An explicit mask (contains `!` or `@` or `*`) passes through unchanged.
  @spec derive_ban_mask(String.t(), state()) :: String.t()
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

  # ---------------------------------------------------------------------------
  # S3.2 — away state internal helpers
  # ---------------------------------------------------------------------------

  # Set explicit away: unconditional, always wins. Issues `AWAY :<reason>`
  # upstream. Records `away_started_at` + `away_reason` so Mentions
  # aggregation (S3.5) has the precise window.
  #
  # S4.2: `label` is a UUID string when labeled-response cap is active;
  # `nil` otherwise. When non-nil, the AWAY line is prefixed with `@label=<uuid>`
  # so the upstream echoes it back on the 305/306 numeric reply.
  @spec set_explicit_away_internal(state(), String.t(), String.t() | nil) :: state()
  defp set_explicit_away_internal(state, reason, nil) when is_binary(reason) do
    :ok = Client.send_away(state.client, reason)

    %{
      state
      | away_state: :away_explicit,
        away_started_at: DateTime.utc_now(),
        away_reason: reason
    }
  end

  defp set_explicit_away_internal(state, reason, label)
       when is_binary(reason) and is_binary(label) do
    :ok = Client.send_line(state.client, "@label=#{label} AWAY :#{reason}\r\n")

    %{
      state
      | away_state: :away_explicit,
        away_started_at: DateTime.utc_now(),
        away_reason: reason
    }
  end

  # Set auto-away: only when not already `:away_explicit` (caller guards).
  # Issues `AWAY :@auto_away_reason` upstream. The constant is fixed
  # wire protocol — see `@auto_away_reason` docstring.
  @spec set_auto_away_internal(state()) :: state()
  defp set_auto_away_internal(state) do
    :ok = Client.send_away(state.client, @auto_away_reason)

    %{
      state
      | away_state: :away_auto,
        away_started_at: DateTime.utc_now(),
        away_reason: @auto_away_reason
    }
  end

  # Clear any active away state (explicit or auto). Issues bare `AWAY` upstream
  # to clear the status. Resets all away fields to idle defaults.
  #
  # C8: before clearing the away window, aggregate mentions for user sessions
  # (not visitors — they have no persisted scrollback) and broadcast a
  # `mentions_bundle` event on the user-level PubSub topic when matches exist.
  # The broadcast fires on BOTH explicit-away and auto-away cancel paths since
  # both ultimately call this helper. Zero-match result suppresses the broadcast
  # (no empty-window noise per spec #19).
  #
  # S4.2: `label` is a UUID string when labeled-response cap is active;
  # `nil` otherwise.
  @spec unset_away_internal(state(), String.t() | nil) :: state()
  defp unset_away_internal(state, nil) do
    :ok = Client.send_away_unset(state.client)
    maybe_broadcast_mentions_bundle(state)

    %{
      state
      | away_state: :present,
        away_started_at: nil,
        away_reason: nil
    }
  end

  defp unset_away_internal(state, label) when is_binary(label) do
    :ok = Client.send_line(state.client, "@label=#{label} AWAY\r\n")
    maybe_broadcast_mentions_bundle(state)

    %{
      state
      | away_state: :present,
        away_started_at: nil,
        away_reason: nil
    }
  end

  # C8: aggregate mentions during the away interval and broadcast
  # `mentions_bundle` on the user-level PubSub topic when matches exist.
  # Only runs for user sessions (not visitors); silently skips when
  # `away_started_at` is nil (present state — should not happen in normal flow
  # but guards against double-unset edge cases).
  @spec maybe_broadcast_mentions_bundle(state()) :: :ok
  defp maybe_broadcast_mentions_bundle(%{subject: {:user, user_id}} = state)
       when is_binary(user_id) and not is_nil(state.away_started_at) do
    away_start_ms = DateTime.to_unix(state.away_started_at, :millisecond)
    away_end_ms = System.system_time(:millisecond)
    watchlist = UserSettings.get_highlight_patterns(user_id)

    messages = Mentions.aggregate_mentions(user_id, state.network_id, away_start_ms, away_end_ms, watchlist, state.nick)

    if messages != [] do
      message_payloads =
        Enum.map(messages, fn m ->
          %{
            server_time: m.server_time,
            channel: m.channel,
            sender_nick: m.sender,
            body: m.body,
            kind: Atom.to_string(m.kind)
          }
        end)

      away_started_iso = DateTime.to_iso8601(state.away_started_at)
      away_ended_iso = DateTime.to_iso8601(DateTime.utc_now())

      :ok =
        Grappa.PubSub.broadcast_event(
          Topic.user(state.subject_label),
          %{
            kind: "mentions_bundle",
            network: state.network_slug,
            away_started_at: away_started_iso,
            away_ended_at: away_ended_iso,
            away_reason: state.away_reason,
            messages: message_payloads
          }
        )
    end

    :ok
  end

  defp maybe_broadcast_mentions_bundle(_), do: :ok
end
