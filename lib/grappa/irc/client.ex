defmodule Grappa.IRC.Client do
  @moduledoc """
  GenServer that owns one upstream IRC socket (TCP or TLS) and
  bidirectionally translates between bytes-on-the-wire and
  `Grappa.IRC.Message` structs.

  Inbound lines from the socket are parsed via `Grappa.IRC.Parser` and
  dispatched as `{:irc, %Message{}}` to the configured `:dispatch_to`
  pid (typically the `Grappa.Session.Server` that supervises this
  client) — every parsed line is forwarded, including the auth-handshake
  numerics this module also acts on internally. Outbound lines are sent
  verbatim — callers can use the high-level helpers (`send_privmsg/3`,
  `send_join/2`, etc.) or the raw `send_line/2` for unframed wire bytes.

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

  ## Auth state machine (sub-task 2f)

  `init/1` drives the full upstream registration handshake per the
  per-credential `:auth_method` ∈ `:auto | :sasl | :server_pass |
  :nickserv_identify | :none` (matching `Grappa.Networks.Credential`):

      auth_method = :none               → NICK, USER
      auth_method = :server_pass        → PASS, NICK, USER
      auth_method = :nickserv_identify  → NICK, USER → on 001,
                                          PRIVMSG NickServ :IDENTIFY <pw>
      auth_method = :sasl               → CAP LS 302, NICK, USER →
                                          CAP REQ :sasl, AUTHENTICATE PLAIN,
                                          AUTHENTICATE base64, → on 903 CAP END;
                                          on 904/905 stop {:sasl_failed, n}
      auth_method = :auto               → PASS (if pw), CAP LS 302, NICK, USER
                                          → if SASL advertised: SASL chain
                                          → if 421 :Unknown CAP / no reply / 001:
                                             continue (PASS-handoff path,
                                             Bahamut/Azzurra)

  The `:auto` path is the default for new credentials — modern ircd
  with SASL "just works", legacy ircd (Bahamut/Azzurra) gets the PASS
  field at registration which the server then hands off to NickServ
  internally (see `~/code/IRC/bahamut-azzurra/src/s_user.c:1273-1278`
  documented in `docs/DESIGN_NOTES.md`). Only `:nickserv_identify`
  fires the client-side `PRIVMSG NickServ :IDENTIFY` post-001.

  Phase tracking (`:phase` field) gates the few transitions where
  ordering matters (`CAP REQ` only after `CAP LS` reply, `001`
  unconditionally promotes to `:registered`). Internal CAP/AUTHENTICATE
  numerics are still forwarded to `:dispatch_to` so the Session can
  log them; the Session's catch-all `handle_info` swallows what it
  doesn't pattern-match.

  ## Crash semantics

  `start_link/1` links the Client to its caller — typically the
  `Session.Server` GenServer. A socket close (`:tcp_closed` /
  `:ssl_closed`) stops the Client with `:tcp_closed` / `:ssl_closed`
  reason, which propagates the link signal upward. SASL failure
  (`904`/`905` from upstream) stops the Client with `{:sasl_failed,
  numeric}` so the Session crashes with a structured reason. The
  Session is then restarted by its `DynamicSupervisor` (transient
  policy on abnormal exit), spawning a fresh Client.
  Reconnect-with-backoff is Phase 5; Phase 1/2 take the simpler
  "let it crash" route.
  """
  use GenServer

  alias Grappa.IRC.{Message, Parser}

  require Logger

  @auth_methods [:auto, :sasl, :server_pass, :nickserv_identify, :none]

  @type auth_method :: :auto | :sasl | :server_pass | :nickserv_identify | :none

  @type opts :: %{
          required(:host) => String.t() | charlist(),
          required(:port) => :inet.port_number(),
          required(:tls) => boolean(),
          required(:dispatch_to) => pid(),
          required(:logger_metadata) => keyword(),
          required(:nick) => String.t(),
          required(:auth_method) => auth_method(),
          optional(:realname) => String.t() | nil,
          optional(:sasl_user) => String.t() | nil,
          optional(:password) => String.t() | nil
        }

  @type phase :: :pre_register | :awaiting_cap_ls | :sasl_pending | :registered

  @type t :: %__MODULE__{
          socket: :gen_tcp.socket() | :ssl.sslsocket(),
          transport: :tcp | :ssl,
          dispatch_to: pid(),
          nick: String.t(),
          realname: String.t(),
          sasl_user: String.t(),
          password: String.t() | nil,
          auth_method: auth_method(),
          phase: phase()
        }

  @enforce_keys [
    :socket,
    :transport,
    :dispatch_to,
    :nick,
    :realname,
    :sasl_user,
    :auth_method,
    :phase
  ]
  defstruct [
    :socket,
    :transport,
    :dispatch_to,
    :nick,
    :realname,
    :sasl_user,
    :password,
    :auth_method,
    :phase
  ]

  ## API

  @doc """
  Spawns and links the Client. `opts` MUST carry `:nick` and
  `:auth_method` — `init/1` drives the upstream registration handshake
  the moment the socket is up, so the auth fields are non-optional.
  Returns the standard `t:GenServer.on_start/0` shape.
  """
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

  @doc "Sends `PONG :<token>\\r\\n` in response to an upstream PING."
  @spec send_pong(pid(), String.t()) :: :ok
  def send_pong(client, token), do: send_line(client, "PONG :#{token}\r\n")

  ## GenServer callbacks

  @impl GenServer
  def init(%{auth_method: m} = opts) when m in @auth_methods do
    Logger.metadata(Keyword.new(opts.logger_metadata))

    if opts.tls do
      Logger.warning("phase 1 TLS posture: verify_none — no certificate chain validation. Phase 5 hardens this.")
    end

    host = to_charlist(opts.host)

    case do_connect(host, opts.port, opts.tls) do
      {:ok, socket} ->
        transport = if(opts.tls, do: :ssl, else: :tcp)

        state = %__MODULE__{
          socket: socket,
          transport: transport,
          dispatch_to: opts.dispatch_to,
          nick: opts.nick,
          realname: Map.get(opts, :realname) || opts.nick,
          sasl_user: Map.get(opts, :sasl_user) || opts.nick,
          password: Map.get(opts, :password),
          auth_method: opts.auth_method,
          phase: :pre_register
        }

        {:ok, perform_initial_handshake(state)}

      {:error, reason} ->
        {:stop, {:connect_failed, reason}}
    end
  end

  @impl GenServer
  def handle_info({:tcp, _, line}, state), do: process_line(line, state)
  def handle_info({:ssl, _, line}, state), do: process_line(line, state)
  def handle_info({:tcp_closed, _}, state), do: {:stop, :tcp_closed, state}
  def handle_info({:ssl_closed, _}, state), do: {:stop, :ssl_closed, state}

  def handle_info(msg, state) do
    Logger.warning("unexpected mailbox message", unexpected: inspect(msg))
    {:noreply, state}
  end

  @impl GenServer
  def handle_cast({:send, line}, state) do
    :ok = transport_send(state, line)
    {:noreply, state}
  end

  ## Connection

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

  ## Initial handshake (PASS, CAP LS, NICK, USER)

  defp perform_initial_handshake(state) do
    state
    |> maybe_send_pass()
    |> maybe_send_cap_ls()
    |> send_nick_and_user()
  end

  defp maybe_send_pass(%__MODULE__{auth_method: m, password: pw} = state)
       when m in [:auto, :server_pass] and is_binary(pw) and pw != "" do
    :ok = transport_send(state, "PASS #{pw}\r\n")
    state
  end

  defp maybe_send_pass(state), do: state

  # `CAP LS 302` is the IRCv3.2 negotiation opener — `302` advertises
  # cap-notify support so the server returns multi-line LS replies and
  # post-registration cap changes. We always request the modern dialect;
  # legacy ircd that doesn't grok CAP returns `421 :Unknown command CAP`
  # which the inbound state machine treats as "skip CAP, proceed".
  defp maybe_send_cap_ls(%__MODULE__{auth_method: m} = state) when m in [:auto, :sasl] do
    :ok = transport_send(state, "CAP LS 302\r\n")
    %{state | phase: :awaiting_cap_ls}
  end

  defp maybe_send_cap_ls(state), do: state

  # Server queues NICK/USER until CAP END when CAP LS is in flight, so
  # sending them before the SASL exchange completes is safe — the
  # registration is held open until we either CAP END or the server
  # gives up on CAP (`421` / no reply / `001`).
  defp send_nick_and_user(state) do
    :ok = transport_send(state, "NICK #{state.nick}\r\n")
    :ok = transport_send(state, "USER #{state.nick} 0 * :#{state.realname}\r\n")
    state
  end

  ## Inbound

  defp process_line(line, state) do
    case Parser.parse(line) do
      {:ok, msg} ->
        send(state.dispatch_to, {:irc, msg})

        case handle_irc(msg, state) do
          {:cont, new_state} ->
            :ok = transport_setopts(new_state, active: :once)
            {:noreply, new_state}

          {:stop, reason, new_state} ->
            {:stop, reason, new_state}
        end

      {:error, reason} ->
        Logger.warning("irc parse failed", reason: reason, raw: inspect(line))
        :ok = transport_setopts(state, active: :once)
        {:noreply, state}
    end
  end

  defp handle_irc(%Message{command: :cap, params: params}, state),
    do: handle_cap(params, state)

  defp handle_irc(%Message{command: :authenticate, params: ["+"]}, state) do
    :ok = transport_send(state, "AUTHENTICATE #{sasl_plain_payload(state)}\r\n")
    {:cont, state}
  end

  defp handle_irc(%Message{command: {:numeric, 903}}, state) do
    :ok = transport_send(state, "CAP END\r\n")
    {:cont, %{state | phase: :pre_register}}
  end

  defp handle_irc(%Message{command: {:numeric, code}}, state) when code in [904, 905] do
    Logger.error("sasl auth failed", numeric: code)
    {:stop, {:sasl_failed, code}, state}
  end

  defp handle_irc(%Message{command: {:numeric, 1}}, state) do
    {:cont, %{maybe_nickserv_identify(state) | phase: :registered}}
  end

  defp handle_irc(_, state), do: {:cont, state}

  defp handle_cap([_, "LS", caps_blob | _], state) do
    if "sasl" in parse_caps(caps_blob) and state.auth_method in [:auto, :sasl] do
      :ok = transport_send(state, "CAP REQ :sasl\r\n")
      :ok = transport_send(state, "AUTHENTICATE PLAIN\r\n")
      {:cont, %{state | phase: :sasl_pending}}
    else
      cap_unavailable(state)
    end
  end

  defp handle_cap([_, "NAK", _ | _], state), do: cap_unavailable(state)

  defp handle_cap(_, state), do: {:cont, state}

  # SASL not on offer (or NAK'd). Mandatory SASL (`:sasl`) crashes;
  # `:auto` falls back to the PASS-handoff path (PASS already sent at
  # init for legacy ircd) and ends CAP negotiation cleanly.
  defp cap_unavailable(%{auth_method: :sasl} = state) do
    Logger.error("sasl required but not advertised by server")
    maybe_send_cap_end(state)
    {:stop, :sasl_unavailable, state}
  end

  defp cap_unavailable(state) do
    state = maybe_send_cap_end(state)
    {:cont, state}
  end

  defp maybe_send_cap_end(%{phase: :awaiting_cap_ls} = state) do
    :ok = transport_send(state, "CAP END\r\n")
    %{state | phase: :pre_register}
  end

  defp maybe_send_cap_end(%{phase: :sasl_pending} = state) do
    :ok = transport_send(state, "CAP END\r\n")
    %{state | phase: :pre_register}
  end

  defp maybe_send_cap_end(state), do: state

  defp maybe_nickserv_identify(%__MODULE__{auth_method: :nickserv_identify, password: pw} = state)
       when is_binary(pw) and pw != "" do
    :ok = transport_send(state, "PRIVMSG NickServ :IDENTIFY #{pw}\r\n")
    state
  end

  defp maybe_nickserv_identify(state), do: state

  # SASL PLAIN payload is `\0<authzid>\0<authcid>\0<password>`. We use
  # `sasl_user` for both authzid and authcid — they only differ when the
  # operator wants to authenticate as one identity but appear as another,
  # which Grappa doesn't expose in the credential schema.
  defp sasl_plain_payload(state) do
    Base.encode64(<<0, state.sasl_user::binary, 0, state.sasl_user::binary, 0, state.password::binary>>)
  end

  defp parse_caps(blob) do
    blob
    |> String.split(" ", trim: true)
    |> Enum.map(fn cap -> cap |> String.split("=", parts: 2) |> List.first() end)
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
