defmodule Grappa.IRC.Client do
  @moduledoc """
  GenServer that owns one upstream IRC socket (TCP or TLS) and
  bidirectionally translates between bytes-on-the-wire and
  `Grappa.IRC.Message` structs.

  Inbound lines from the socket are parsed via `Grappa.IRC.Parser` and
  dispatched as `{:irc, %Message{}}` to the configured `:dispatch_to`
  pid (typically the `Grappa.Session.Server` that supervises this
  client). Outbound lines are sent verbatim — callers can use the
  high-level helpers (`send_privmsg/3`, `send_join/2`, etc.) or the
  raw `send_line/2` for unframed wire bytes.

  ## Backpressure

  The socket runs in `packet: :line` mode (OS-level line framing,
  immune to TCP packet boundary races) with `active: :once` re-armed
  after each `{:tcp, _, line}` is dispatched. That gives the GenServer
  mailbox cooperative backpressure on the inbound stream: we never
  receive line N+1 until line N has been parsed and forwarded. The
  `active: :true` mode would race the client GenServer's mailbox under
  bursts (e.g. NAMES lists on JOIN); `active: :once` does not.

  ## Transport abstraction

  TCP and TLS share the same callback shape (`{:tcp, sock, data}` /
  `{:ssl, sock, data}`, `:gen_tcp.send/2` / `:ssl.send/2`,
  `:inet.setopts/2` / `:ssl.setopts/2`). The `:transport` field in
  state — `:tcp` or `:ssl` — picks the right module pair via private
  `transport_send/2` and `transport_setopts/2` helpers.

  ## TLS posture (Phase 1)

  When started with `tls: true`, the Phase 1 connection uses
  `verify: :verify_none` — connect-and-encrypt without certificate
  chain validation. CLAUDE.md "TLS verification on by default. The
  Phase 1 `verify: :verify_none` is a temporary expedient — Phase 5
  hardening adds proper CA chain verification." A `Logger.warning` is
  emitted on every TLS connection attempt so the posture is visible
  in logs, not buried in code.

  ## Crash semantics

  `start_link/1` links the Client to its caller — typically the
  `Session.Server` GenServer. A socket close (`:tcp_closed` /
  `:ssl_closed`) stops the Client with `:tcp_closed` / `:ssl_closed`
  reason, which propagates the link signal upward. The Session is then
  restarted by its `DynamicSupervisor` (transient policy on abnormal
  exit), spawning a fresh Client. Reconnect-with-backoff is Phase 5;
  Phase 1 takes the simpler "let it crash" route.
  """
  use GenServer

  alias Grappa.IRC.Parser

  require Logger

  @type opts :: %{
          required(:host) => String.t() | charlist(),
          required(:port) => :inet.port_number(),
          required(:tls) => boolean(),
          required(:dispatch_to) => pid(),
          required(:logger_metadata) => keyword()
        }

  @type state :: %{
          socket: :gen_tcp.socket() | :ssl.sslsocket(),
          transport: :tcp | :ssl,
          dispatch_to: pid()
        }

  ## API

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  @doc """
  Sends raw bytes verbatim to the upstream socket. The caller is
  responsible for CR/LF framing and IRC syntax. Used by the high-level
  helpers below; tests and lower-level paths can call directly.
  """
  @spec send_line(pid(), iodata()) :: :ok
  def send_line(client, line), do: GenServer.cast(client, {:send, line})

  @doc "Sends `PRIVMSG <target> :<body>\\r\\n`."
  @spec send_privmsg(pid(), String.t(), String.t()) :: :ok
  def send_privmsg(client, target, body),
    do: send_line(client, "PRIVMSG #{target} :#{body}\r\n")

  @doc "Sends `JOIN <channel>\\r\\n`."
  @spec send_join(pid(), String.t()) :: :ok
  def send_join(client, channel), do: send_line(client, "JOIN #{channel}\r\n")

  @doc "Sends `PART <channel>\\r\\n`."
  @spec send_part(pid(), String.t()) :: :ok
  def send_part(client, channel), do: send_line(client, "PART #{channel}\r\n")

  @doc "Sends `QUIT :<reason>\\r\\n`."
  @spec send_quit(pid(), String.t()) :: :ok
  def send_quit(client, reason), do: send_line(client, "QUIT :#{reason}\r\n")

  ## GenServer callbacks

  @impl GenServer
  def init(opts) do
    Logger.metadata(Keyword.new(opts.logger_metadata))

    if opts.tls do
      Logger.warning("phase 1 TLS posture: verify_none — no certificate chain validation. Phase 5 hardens this.")
    end

    host = to_charlist(opts.host)

    case do_connect(host, opts.port, opts.tls) do
      {:ok, socket} ->
        {:ok,
         %{
           socket: socket,
           transport: if(opts.tls, do: :ssl, else: :tcp),
           dispatch_to: opts.dispatch_to
         }}

      {:error, reason} ->
        {:stop, {:connect_failed, reason}}
    end
  end

  @impl GenServer
  def handle_info({:tcp, _, line}, state), do: process_line(line, state)
  def handle_info({:ssl, _, line}, state), do: process_line(line, state)
  def handle_info({:tcp_closed, _}, state), do: {:stop, :tcp_closed, state}
  def handle_info({:ssl_closed, _}, state), do: {:stop, :ssl_closed, state}

  @impl GenServer
  def handle_cast({:send, line}, state) do
    :ok = transport_send(state, line)
    {:noreply, state}
  end

  ## Private

  defp do_connect(host, port, false) do
    :gen_tcp.connect(host, port, [:binary, packet: :line, active: :once])
  end

  defp do_connect(host, port, true) do
    :ssl.connect(host, port, [
      :binary,
      packet: :line,
      active: :once,
      verify: :verify_none
    ])
  end

  defp process_line(line, state) do
    case Parser.parse(line) do
      {:ok, msg} ->
        send(state.dispatch_to, {:irc, msg})

      {:error, reason} ->
        Logger.warning("irc parse failed: #{inspect(reason)} raw=#{inspect(line)}")
    end

    :ok = transport_setopts(state, active: :once)
    {:noreply, state}
  end

  defp transport_send(%{transport: :tcp, socket: sock}, data),
    do: :gen_tcp.send(sock, data)

  defp transport_send(%{transport: :ssl, socket: sock}, data),
    do: :ssl.send(sock, data)

  defp transport_setopts(%{transport: :tcp, socket: sock}, opts),
    do: :inet.setopts(sock, opts)

  defp transport_setopts(%{transport: :ssl, socket: sock}, opts),
    do: :ssl.setopts(sock, opts)
end
