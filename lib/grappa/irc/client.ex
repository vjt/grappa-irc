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

  alias Grappa.IRC.{Identifier, Message, Parser}

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
          required(:realname) => String.t(),
          required(:sasl_user) => String.t(),
          required(:auth_method) => auth_method(),
          optional(:password) => String.t() | nil
        }

  @type phase ::
          :pre_register
          | :awaiting_cap_ls
          | :awaiting_cap_ack
          | :sasl_pending
          | :registered

  @type t :: %__MODULE__{
          socket: :gen_tcp.socket() | :ssl.sslsocket() | nil,
          transport: :tcp | :ssl,
          dispatch_to: pid(),
          nick: String.t(),
          realname: String.t(),
          sasl_user: String.t(),
          password: String.t() | nil,
          auth_method: auth_method(),
          phase: phase(),
          caps_buffer: [String.t()]
        }

  # `:socket` is intentionally NOT enforced — pre-connect (between `init/1`
  # returning and `handle_continue(:connect, _)` running) it is `nil`. Every
  # code path that touches the socket runs from `handle_info` / `handle_cast`,
  # both of which are queued behind the `{:continue, :connect}` per OTP, so
  # the only legal `socket: nil` window is bounded by the continue.
  @enforce_keys [
    :transport,
    :dispatch_to,
    :nick,
    :realname,
    :sasl_user,
    :auth_method,
    :phase
  ]
  # `:password` is the only secret on the struct — `@derive Inspect` excludes
  # it so SASL-report dumps + IEx `:sys.get_state/1` introspection never leak
  # plaintext. CLAUDE.md "Credentials ... never logged."
  @derive {Inspect, except: [:password]}
  defstruct [
    :socket,
    :transport,
    :dispatch_to,
    :nick,
    :realname,
    :sasl_user,
    :password,
    :auth_method,
    :phase,
    caps_buffer: []
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

  @doc "Sends `QUIT :<reason>\\r\\n`. Rejects CR/LF/NUL with `{:error, :invalid_line}`."
  @spec send_quit(pid(), String.t()) :: :ok | {:error, :invalid_line}
  def send_quit(client, reason) do
    if Identifier.safe_line_token?(reason),
      do: send_line(client, "QUIT :#{reason}\r\n"),
      else: {:error, :invalid_line}
  end

  @doc """
  Sends `PONG :<token>\\r\\n` in response to an upstream PING.

  Unlike the other outbound helpers, this one has no CR/LF guard: the
  token is parser-supplied — `Grappa.IRC.Parser` strips ALL `\\r`/`\\n`
  from inbound bytes (the parser invariant pinned in C6 / S5), so by
  the time `Session.Server` echoes the token here it cannot contain
  CR/LF. Contract is `:ok`; callers do `:ok = send_pong(...)`.
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
  def init(%{auth_method: m} = opts) when m in @auth_methods do
    Logger.metadata(opts.logger_metadata)

    # Boundary contract: `:none` is the only auth_method that doesn't
    # need a password. The Credential schema validates the same
    # invariant on the write side (`Networks.Credential.validate_password_for_auth_method/1`)
    # — pinning it here too means any caller (Bootstrap, REPL,
    # tests) that hands Client a half-built opts map crashes at boot
    # rather than mid-SASL with a `<< nil :: binary >>` ArgumentError.
    case validate_password_present(opts) do
      :ok ->
        # TLS posture warning fires synchronously in init/1 (NOT
        # handle_continue) so a linked-caller-dies-early scenario
        # — `Process.flag(:trap_exit, true); spawn(fn -> start_link end)`
        # — still emits the warning before the Client process is
        # SIGTERM'd by the dying spawn link. Phase 5 hardening will
        # move this to `Bootstrap` per `lib/grappa/bootstrap.ex` (CP10
        # finding S24); for now keep it where the existing TLS warning
        # test pins it.
        if opts.tls do
          Logger.warning("phase 1 TLS posture: verify_none — no certificate chain validation. Phase 5 hardens this.")
        end

        {:ok, build_initial_state(opts), {:continue, {:connect, opts}}}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  defp validate_password_present(%{auth_method: :none}), do: :ok

  defp validate_password_present(%{password: pw}) when is_binary(pw) and pw != "",
    do: :ok

  defp validate_password_present(%{auth_method: m}),
    do: {:error, {:missing_password, m}}

  defp build_initial_state(opts) do
    %__MODULE__{
      socket: nil,
      transport: if(opts.tls, do: :ssl, else: :tcp),
      dispatch_to: opts.dispatch_to,
      nick: opts.nick,
      realname: opts.realname,
      sasl_user: opts.sasl_user,
      password: Map.get(opts, :password),
      auth_method: opts.auth_method,
      phase: :pre_register,
      caps_buffer: []
    }
  end

  @impl GenServer
  def handle_continue({:connect, opts}, state) do
    host = to_charlist(opts.host)

    case do_connect(host, opts.port, opts.tls) do
      {:ok, socket} ->
        {:noreply, perform_initial_handshake(%{state | socket: socket})}

      {:error, reason} ->
        {:stop, {:connect_failed, reason}, state}
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
    {:cont, leave_cap_negotiation(state, :pre_register)}
  end

  defp handle_irc(%Message{command: {:numeric, code}}, state) when code in [904, 905] do
    Logger.error("sasl auth failed", numeric: code, sasl_user: state.sasl_user)
    {:stop, {:sasl_failed, code}, state}
  end

  # 432 ERR_ERRONEUSNICKNAME / 433 ERR_NICKNAMEINUSE during registration.
  # Without an explicit handler the Client would sit in `:pre_register` /
  # `:awaiting_cap_*` forever; surface as a structured stop reason so
  # the supervised Session restart fails again identically (correct —
  # the credential nick is wrong, an operator must intervene).
  # Phase 5 may add nick-mangling fallback (append "_") here.
  defp handle_irc(%Message{command: {:numeric, code}}, state)
       when code in [432, 433] do
    Logger.error("upstream rejected nick", numeric: code, nick: state.nick)
    {:stop, {:nick_rejected, code, state.nick}, state}
  end

  defp handle_irc(%Message{command: {:numeric, 1}}, state) do
    {:cont, leave_cap_negotiation(maybe_nickserv_identify(state), :registered)}
  end

  defp handle_irc(_, state), do: {:cont, state}

  # CAP LS continuation: 4th param == "*" marks "more lines coming."
  # IRCv3.2 splits long cap lists; accumulate in state.caps_buffer
  # until a non-* LS line finalizes the set. Without this, modern
  # ircd advertising >8 caps would land "sasl" in the second line and
  # the first line's mismatch would already have triggered
  # cap_unavailable.
  #
  # Phase guard: a stray CAP LS post-registration (CAP NEW spam, buggy
  # upstream emitting `:server CAP nick LS * :junk` repeatedly) MUST
  # NOT mutate caps_buffer — without the guard the buffer grows
  # unbounded until OOM. `finalize_cap_ls/2` already gates on
  # `:awaiting_cap_ls`; the continuation clauses must do the same so
  # the strays are absorbed by the catch-all below.
  #
  # `++` copies its left argument, so put the smaller list on the left:
  # `chunk ++ buffer` is O(|chunk|) (bounded — IRCv3 lines fit ~15 caps
  # before splitting), while `buffer ++ chunk` would be O(|buffer|) and
  # grow with N accumulated chunks, turning an N-line CAP LS into O(N²)
  # work. Final cap-set order is irrelevant; `"sasl" in caps` is the
  # only consumer.
  defp handle_cap([_, "LS", "*", chunk], %{phase: :awaiting_cap_ls} = state) do
    {:cont, %{state | caps_buffer: parse_cap_list(chunk) ++ state.caps_buffer}}
  end

  defp handle_cap([_, "LS", chunk], %{phase: :awaiting_cap_ls} = state) do
    caps = parse_cap_list(chunk) ++ state.caps_buffer
    finalize_cap_ls(caps, state)
  end

  # CAP ACK for a previously-REQ'd cap. The IRCv3 SASL flow REQUIRES
  # AUTHENTICATE PLAIN to land AFTER the server has ACK'd the cap —
  # back-to-back CAP REQ + AUTHENTICATE works on lenient ircd but
  # strict implementations (Solanum, Ergo) reject the AUTHENTICATE
  # against an un-ACK'd cap. Phase guard makes this a no-op outside
  # the SASL chain (defensive against stray ACKs post-registration).
  defp handle_cap([_, "ACK", caps_blob | _], %{phase: :awaiting_cap_ack} = state) do
    if "sasl" in parse_cap_list(caps_blob) do
      :ok = transport_send(state, "AUTHENTICATE PLAIN\r\n")
      {:cont, %{state | phase: :sasl_pending}}
    else
      cap_unavailable(state)
    end
  end

  defp handle_cap([_, "NAK", _ | _], %{phase: :awaiting_cap_ack} = state),
    do: cap_unavailable(state)

  defp handle_cap(_, state), do: {:cont, state}

  # Phase guard lives in the `handle_cap` LS clauses above: a stray
  # post-registration CAP LS never reaches here. Caller invariant:
  # `state.phase == :awaiting_cap_ls`.
  defp finalize_cap_ls(caps, state) do
    if "sasl" in caps and state.auth_method in [:auto, :sasl] do
      :ok = transport_send(state, "CAP REQ :sasl\r\n")
      {:cont, leave_cap_negotiation(state, :awaiting_cap_ack)}
    else
      cap_unavailable(state)
    end
  end

  # SASL not on offer (or NAK'd). Mandatory SASL (`:sasl`) crashes;
  # `:auto` falls back to the PASS-handoff path (PASS already sent at
  # init for legacy ircd) and ends CAP negotiation cleanly.
  defp cap_unavailable(%{auth_method: :sasl} = state) do
    Logger.error("sasl required but not advertised by server", sasl_user: state.sasl_user)
    state = maybe_send_cap_end(state)
    {:stop, :sasl_unavailable, state}
  end

  defp cap_unavailable(state) do
    state = maybe_send_cap_end(state)
    {:cont, state}
  end

  defp maybe_send_cap_end(%{phase: phase} = state)
       when phase in [:awaiting_cap_ls, :awaiting_cap_ack, :sasl_pending] do
    :ok = transport_send(state, "CAP END\r\n")
    leave_cap_negotiation(state, :pre_register)
  end

  defp maybe_send_cap_end(state), do: state

  # Single source of truth for ANY phase change that should clear
  # `:caps_buffer`. `:caps_buffer` accumulates ONLY during
  # `:awaiting_cap_ls` and MUST be empty whenever the phase leaves
  # it. Owning both fields here means "exiting a phase clears all
  # phase-local state" lives in ONE place — no per-callsite reminder
  # to also-clear-the-buffer (today's S6 latency, Phase 5 reconnect's
  # bug). Routed by every transition out of `:awaiting_cap_ls`:
  #
  #   * finalize_cap_ls (LS → AWAIT_ACK)
  #   * handle_irc(numeric 1, _) (LS → REGISTERED)
  #   * handle_irc(numeric 903, _) (SASL_PENDING → PRE_REGISTER)
  #   * maybe_send_cap_end (any cap-phase → PRE_REGISTER)
  #
  # The helper name still says "leave_cap_negotiation" because the
  # AWAIT_ACK target is mid-flight; the consumer that grew the buffer
  # is `:awaiting_cap_ls`, and that's the consumer this clears for.
  defp leave_cap_negotiation(state, new_phase) do
    %{state | phase: new_phase, caps_buffer: []}
  end

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
  #
  # S29 H10: explicit `is_binary(pw)` guard so a contract violation
  # (state.password somehow nil at the AUTHENTICATE + step) crashes
  # with `FunctionClauseError` naming this clause instead of an
  # opaque `<<nil::binary>>` :badarg from the bitstring builder.
  # `init/1`'s `validate_password_present/1` is the primary gate;
  # this guard is defense-in-depth for any future code path that
  # mutates `state.password` after init.
  defp sasl_plain_payload(%{sasl_user: u, password: pw}) when is_binary(u) and is_binary(pw) do
    Base.encode64(<<0, u::binary, 0, u::binary, 0, pw::binary>>)
  end

  # Parse a CAP LS / CAP ACK cap-list blob: space-separated cap tokens,
  # each optionally suffixed with `=<value>` (we drop the value, keeping
  # only the cap name) — IRCv3.2 cap negotiation only inspects names.
  defp parse_cap_list(blob) do
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
