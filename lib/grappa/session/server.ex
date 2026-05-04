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

  PRIVMSG broadcasts emit `Grappa.Scrollback.Wire.message_event/1` on
  the per-(subject, network, channel) topic built via
  `Grappa.PubSub.Topic.channel/3`. `state.subject_label` is the
  first segment (sub-task 2h, generalized in Task 6.5) so multi-user
  + visitor instances cannot leak broadcasts across subjects —
  payload-level iso (decision G3 dropped `user_id` from the wire)
  needed routing-level iso to actually keep alice / vjt / visitor
  PubSub mailboxes separate.

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
  alias Grappa.{Log, Scrollback, Session}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Wire
  alias Grappa.Session.{Backoff, EventRouter, GhostRecovery, NSInterceptor}

  require Logger

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
          auto_away_timer: reference() | nil
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
      auto_away_timer: nil
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
          Phoenix.PubSub.broadcast(
            Grappa.PubSub,
            Topic.channel(state.subject_label, state.network_slug, channel),
            Wire.message_event(message)
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

  # S3.2: explicit away set — user issued `/away <reason>`. Explicit always
  # wins: replaces any existing auto-away without checking current state.
  # Issues `AWAY :<reason>` upstream and records the timestamp + reason.
  # Safe_line_token guard lives on the facade (`Session.set_explicit_away/3`)
  # so injection-attempt vs no-session ordering is consistent.
  def handle_call({:set_explicit_away, reason}, _, state) when is_binary(reason) do
    next_state = set_explicit_away_internal(state, reason)
    {:reply, :ok, next_state}
  end

  # S3.2: explicit away unset — user issued bare `/away`. Only honours the
  # call when currently `:away_explicit`; any other state is a no-op that
  # returns `{:error, :not_explicit}` so callers can surface "you weren't
  # away explicitly" feedback to the user.
  def handle_call({:unset_explicit_away}, _, %{away_state: :away_explicit} = state) do
    next_state = unset_away_internal(state)
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
    next_state = unset_away_internal(state)
    {:reply, :ok, next_state}
  end

  def handle_call({:unset_auto_away}, _, state) do
    # :away_explicit or :present — no-op.
    {:reply, :ok, state}
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
    {:noreply, state}
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
  def handle_info({:ws_connected, _user_name}, state) do
    state =
      if is_reference(state.auto_away_timer) do
        Process.cancel_timer(state.auto_away_timer)
        %{state | auto_away_timer: nil}
      else
        state
      end

    state =
      if state.away_state == :away_auto do
        unset_away_internal(state)
      else
        state
      end

    {:noreply, state}
  end

  # S3.2 — WS disconnect: the last browser tab for this user closed.
  # Schedule the 30s debounce before issuing auto-away. If already
  # `:away_explicit`, skip entirely — the user intentionally went away.
  def handle_info({:ws_all_disconnected, _user_name}, %{away_state: :away_explicit} = state) do
    {:noreply, state}
  end

  def handle_info({:ws_all_disconnected, _user_name}, state) do
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
    Enum.each(state.autojoin, fn channel ->
      case Client.send_join(state.client, channel) do
        :ok ->
          :ok

        {:error, :invalid_line} ->
          Logger.warning("autojoin skipped: invalid channel name", channel: inspect(channel))
      end
    end)

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

    state =
      state
      |> maybe_fire_notify()
      |> maybe_stage_pending_password()

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
          meta: %{}
        },
        state.subject
      )

    case Scrollback.persist_event(attrs) do
      {:ok, message} ->
        :ok =
          Phoenix.PubSub.broadcast(
            Grappa.PubSub,
            Topic.channel(state.subject_label, state.network_slug, target),
            Wire.message_event(message)
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

  # `EventRouter.route/2` returns `{:cont, new_state, [effect]}`. Effects
  # are flushed in arrival order via `apply_effects/2`. The router owns
  # state derivation (members map, nick reconcile); Server owns the
  # transport — Client.send_line for `:reply`, Scrollback.persist_event
  # + PubSub.broadcast for `:persist`.
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
    {:noreply, next_state}
  end

  @spec maybe_broadcast_channels_changed(state(), state()) :: :ok
  defp maybe_broadcast_channels_changed(prev, next) do
    prev_keys = prev.members |> Map.keys() |> Enum.sort()
    next_keys = next.members |> Map.keys() |> Enum.sort()

    if prev_keys != next_keys do
      :ok =
        Phoenix.PubSub.broadcast(
          Grappa.PubSub,
          Topic.user(prev.subject_label),
          {:event, %{kind: "channels_changed"}}
        )
    end

    :ok
  end

  @spec apply_effects([EventRouter.effect()], state()) :: state()
  defp apply_effects([], state), do: state

  defp apply_effects([{:topic_changed, channel, entry} | rest], state) do
    :ok =
      Phoenix.PubSub.broadcast(
        Grappa.PubSub,
        Topic.channel(state.subject_label, state.network_slug, channel),
        {:event,
         %{
           kind: "topic_changed",
           network: state.network_slug,
           channel: channel,
           topic: entry
         }}
      )

    apply_effects(rest, state)
  end

  defp apply_effects([{:channel_modes_changed, channel, entry} | rest], state) do
    :ok =
      Phoenix.PubSub.broadcast(
        Grappa.PubSub,
        Topic.channel(state.subject_label, state.network_slug, channel),
        {:event,
         %{
           kind: "channel_modes_changed",
           network: state.network_slug,
           channel: channel,
           modes: entry
         }}
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
        # `Scrollback.persist_event/1`; Wire.message_event
        # pattern-matches on it.
        :ok =
          Phoenix.PubSub.broadcast(
            Grappa.PubSub,
            Topic.channel(state.subject_label, state.network_slug, attrs.channel),
            Wire.message_event(message)
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
      Phoenix.PubSub.broadcast(
        Grappa.PubSub,
        Topic.user(state.subject_label),
        {:event,
         %{
           kind: "away_confirmed",
           network: state.network_slug,
           state: away_str
         }}
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
  # S3.2 — away state internal helpers
  # ---------------------------------------------------------------------------

  # Set explicit away: unconditional, always wins. Issues `AWAY :<reason>`
  # upstream. Records `away_started_at` + `away_reason` so Mentions
  # aggregation (S3.5) has the precise window.
  @spec set_explicit_away_internal(state(), String.t()) :: state()
  defp set_explicit_away_internal(state, reason) when is_binary(reason) do
    :ok = Client.send_away(state.client, reason)

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
  @spec unset_away_internal(state()) :: state()
  defp unset_away_internal(state) do
    :ok = Client.send_away_unset(state.client)

    %{
      state
      | away_state: :present,
        away_started_at: nil,
        away_reason: nil
    }
  end
end
