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
  / user_name / network_slug, plus user_id + network_id merged in
  by `Grappa.Session.start_session/3`) and does NO DB reads — no
  `Grappa.Accounts`, no `Grappa.Networks`, no `Grappa.Repo`. The
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
  the per-(user, network, channel) topic built via
  `Grappa.PubSub.Topic.channel/3`. `state.user_name` is the first
  segment (sub-task 2h) so multi-user instances cannot leak broadcasts
  across users — payload-level iso (decision G3 dropped `user_id` from
  the wire) needed routing-level iso to actually keep alice and vjt's
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
  alias Grappa.{Log, Scrollback}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Wire
  alias Grappa.Session.EventRouter

  require Logger

  @typedoc """
  Internal init arg — `t:Grappa.Session.start_opts/0` plus the
  `(user_id, network_id)` keys `Grappa.Session.start_session/3`
  merges in. Kept as a separate type from `start_opts/0` because
  the public start contract takes the two ids positionally.
  """
  @type init_opts :: %{
          required(:user_id) => Ecto.UUID.t(),
          required(:network_id) => integer(),
          required(:user_name) => String.t(),
          required(:network_slug) => String.t(),
          required(:nick) => String.t(),
          required(:realname) => String.t(),
          required(:sasl_user) => String.t(),
          required(:auth_method) => AuthFSM.auth_method(),
          required(:password) => String.t() | nil,
          required(:autojoin_channels) => [String.t()],
          required(:host) => String.t(),
          required(:port) => :inet.port_number(),
          required(:tls) => boolean()
        }

  @type state :: %{
          user_id: Ecto.UUID.t(),
          user_name: String.t(),
          network_id: integer(),
          network_slug: String.t(),
          nick: String.t(),
          members: %{String.t() => %{String.t() => [String.t()]}},
          autojoin: [String.t()],
          client: pid() | nil
        }

  ## API

  @spec start_link(init_opts()) :: GenServer.on_start()
  def start_link(%{user_id: user_id, network_id: network_id} = opts)
      when is_binary(user_id) and is_integer(network_id) do
    GenServer.start_link(__MODULE__, opts, name: via(user_id, network_id))
  end

  @doc """
  Returns the registry key for `(user_id, network_id)`. Single source
  of truth for the `{:session, user_id, network_id}` shape — every
  caller that needs to look up or terminate a session by key must go
  through this. Adding a discriminator (workspace, shard) becomes a
  one-place change.
  """
  @spec registry_key(Ecto.UUID.t(), integer()) :: {:session, Ecto.UUID.t(), integer()}
  def registry_key(user_id, network_id) when is_binary(user_id) and is_integer(network_id) do
    {:session, user_id, network_id}
  end

  @doc "Returns the via-tuple for the session registered for `(user_id, network_id)`."
  @spec via(Ecto.UUID.t(), integer()) ::
          {:via, Registry, {atom(), {:session, Ecto.UUID.t(), integer()}}}
  def via(user_id, network_id) when is_binary(user_id) and is_integer(network_id) do
    {:via, Registry, {Grappa.SessionRegistry, registry_key(user_id, network_id)}}
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
    :ok = Log.set_session_context(opts.user_name, opts.network_slug)

    state = %{
      user_id: opts.user_id,
      user_name: opts.user_name,
      network_id: opts.network_id,
      network_slug: opts.network_slug,
      nick: opts.nick,
      members: %{},
      autojoin: opts.autojoin_channels,
      client: nil
    }

    {:ok, state, {:continue, {:start_client, client_opts(opts)}}}
  end

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
    attrs = %{
      user_id: state.user_id,
      network_id: state.network_id,
      channel: target,
      server_time: System.system_time(:millisecond),
      kind: :privmsg,
      sender: state.nick,
      body: body,
      meta: %{}
    }

    case Scrollback.persist_event(attrs) do
      {:ok, message} ->
        :ok =
          Phoenix.PubSub.broadcast(
            Grappa.PubSub,
            Topic.channel(state.user_name, state.network_slug, target),
            Wire.message_event(message)
          )

        # `Client.send_privmsg` returns `:ok | {:error, :invalid_line}`
        # since S29 C1. The Session facade pre-validates so the error
        # branch is unreachable on the documented path; the case below
        # is forward-compat insurance against a future caller that
        # bypasses the facade. If it ever fires, surface the typed
        # error to the caller — a MatchError here would crash the
        # session GenServer + trip the transient restart loop, much
        # worse than a 400-shaped error tuple.
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

  @doc """
  Returns a snapshot of currently-joined channels (`Map.keys(state.members)`)
  sorted alphabetically. Public via `Grappa.Session.list_channels/2`.

  The "currently-joined" invariant is preserved by EventRouter's self-JOIN
  wipe + self-PART/KICK delete (Q1 of P4-1 cluster). A channel appears in
  `state.members` IFF the operator's session has a live join on it.
  """
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

    delegate(msg, state)
  end

  def handle_info({:irc, %Message{} = msg}, state), do: delegate(msg, state)

  ## Internals

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
      logger_metadata: Log.session_context(opts.user_name, opts.network_slug),
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
  @spec delegate(Message.t(), state()) :: {:noreply, state()}
  defp delegate(msg, state) do
    {:cont, derived_state, effects} = EventRouter.route(msg, state)
    {:noreply, apply_effects(effects, derived_state)}
  end

  @spec apply_effects([EventRouter.effect()], state()) :: state()
  defp apply_effects([], state), do: state

  defp apply_effects([{:persist, kind, attrs} | rest], state) do
    full_attrs = Map.put(attrs, :kind, kind)

    case Scrollback.persist_event(full_attrs) do
      {:ok, message} ->
        # Topic shape is `(user_name, network_slug, channel)` —
        # sub-task 2h roots every Grappa topic in the user
        # discriminator. `:network` is preloaded by
        # `Scrollback.persist_event/1`; Wire.message_event
        # pattern-matches on it.
        :ok =
          Phoenix.PubSub.broadcast(
            Grappa.PubSub,
            Topic.channel(state.user_name, state.network_slug, attrs.channel),
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
