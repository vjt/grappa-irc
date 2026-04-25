defmodule Grappa.Session.Server do
  @moduledoc """
  GenServer that owns one `(user_name, network)` upstream IRC session.

  Supervises one `Grappa.IRC.Client` (linked via `start_link`) which owns
  the TCP/TLS socket. Inbound parsed `Grappa.IRC.Message` structs arrive
  in this GenServer's mailbox as `{:irc, msg}` tuples; outbound
  protocol-level work (NICK/USER on init, PONG on PING, JOIN on autojoin)
  is performed via the high-level `Grappa.IRC.Client` helpers.

  Registered under `{:via, Registry, {Grappa.SessionRegistry, {:session,
  user_name, network_id}}}` so the public `Grappa.Session.whereis/2`
  facade can resolve a pid from the operator-visible identifiers.

  ## Phase 1 protocol scope

  This is the walking-skeleton implementation:

    * Handshake is `NICK <nick>` + `USER <nick> 0 * :grappa` — no CAP
      LS dance, no SASL. Phase 2 introduces CAP + SASL when per-user
      credentials land in the encrypted DB.
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

  PRIVMSG broadcasts emit `{:event, %{kind: :message, message:
  Grappa.Scrollback.Message.to_wire(msg)}}` on the per-channel topic
  built via `Grappa.PubSub.Topic.channel/2`. This matches the wire
  shape produced by `GrappaWeb.MessagesController.create/2` exactly —
  every door, same wire shape per CLAUDE.md.
  """
  use GenServer, restart: :transient

  alias Grappa.Config.Network
  alias Grappa.IRC.{Client, Message}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback

  require Logger

  @type opts :: %{
          required(:user_name) => String.t(),
          required(:network) => Network.t()
        }

  @type state :: %{
          user_name: String.t(),
          network: Network.t(),
          client: pid()
        }

  @logged_event_commands ~w[JOIN PART QUIT NICK MODE TOPIC KICK]

  ## API

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(%{user_name: u, network: %Network{} = n} = opts) do
    GenServer.start_link(__MODULE__, opts, name: via(u, n.id))
  end

  @doc "Returns the via-tuple for the session registered for `(user_name, network_id)`."
  @spec via(String.t(), String.t()) :: {:via, Registry, {atom(), {:session, String.t(), String.t()}}}
  def via(user_name, network_id) do
    {:via, Registry, {Grappa.SessionRegistry, {:session, user_name, network_id}}}
  end

  ## GenServer callbacks

  @impl GenServer
  def init(%{user_name: user, network: %Network{} = net}) do
    Logger.metadata(user: user, network: net.id)

    case Client.start_link(%{
           host: net.host,
           port: net.port,
           tls: net.tls,
           dispatch_to: self(),
           logger_metadata: [user: user, network: net.id]
         }) do
      {:ok, client} ->
        :ok = Client.send_line(client, "NICK #{net.nick}\r\n")
        :ok = Client.send_line(client, "USER #{net.nick} 0 * :grappa\r\n")
        {:ok, %{user_name: user, network: net, client: client}}

      {:error, reason} ->
        {:stop, {:client_start_failed, reason}}
    end
  end

  @impl GenServer
  def handle_info({:irc, %Message{command: "001"}}, state) do
    Enum.each(state.network.autojoin, &Client.send_join(state.client, &1))
    {:noreply, state}
  end

  def handle_info({:irc, %Message{command: "PING", params: [token | _]}}, state) do
    :ok = Client.send_line(state.client, "PONG :#{token}\r\n")
    {:noreply, state}
  end

  def handle_info(
        {:irc, %Message{command: "PRIVMSG", params: [target, body], prefix: prefix}},
        state
      )
      when is_binary(body) do
    sender = nick_of(prefix)
    server_time = System.system_time(:millisecond)

    case Scrollback.insert(%{
           network_id: state.network.id,
           channel: target,
           server_time: server_time,
           kind: :privmsg,
           sender: sender,
           body: body
         }) do
      {:ok, message} ->
        event = %{kind: :message, message: Grappa.Scrollback.Message.to_wire(message)}

        :ok =
          Phoenix.PubSub.broadcast(
            Grappa.PubSub,
            Topic.channel(state.network.id, target),
            {:event, event}
          )

      {:error, changeset} ->
        Logger.error("scrollback insert failed",
          command: "PRIVMSG",
          channel: target,
          error: inspect(changeset.errors)
        )
    end

    {:noreply, state}
  end

  def handle_info(
        {:irc, %Message{command: cmd, prefix: prefix, params: params}},
        state
      )
      when cmd in @logged_event_commands do
    Logger.info("irc event",
      command: cmd,
      sender: nick_of(prefix),
      channel: List.first(params)
    )

    {:noreply, state}
  end

  def handle_info({:irc, %Message{}}, state), do: {:noreply, state}

  ## Helpers

  defp nick_of({:nick, nick, _, _}), do: nick
  defp nick_of({:server, server}), do: server
  defp nick_of(nil), do: "*"
end
