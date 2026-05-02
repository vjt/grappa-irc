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
  alias Grappa.Session.{EventRouter, GhostRecovery, NSInterceptor}

  require Logger

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
          optional(:visitor_committer) => visitor_committer()
        }

  @type state :: %{
          subject: Grappa.Session.subject(),
          subject_label: String.t(),
          network_id: integer(),
          network_slug: String.t(),
          nick: String.t(),
          members: %{String.t() => %{String.t() => [String.t()]}},
          autojoin: [String.t()],
          client: pid() | nil,
          notify_pid: pid() | nil,
          notify_ref: reference() | nil,
          pending_auth: nil | {String.t(), integer()},
          pending_auth_timer: reference() | nil,
          pending_password: String.t() | nil,
          visitor_committer: visitor_committer() | nil,
          ghost_recovery: GhostRecovery.t() | nil,
          ghost_timer: reference() | nil
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

    state = %{
      subject: opts.subject,
      subject_label: opts.subject_label,
      network_id: opts.network_id,
      network_slug: opts.network_slug,
      nick: opts.nick,
      members: %{},
      autojoin: opts.autojoin_channels,
      client: nil,
      notify_pid: Map.get(opts, :notify_pid),
      notify_ref: Map.get(opts, :notify_ref),
      pending_auth: nil,
      pending_auth_timer: nil,
      pending_password: pending_password_from_opts(opts),
      visitor_committer: Map.get(opts, :visitor_committer),
      ghost_recovery: nil,
      ghost_timer: nil
    }

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

  @impl GenServer
  def handle_continue({:start_client, client_opts}, state) do
    case Client.start_link(client_opts) do
      {:ok, client} ->
        {:noreply, %{state | client: client}}

      {:error, reason} ->
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

  @impl GenServer
  def handle_cast({:send_join, channel}, state) when is_binary(channel) do
    :ok = Client.send_join(state.client, channel)
    {:noreply, state}
  end

  def handle_cast({:send_part, channel}, state) when is_binary(channel) do
    :ok = Client.send_part(state.client, channel)
    {:noreply, state}
  end

  @impl GenServer
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

  def handle_info({:irc, %Message{} = msg}, state), do: delegate(msg, state)

  ## Internals

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
end
