defmodule Grappa.IRC.Client do
  @moduledoc """
  GenServer that owns one upstream IRC socket (TCP or TLS) and
  bidirectionally translates between bytes-on-the-wire and
  `Grappa.IRC.Message` structs.

  Inbound lines from the socket are parsed via `Grappa.IRC.Parser` and
  dispatched as `{:irc, %Message{}}` to the configured `:dispatch_to`
  pid (typically the `Grappa.Session.Server` that supervises this
  client) — every parsed line is forwarded, including the auth-handshake
  numerics this module also runs through the FSM internally. Outbound
  lines are sent verbatim — callers can use the high-level helpers
  (`send_privmsg/3`, `send_join/2`, etc.) or the raw `send_line/2` for
  unframed wire bytes.

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

  ## Auth handshake — delegated to `Grappa.IRC.AuthFSM`

  The full IRCv3 CAP/SASL/NickServ handshake lives in
  `Grappa.IRC.AuthFSM` as a pure state machine (extracted in CP10 D2
  per the 2026-04-27 architecture review finding A3). This module
  validates auth opts via `AuthFSM.new/1` at boot, flushes
  `AuthFSM.initial_handshake/1` bytes after the socket comes up, and
  drives `AuthFSM.step/2` per inbound line — each step returns the
  next FSM state plus a list of `iodata()` frames to flush via
  `transport_send/2`. The Phase 6 listener facade reuses the same FSM
  without inheriting this GenServer.

  ## Crash semantics

  `start_link/1` links the Client to its caller — typically the
  `Session.Server` GenServer. A socket close (`:tcp_closed` /
  `:ssl_closed`) stops the Client with `:tcp_closed` / `:ssl_closed`
  reason, which propagates the link signal upward. AuthFSM stop
  reasons (`{:sasl_failed, 904 | 905}`, `:sasl_unavailable`,
  `{:nick_rejected, 432 | 433, nick}`) propagate the same way. The
  Session is then restarted by its `DynamicSupervisor` (transient
  policy on abnormal exit), spawning a fresh Client.
  Reconnect-with-backoff is Phase 5; Phase 1/2 take the simpler
  "let it crash" route.
  """
  use GenServer

  alias Grappa.IRC.{AuthFSM, Identifier, Message, Parser}

  require Logger

  @type opts :: %{
          required(:host) => String.t() | charlist(),
          required(:port) => :inet.port_number(),
          required(:tls) => boolean(),
          required(:dispatch_to) => pid(),
          required(:logger_metadata) => keyword(),
          required(:nick) => String.t(),
          required(:realname) => String.t(),
          required(:sasl_user) => String.t(),
          required(:auth_method) => AuthFSM.auth_method(),
          optional(:password) => String.t() | nil
        }

  @type t :: %__MODULE__{
          socket: :gen_tcp.socket() | :ssl.sslsocket() | nil,
          transport: :tcp | :ssl,
          dispatch_to: pid(),
          fsm: AuthFSM.t()
        }

  # `:socket` is intentionally NOT enforced — pre-connect (between `init/1`
  # returning and `handle_continue(:connect, _)` running) it is `nil`. Every
  # code path that touches the socket runs from `handle_info` / `handle_call`,
  # both of which are queued behind the `{:continue, :connect}` per OTP, so
  # the only legal `socket: nil` window is bounded by the continue.
  @enforce_keys [:transport, :dispatch_to, :fsm]
  defstruct [:socket, :transport, :dispatch_to, :fsm]

  # Cluster visitor-auth hotfix: pre-crash throttle when do_connect/3
  # fails (ECONNREFUSED, ECONNRESET, ssl handshake :closed, etc.).
  # Without it, the DynamicSupervisor's :transient restart cycle spins
  # at full CPU speed (~2000 attempts/sec for refused TCP) and
  # DoS-pummels upstream IRC servers — azzurra k-lined the bouncer's
  # IP during cluster smoke before this landed.
  #
  # H1 (S17 review): the throttle uses `Process.send_after/3` + a
  # deferred `{:stop, ...}` from a `handle_info` callback rather than
  # `Process.sleep/1` inline in `handle_continue/2`. Pre-H1 the inline
  # sleep blocked the GenServer mailbox for the entire throttle window
  # — operator-issued `DynamicSupervisor.terminate_child` waited up to
  # the full sleep per child (3 sessions = 90s for the documented S16
  # mitigation cascade). The `send_after` pattern bounds the same
  # restart rate (next start happens after the timer fires + the
  # `:stop` exit signal) without holding the mailbox hostage; an
  # operator-issued exit signal terminates the process immediately.
  # Phase 5 replaces this throttle with proper exponential backoff +
  # per-session health tracking + jitter (`docs/todo.md`).
  #
  # Tests override via `config/test.exs` to keep `init/1`-non-blocking
  # assertions snappy. Module-attribute MUST be defined BEFORE
  # `handle_continue/2` references it — mis-ordering silently bakes
  # `nil` into the attribute (recurring CLAUDE.md vigilance item).
  @connect_failure_sleep_ms Application.compile_env(
                              :grappa,
                              :irc_client_connect_failure_sleep_ms,
                              30_000
                            )

  ## API

  @doc """
  Spawns and links the Client. `opts` MUST carry `:nick` and
  `:auth_method` — `init/1` builds the AuthFSM and drives the upstream
  registration handshake the moment the socket is up, so the auth fields
  are non-optional. Returns the standard `t:GenServer.on_start/0` shape.
  """
  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  @doc """
  Sends raw bytes verbatim to the upstream socket. The caller is
  responsible for CR/LF framing and IRC syntax. Used by the high-level
  helpers below; tests and lower-level paths can call directly.

  Synchronous: returns only after `transport_send/2` has completed
  inside the GenServer. Callers can chain a follow-up that depends on
  the bytes being on the wire (notably `Networks.disconnect/2`'s
  QUIT-then-`stop_session/2` sequence) without racing the socket
  close. The mailbox queues sends behind any prior message, so write
  ordering is preserved per-Client. There's no measurable throughput
  cost: `transport_send/2` is the same `:gen_tcp.send` /
  `:ssl.send` whether invoked from `handle_cast` or `handle_call`,
  and the line-rate IRC traffic this Client carries is nowhere near
  GenServer-call overhead bounds.
  """
  @spec send_line(pid(), iodata()) :: :ok
  def send_line(client, line), do: GenServer.call(client, {:send, line})

  @doc """
  Sends `PRIVMSG <target> :<body>\\r\\n`. Rejects CR/LF/NUL in either
  field with `{:error, :invalid_line}` — see
  `Grappa.IRC.Identifier.safe_line_token?/1` for the rationale.
  """
  @spec send_privmsg(pid(), String.t(), String.t()) :: :ok | {:error, :invalid_line}
  def send_privmsg(client, target, body) do
    if Identifier.safe_line_token?(target) and Identifier.safe_line_token?(body) do
      send_line(client, "PRIVMSG #{target} :#{body}\r\n")
    else
      {:error, :invalid_line}
    end
  end

  @doc "Sends `JOIN <channel>\\r\\n`. Rejects CR/LF/NUL with `{:error, :invalid_line}`."
  @spec send_join(pid(), String.t()) :: :ok | {:error, :invalid_line}
  def send_join(client, channel) do
    if Identifier.safe_line_token?(channel),
      do: send_line(client, "JOIN #{channel}\r\n"),
      else: {:error, :invalid_line}
  end

  @doc "Sends `PART <channel>\\r\\n`. Rejects CR/LF/NUL with `{:error, :invalid_line}`."
  @spec send_part(pid(), String.t()) :: :ok | {:error, :invalid_line}
  def send_part(client, channel) do
    if Identifier.safe_line_token?(channel),
      do: send_line(client, "PART #{channel}\r\n"),
      else: {:error, :invalid_line}
  end

  @doc """
  Sends `TOPIC <channel> :<body>\\r\\n`. The colon prefix marks the body
  as a trailing param so spaces are preserved verbatim. Rejects CR/LF/NUL
  in either field, AND a malformed channel name (missing `#`/`&`/`+`/`!`
  prefix or embedded whitespace), with `{:error, :invalid_line}`.

  Used by `Grappa.Session.send_topic/4` (the `/topic` slash command in
  cicchetto's compose box).
  """
  @spec send_topic(pid(), String.t(), String.t()) :: :ok | {:error, :invalid_line}
  def send_topic(client, channel, body) do
    if Identifier.safe_line_token?(channel) and Identifier.safe_line_token?(body) and
         Identifier.valid_channel?(channel) do
      send_line(client, "TOPIC #{channel} :#{body}\r\n")
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Sends `NICK <new>\\r\\n`. Rejects CR/LF/NUL + malformed nick (whitespace,
  non-RFC-2812 chars) with `{:error, :invalid_line}`. The upstream replays
  the NICK back so `Grappa.Session.EventRouter`'s NICK handler reconciles
  `state.nick` and emits the per-channel `:nick_change` persist effects;
  no scrollback row is written by this helper.
  """
  @spec send_nick(pid(), String.t()) :: :ok | {:error, :invalid_line}
  def send_nick(client, nick) do
    if Identifier.safe_line_token?(nick) and Identifier.valid_nick?(nick) do
      send_line(client, "NICK #{nick}\r\n")
    else
      {:error, :invalid_line}
    end
  end

  @doc "Sends `QUIT :<reason>\\r\\n`. Rejects CR/LF/NUL with `{:error, :invalid_line}`."
  @spec send_quit(pid(), String.t()) :: :ok | {:error, :invalid_line}
  def send_quit(client, reason) do
    if Identifier.safe_line_token?(reason),
      do: send_line(client, "QUIT :#{reason}\r\n"),
      else: {:error, :invalid_line}
  end

  @doc """
  Sends `AWAY :<reason>\\r\\n` (set) or bare `AWAY\\r\\n` (unset).

  - `send_away(client, reason)` with a non-nil `reason` sends `AWAY :reason`.
    Rejects CR/LF/NUL in the reason with `{:error, :invalid_line}`.
  - `send_away_unset(client)` sends bare `AWAY\\r\\n` to clear any active away
    status. Callers MUST use the separate arity — `send_away(client, nil)` is
    not a valid public call (no default-arg path per CLAUDE.md).

  IRC semantics: a bare `AWAY` with no trailing param clears away status
  (RFC 2812 §4.6). A populated `AWAY :reason` sets it. The two-function
  shape makes the distinction explicit at the call site.
  """
  @spec send_away(pid(), String.t()) :: :ok | {:error, :invalid_line}
  def send_away(client, reason) when is_binary(reason) do
    if Identifier.safe_line_token?(reason),
      do: send_line(client, "AWAY :#{reason}\r\n"),
      else: {:error, :invalid_line}
  end

  @doc "Sends bare `AWAY\\r\\n` to unset away status. No validation needed."
  @spec send_away_unset(pid()) :: :ok
  def send_away_unset(client), do: send_line(client, "AWAY\r\n")

  @doc """
  Sends `PONG :<token>\\r\\n` in response to an upstream PING.

  Unlike the other outbound helpers, this one has no
  `safe_line_token?/1` guard: the token is parser-clean.
  `Grappa.IRC.Parser.strip_unsafe_bytes/1` strips the three bytes
  (`\\x00`, `\\r`, `\\n`) that `Identifier.safe_line_token?/1` rejects
  before grammar parsing, so the parser invariant matches the token
  contract — by the time `Session.Server` echoes the token here it
  cannot carry any of those bytes. H12 (decision G) closed the
  pre-cluster gap where `Parser.strip_crlf/1` covered only CR/LF
  while `safe_line_token?/1` also rejected NUL. Contract is `:ok`;
  callers do `:ok = send_pong(...)`.
  """
  @spec send_pong(pid(), String.t()) :: :ok
  def send_pong(client, token), do: send_line(client, "PONG :#{token}\r\n")

  ## GenServer callbacks

  # `init/1` is intentionally non-blocking — TCP/TLS connect + handshake
  # live in `handle_continue(:connect, _)`. CLAUDE.md OTP discipline:
  # "blocking work in `init/1` without `{:continue, _}`" freezes the
  # parent supervisor's `start_child` loop on a flapping upstream. The
  # `{:continue, {:connect, opts}}` shape carries the connect inputs as
  # the continue term so the prelim state struct stays sealed (no
  # connect-config fields leaking onto runtime state).
  @impl GenServer
  def init(opts) do
    Logger.metadata(opts.logger_metadata)

    # TLS posture warning fires BEFORE AuthFSM.new/1 — `init/1` may abort
    # if the FSM rejects the opts (missing password etc.), and we want
    # the warning to land regardless. The warning is observability, not
    # contingent on handshake validity. Phase 5 hardening will move this
    # to `Bootstrap` per `lib/grappa/bootstrap.ex` (CP10 finding S24).
    if opts.tls do
      Logger.warning("phase 1 TLS posture: verify_none — no certificate chain validation. Phase 5 hardens this.")
    end

    case AuthFSM.new(opts) do
      {:ok, fsm} ->
        state = %__MODULE__{
          socket: nil,
          transport: if(opts.tls, do: :ssl, else: :tcp),
          dispatch_to: opts.dispatch_to,
          fsm: fsm
        }

        {:ok, state, {:continue, {:connect, opts}}}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl GenServer
  def handle_continue({:connect, opts}, state) do
    host = to_charlist(opts.host)

    case do_connect(host, opts.port, opts.tls) do
      {:ok, socket} ->
        connected = %{state | socket: socket}
        {fsm, sends} = AuthFSM.initial_handshake(state.fsm)
        Enum.each(sends, &(:ok = transport_send(connected, &1)))
        {:noreply, %{connected | fsm: fsm}}

      {:error, reason} ->
        Process.send_after(self(), {:connect_failed_giveup, reason}, @connect_failure_sleep_ms)
        {:noreply, state}
    end
  end

  @impl GenServer
  def handle_info({:tcp, _, line}, state), do: process_line(line, state)
  def handle_info({:ssl, _, line}, state), do: process_line(line, state)
  def handle_info({:tcp_closed, _}, state), do: {:stop, :tcp_closed, state}
  def handle_info({:ssl_closed, _}, state), do: {:stop, :ssl_closed, state}

  # H1 — connect-fail throttle deferred-stop. See @connect_failure_sleep_ms
  # docstring for the rationale. Pairs with handle_continue's send_after.
  def handle_info({:connect_failed_giveup, reason}, state) do
    {:stop, {:connect_failed, reason}, state}
  end

  def handle_info(msg, state) do
    Logger.warning("unexpected mailbox message", unexpected: inspect(msg))
    {:noreply, state}
  end

  @impl GenServer
  def handle_call({:send, line}, _, state) do
    :ok = transport_send(state, line)
    {:reply, :ok, state}
  end

  ## Connection

  # Explicit 30s connect timeout on both transports. The Erlang default
  # is `:infinity` — a black-holed SYN would deadlock `handle_continue`
  # forever, leaving the GenServer alive-but-unreachable until
  # `:gen_tcp` / `:ssl` give up. 30s is the standard upstream-handshake
  # ceiling; Phase 5 reconnect/backoff revisits this when retry policy
  # lands.
  @connect_timeout_ms 30_000

  defp do_connect(host, port, false) do
    :gen_tcp.connect(host, port, [:binary, packet: :line, active: :once], @connect_timeout_ms)
  end

  defp do_connect(host, port, true) do
    :ssl.connect(
      host,
      port,
      [:binary, packet: :line, active: :once, verify: :verify_none],
      @connect_timeout_ms
    )
  end

  ## Inbound

  defp process_line(line, state) do
    case Parser.parse(line) do
      {:ok, msg} ->
        # Forward the parsed message to the supervising Session BEFORE
        # running the FSM step — every parsed line lands in the dispatch
        # mailbox even when the FSM also acts on it (CAP, AUTHENTICATE,
        # numerics 001/903/904/905/432/433). The Session's catch-all
        # `handle_info` swallows what it doesn't pattern-match.
        send(state.dispatch_to, {:irc, msg})
        run_fsm_step(msg, state)

      {:error, reason} ->
        Logger.warning("irc parse failed", reason: reason, raw: inspect(line))
        :ok = transport_setopts(state, active: :once)
        {:noreply, state}
    end
  end

  defp run_fsm_step(%Message{} = msg, state) do
    case AuthFSM.step(state.fsm, msg) do
      {:cont, fsm, sends} ->
        Enum.each(sends, &(:ok = transport_send(state, &1)))
        :ok = transport_setopts(state, active: :once)
        {:noreply, %{state | fsm: fsm}}

      {:stop, reason, fsm, sends} ->
        Enum.each(sends, &(:ok = transport_send(state, &1)))
        log_stop_reason(reason, fsm)
        {:stop, reason, %{state | fsm: fsm}}
    end
  end

  # Logger metadata is set in init/1 from `opts.logger_metadata` so the
  # SASL/nick fields land on every emit alongside `network` and friends.
  # The reason atom carries the structured data; the AuthFSM struct
  # supplies `sasl_user` for the SASL-related lines.
  defp log_stop_reason({:sasl_failed, code}, fsm) do
    Logger.error("sasl auth failed", numeric: code, sasl_user: fsm.sasl_user)
  end

  defp log_stop_reason(:sasl_unavailable, fsm) do
    Logger.error("sasl required but not advertised by server", sasl_user: fsm.sasl_user)
  end

  defp log_stop_reason({:nick_rejected, code, nick}, _) do
    Logger.error("upstream rejected nick", numeric: code, nick: nick)
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
