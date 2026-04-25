defmodule Grappa.Session.Server do
  @moduledoc """
  GenServer that owns one `(user_name, network)` upstream IRC session.

  Supervises one `Grappa.IRC.Client` (linked via `start_link`) which owns
  the TCP/TLS socket. Inbound parsed `Grappa.IRC.Message` structs arrive
  in this GenServer's mailbox as `{:irc, msg}` tuples; outbound
  protocol-level work (handshake on init, PONG on PING, JOIN on autojoin)
  is performed via the high-level `Grappa.IRC.Client` helpers.

  Registered under `{:via, Registry, {Grappa.SessionRegistry, {:session,
  user_name, network_id}}}` so the public `Grappa.Session.whereis/2`
  facade can resolve a pid from the operator-visible identifiers.

  ## Phase 1 protocol scope

  This is the walking-skeleton implementation:

    * Handshake via `Grappa.IRC.Client.send_handshake/2` (NICK + USER).
      Phase 2 introduces CAP + SASL when per-user credentials land in
      the encrypted DB.
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
  the per-channel topic built via `Grappa.PubSub.Topic.channel/2`.
  Every broadcaster (this module + `GrappaWeb.MessagesController`)
  routes through the same helper — every door, same wire shape per
  CLAUDE.md.

  ## State shape (architecture review A6)

  The GenServer keeps the registered identifiers (for log metadata +
  topic construction), the connection nick (sender for outbound
  PRIVMSG persistence), the autojoin list (consumed on `001`), and the
  linked Client pid. Connection params (host/port/tls) are consumed by
  `init/1` and not retained — Session does not reach into a
  `Config.Network` struct.

  ## Outbound API (Task 9)

  `handle_call({:send_privmsg, target, body}, _, state)` persists a
  scrollback row with `sender = state.nick`, broadcasts on the
  per-channel PubSub topic, AND sends the PRIVMSG upstream — atomic
  from the caller's view, single source for the row + wire event.
  `{:send_join, ch}` / `{:send_part, ch}` are upstream-only
  (channel-membership tracking lands in Phase 5 alongside JOIN/PART
  persistence). Public callers go through `Grappa.Session.send_*`,
  which resolves the pid from the registry.
  """
  use GenServer, restart: :transient

  alias Grappa.IRC.{Client, Message}
  alias Grappa.{Log, Scrollback}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Wire

  require Logger

  @type opts :: Grappa.Session.start_opts()

  @type state :: %{
          user_name: String.t(),
          network_id: String.t(),
          nick: String.t(),
          autojoin: [String.t()],
          client: pid()
        }

  @logged_event_commands [:join, :part, :quit, :nick, :mode, :topic, :kick]

  ## API

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(%{user_name: u, network_id: n} = opts) do
    GenServer.start_link(__MODULE__, opts, name: via(u, n))
  end

  @doc "Returns the via-tuple for the session registered for `(user_name, network_id)`."
  @spec via(String.t(), String.t()) :: {:via, Registry, {atom(), {:session, String.t(), String.t()}}}
  def via(user_name, network_id) do
    {:via, Registry, {Grappa.SessionRegistry, {:session, user_name, network_id}}}
  end

  ## GenServer callbacks

  @impl GenServer
  def init(%{user_name: user, network_id: network_id} = opts) do
    :ok = Log.set_session_context(user, network_id)

    case Client.start_link(%{
           host: opts.host,
           port: opts.port,
           tls: opts.tls,
           dispatch_to: self(),
           logger_metadata: Log.session_context(user, network_id)
         }) do
      {:ok, client} ->
        :ok = Client.send_handshake(client, opts.nick)

        {:ok,
         %{
           user_name: user,
           network_id: network_id,
           nick: opts.nick,
           autojoin: Map.get(opts, :autojoin, []),
           client: client
         }}

      {:error, reason} ->
        {:stop, {:client_start_failed, reason}}
    end
  end

  @impl GenServer
  def handle_call({:send_privmsg, target, body}, _, state)
      when is_binary(target) and is_binary(body) do
    case persist_and_broadcast(state, target, state.nick, body) do
      {:ok, message} ->
        :ok = Client.send_privmsg(state.client, target, body)
        {:reply, {:ok, message}, state}

      {:error, _} = err ->
        {:reply, err, state}
    end
  end

  def handle_call({:send_join, channel}, _, state) when is_binary(channel) do
    :ok = Client.send_join(state.client, channel)
    {:reply, :ok, state}
  end

  def handle_call({:send_part, channel}, _, state) when is_binary(channel) do
    :ok = Client.send_part(state.client, channel)
    {:reply, :ok, state}
  end

  @impl GenServer
  def handle_info({:irc, %Message{command: {:numeric, 1}}}, state) do
    Enum.each(state.autojoin, &Client.send_join(state.client, &1))
    {:noreply, state}
  end

  def handle_info({:irc, %Message{command: :ping, params: [token | _]}}, state) do
    :ok = Client.send_pong(state.client, token)
    {:noreply, state}
  end

  def handle_info(
        {:irc, %Message{command: :privmsg, params: [target, body]} = msg},
        state
      )
      when is_binary(body) do
    case persist_and_broadcast(state, target, Message.sender_nick(msg), body) do
      {:ok, _} -> :ok
      {:error, _} -> :ok
    end

    {:noreply, state}
  end

  def handle_info(
        {:irc, %Message{command: cmd, params: params} = msg},
        state
      )
      when cmd in @logged_event_commands do
    Logger.info("irc event",
      command: cmd,
      sender: Message.sender_nick(msg),
      channel: List.first(params)
    )

    {:noreply, state}
  end

  def handle_info({:irc, %Message{}}, state), do: {:noreply, state}

  @spec persist_and_broadcast(state(), String.t(), String.t(), String.t()) ::
          {:ok, Scrollback.Message.t()} | {:error, Ecto.Changeset.t()}
  defp persist_and_broadcast(state, target, sender, body) do
    case Scrollback.persist_privmsg(state.network_id, target, sender, body) do
      {:ok, message} = ok ->
        :ok =
          Phoenix.PubSub.broadcast(
            Grappa.PubSub,
            Topic.channel(state.network_id, target),
            Wire.message_event(message)
          )

        ok

      {:error, changeset} = err ->
        Logger.error("scrollback insert failed",
          command: :privmsg,
          channel: target,
          error: inspect(changeset.errors)
        )

        err
    end
  end
end
