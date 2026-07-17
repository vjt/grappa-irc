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
  (`send_privmsg/3`, `send_join/3`, etc.) or the raw `send_line/2` for
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

  ## TLS posture (#89 — verify_peer)

  When started with `tls: true`, the connection uses
  `verify: :verify_peer` — full certificate-chain validation against the
  operator's **system CA trust store** (`:public_key.cacerts_get/0`, OTP
  25+). This closes the Phase-1 `verify: :verify_none` expedient.

  ### Operator trust-store strategy

  The anchor set is the host's OS CA bundle — grappa ships no cacertfile
  and rotates no pinned cert. `:public_key.cacerts_get/0` reads the
  platform store: `/etc/ssl/cert.pem` on FreeBSD (the prod bastille jail),
  the ca-certificates bundle on Linux, the system keychain on macOS. Keep
  that bundle current the way you keep any other (FreeBSD: the
  `ca_root_nss` package; Linux: `update-ca-certificates`).

  Verification is three-fold: (1) the chain must validate to a trusted
  root within `depth: 3`; (2) `server_name_indication` sends SNI so a
  round-robin pool member serves the cert whose SAN covers the dialed
  host; (3) `customize_hostname_check` with the RFC-6125 `:https`
  match_fun rejects a valid-CA cert issued for a different host. See
  `tls_connect_opts/1` for the per-opt rationale.

  If the upstream presents a cert that does NOT chain to a system-trusted
  CA (a private/self-signed IRC network), the connect fails at the TLS
  handshake and the existing connect-fail throttle + `:transient` give-up
  path handles it — the operator must add that network's CA to the system
  trust store (the standard OS mechanism), not weaken grappa. An
  `init/1` `Logger.info` line records the verify_peer posture per
  connection so it's visible in logs, not buried in code.

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
  policy on abnormal exit), spawning a fresh Client — the reconnect is
  paced by `Grappa.Session.Backoff` (per-(subject, network) exponential
  ladder, ±25% jitter, 5-min cap).

  ## Liveness watchdog (#100)

  `:tcp_closed`/`:ssl_closed` only fire on a graceful FIN or RST. A
  half-open socket (mobile radio drop, NAT idle-eviction) leaves no
  signal and would hang until the OS TCP keepalive (~2h). The liveness
  watchdog closes that gap: after `@liveness_idle_ms` of inbound silence
  the Client sends its own `PING`; if `@liveness_timeout_ms` passes with
  still no inbound, it stops with `:ping_timeout`, feeding the same
  link-EXIT → Backoff → `:transient` respawn chain. See the
  `@liveness_idle_ms` docstring for the full two-phase cycle.
  """
  use GenServer

  alias Grappa.IRC.{AuthFSM, Identifier, Message, Parser}

  require Logger

  # Codebase review 2026-05-12 irc/S6: pre-fix `:logger_metadata` was
  # typed `keyword()` — any caller could legally pass arbitrary keys
  # which `Logger.metadata/1` accepts but the formatter then silently
  # drops at format time (the allowlist in `config/config.exs` is the
  # gate). Investigation: today the only caller is `Session.Server`
  # via `Grappa.Log.session_context/2` which returns the
  # `[user: String.t(), network: String.t()]` keyword list. Both keys
  # ARE in the allowlist; the silent-drop risk is for FUTURE callers.
  # Tightening to a structural alias surfaces drift at Dialyzer time
  # rather than as missing log fields in production. The shape mirrors
  # `Grappa.Log.session_metadata/0` but lives here so the IRC client
  # remains free of the optional `Grappa.Log` dep (extraction memory
  # `project_extract_irc_libs`).
  @type session_metadata :: [user: String.t(), network: String.t()]

  # Return shape of every public `send_*` helper. `:invalid_line` is the
  # high-level guard against CR/LF/NUL in user-supplied params; the
  # transport-level errors (`:no_socket | :closed | :inet.posix()`) are
  # honest tagged tuples from `transport_send/2` when the underlying
  # TCP/SSL socket is gone (connect_failed pre-assignment, recv-loop
  # nilled post-tcp_closed, peer-RST race mid-SEND). All `send_*`
  # callers should `_ = `-discard or `case`-match — the helpers never
  # raise. See `handle_call({:send, _}, _, _)` for the U-cluster
  # fix history.
  @type send_result ::
          :ok | {:error, :invalid_line | :no_socket | :closed | :inet.posix()}

  @type opts :: %{
          required(:host) => String.t() | charlist(),
          required(:port) => :inet.port_number(),
          required(:tls) => boolean(),
          required(:dispatch_to) => pid(),
          required(:logger_metadata) => session_metadata(),
          required(:nick) => String.t(),
          required(:ident) => String.t(),
          required(:realname) => String.t(),
          required(:sasl_user) => String.t(),
          required(:auth_method) => AuthFSM.auth_method(),
          optional(:password) => String.t() | nil,
          optional(:source_address) => String.t() | nil,
          # #100 liveness watchdog — test seam. Production omits both and
          # inherits the `@liveness_*_ms` config defaults; tests inject tiny
          # values so the two-phase cycle runs in milliseconds.
          optional(:liveness_idle_ms) => pos_integer(),
          optional(:liveness_timeout_ms) => pos_integer()
        }

  @type t :: %__MODULE__{
          socket: :gen_tcp.socket() | :ssl.sslsocket() | nil,
          transport: :tcp | :ssl,
          dispatch_to: pid(),
          fsm: AuthFSM.t(),
          # #100 liveness watchdog. `liveness_idle_ms` / `liveness_timeout_ms`
          # are static config for the process lifetime; `idle_timer` /
          # `ping_timer` are the two-phase timer refs (at most one armed at a
          # time — idle counts down inbound-silence, ping counts down the
          # self-PING reply window). Both nil pre-connect + between cycles.
          liveness_idle_ms: pos_integer(),
          liveness_timeout_ms: pos_integer(),
          idle_timer: reference() | nil,
          ping_timer: reference() | nil
        }

  # `:socket` is intentionally NOT enforced — pre-connect (between `init/1`
  # returning and `handle_continue(:connect, _)` running) it is `nil`. Every
  # code path that touches the socket runs from `handle_info` / `handle_call`,
  # both of which are queued behind the `{:continue, :connect}` per OTP, so
  # the only legal `socket: nil` window is bounded by the continue.
  #
  # #100: `liveness_idle_ms` / `liveness_timeout_ms` ARE enforced — they are
  # always resolved in `init/1` and a `nil` would crash `Process.send_after/3`
  # at arm time. Timer refs (`idle_timer` / `ping_timer`) start nil.
  @enforce_keys [:transport, :dispatch_to, :fsm, :liveness_idle_ms, :liveness_timeout_ms]
  defstruct [
    :socket,
    :transport,
    :dispatch_to,
    :fsm,
    :liveness_idle_ms,
    :liveness_timeout_ms,
    :idle_timer,
    :ping_timer
  ]

  # Cluster visitor-auth hotfix: pre-crash throttle when do_connect/5
  # fails (ECONNREFUSED, ECONNRESET, ssl handshake :closed, the
  # permanent {:source_family_mismatch, ...} misconfig, etc.).
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

  # #100 — liveness watchdog: the ONE genuinely-absent upstream-drop
  # trigger. `{:tcp_closed}`/`{:ssl_closed}` fire only on a graceful FIN
  # or RST; a half-open socket (mobile radio drop, NAT idle-eviction,
  # cable yanked) leaves NO signal and the connection hangs until the OS
  # TCP keepalive (~2h by default) — invisible for hours, no reconnect.
  #
  # The watchdog is a two-phase cycle driven purely by INBOUND activity:
  #
  #   1. After `@liveness_idle_ms` of inbound silence, send our own
  #      `PING :grappa-liveness` and start the reply window.
  #   2. If `@liveness_timeout_ms` elapses with STILL no inbound line, the
  #      peer is unreachable → `{:stop, :ping_timeout, state}`. That stop
  #      propagates as a link EXIT to `Session.Server`, whose abnormal
  #      terminate/2 clause records a Backoff failure and the `:transient`
  #      supervisor respawns — the EXISTING reconnect chain, no new path.
  #
  # ANY inbound line resets the cycle back to phase 1 (the server's PONG
  # to our probe, a channel PRIVMSG, an unsolicited server PING, a
  # numeric — anything). So a healthy connection, however quiet, always
  # answers the probe and can never be falsely declared dead; only a
  # genuinely silent socket trips the timeout.
  #
  # Defaults 60s idle / 30s timeout: comfortably above IRC's normal
  # server-PING cadence (most ircd ping every 90-180s, but ANY inbound
  # resets us, so 60s of TOTAL silence is already unusual) and well under
  # the OS keepalive. Opts-overridable (`:liveness_idle_ms` /
  # `:liveness_timeout_ms`) so tests drive the cycle in milliseconds
  # without touching production timing; `config/test.exs` leaves the
  # defaults intact so existing client tests that never inject the opts
  # never see a spurious probe within their sub-second windows.
  @liveness_idle_ms Application.compile_env(:grappa, [:irc_client, :liveness_idle_ms], 60_000)
  @liveness_timeout_ms Application.compile_env(
                         :grappa,
                         [:irc_client, :liveness_timeout_ms],
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

  Returns `:ok` on a successful write, or `{:error, :no_socket |
  :closed | :inet.posix()}` when the underlying transport is gone
  (connect_failed pre-assignment, peer RST in flight). Callers that
  don't care about delivery may `_ = `-discard the result;
  `Session.Server.terminate/2` does this for the best-effort QUIT.
  """
  @spec send_line(pid(), iodata()) :: send_result()
  def send_line(client, line), do: GenServer.call(client, {:send, line})

  @doc """
  Sends `PRIVMSG <target> :<body>\\r\\n`. Rejects CR/LF/NUL in either
  field with `{:error, :invalid_line}` — see
  `Grappa.IRC.Identifier.safe_line_token?/1` for the rationale. Also
  rejects an empty `target`: an empty recipient yields the malformed
  wire frame `PRIVMSG  :body\\r\\n` (double space, missing param)
  which the server quietly drops, leaving the operator to debug a
  silent no-op (codebase review irc/S3, 2026-05-12).
  """
  @spec send_privmsg(pid(), String.t(), String.t()) :: send_result()
  def send_privmsg(client, target, body) do
    if target != "" and Identifier.safe_line_token?(target) and Identifier.safe_line_token?(body) do
      send_line(client, "PRIVMSG #{target} :#{body}\r\n")
    else
      reject_invalid_line(:privmsg)
    end
  end

  @doc """
  Sends `JOIN <channel>\\r\\n` (when `key` is `nil`) or
  `JOIN <channel> <key>\\r\\n` (when `key` is a binary, RFC 2812 +k
  channel-key support — bucket F). Rejects CR/LF/NUL AND a malformed
  channel name (missing `#`/`&`/`+`/`!` prefix, embedded whitespace
  /comma/BELL, or length > 50) with `{:error, :invalid_line}`.
  Key (when present) must pass `safe_line_token?` — CR/LF/NUL/space
  cause a reject; the empty string is treated as "no key" (sent as the
  no-key form).
  Without the `valid_channel?` check (codebase review irc/S2,
  2026-05-12) the upstream-facing JOIN landed for malformed channels
  and the pending-window state machine wedged a `:pending` entry that
  never resolved.
  """
  @spec send_join(pid(), String.t(), String.t() | nil) :: send_result()
  def send_join(client, channel, nil) do
    if Identifier.safe_line_token?(channel) and Identifier.valid_channel?(channel),
      do: send_line(client, "JOIN #{channel}\r\n"),
      else: reject_invalid_line(:join)
  end

  def send_join(client, channel, "") do
    send_join(client, channel, nil)
  end

  def send_join(client, channel, key) when is_binary(key) do
    if Identifier.safe_line_token?(channel) and Identifier.valid_channel?(channel) and
         safe_join_key?(key),
       do: send_line(client, "JOIN #{channel} #{key}\r\n"),
       else: reject_invalid_line(:join)
  end

  # +k channel key — additionally rejects whitespace (space, tab) since
  # an embedded space would shift the JOIN wire param boundary and a
  # tab is not RFC-valid in a key. CR/LF/NUL caught by safe_line_token?.
  defp safe_join_key?(key) when is_binary(key) do
    Identifier.safe_line_token?(key) and
      not String.contains?(key, [" ", "\t"])
  end

  @doc """
  Sends `PART <channel>\\r\\n`. Rejects CR/LF/NUL AND a malformed
  channel name (missing `#`/`&`/`+`/`!` prefix, embedded whitespace
  /comma/BELL, or length > 50) with `{:error, :invalid_line}`. Same
  irc/S2 rationale as `send_join/3`.
  """
  @spec send_part(pid(), String.t()) :: send_result()
  def send_part(client, channel) do
    if Identifier.safe_line_token?(channel) and Identifier.valid_channel?(channel),
      do: send_line(client, "PART #{channel}\r\n"),
      else: reject_invalid_line(:part)
  end

  @doc """
  Sends `TOPIC <channel> :<body>\\r\\n`. The colon prefix marks the body
  as a trailing param so spaces are preserved verbatim. Rejects CR/LF/NUL
  in either field, AND a malformed channel name (missing `#`/`&`/`+`/`!`
  prefix or embedded whitespace), with `{:error, :invalid_line}`.

  Used by `Grappa.Session.send_topic/4` (the `/topic` slash command in
  cicchetto's compose box).
  """
  @spec send_topic(pid(), String.t(), String.t()) :: send_result()
  def send_topic(client, channel, body) do
    if Identifier.safe_line_token?(channel) and Identifier.safe_line_token?(body) and
         Identifier.valid_channel?(channel) do
      send_line(client, "TOPIC #{channel} :#{body}\r\n")
    else
      reject_invalid_line(:topic)
    end
  end

  @doc """
  Sends `NICK <new>\\r\\n`. Rejects CR/LF/NUL + malformed nick (whitespace,
  non-RFC-2812 chars) with `{:error, :invalid_line}`. The upstream replays
  the NICK back so `Grappa.Session.EventRouter`'s NICK handler reconciles
  `state.nick` and emits the per-channel `:nick_change` persist effects;
  no scrollback row is written by this helper.
  """
  @spec send_nick(pid(), String.t()) :: send_result()
  def send_nick(client, nick) do
    if Identifier.safe_line_token?(nick) and Identifier.valid_nick?(nick) do
      send_line(client, "NICK #{nick}\r\n")
    else
      reject_invalid_line(:nick)
    end
  end

  @doc "Sends `QUIT :<reason>\\r\\n`. Rejects CR/LF/NUL with `{:error, :invalid_line}`."
  @spec send_quit(pid(), String.t()) :: send_result()
  def send_quit(client, reason) do
    if Identifier.safe_line_token?(reason),
      do: send_line(client, "QUIT :#{reason}\r\n"),
      else: reject_invalid_line(:quit)
  end

  @doc """
  Sends `OPER <name> <password>\\r\\n`. Both fields go through the
  stricter `Identifier.safe_oper_token?/1` predicate: non-empty,
  no whitespace, no CR/LF/NUL. Rationale: IRC OPER is a 2-token
  wire frame; a space in either field would split the frame at
  the wrong boundary, leak the password into a positional slot,
  and/or yield silent 464 ERR_PASSWDMISMATCH replies (multi-word
  passwords are truncated to the first token by the server). The
  password is opaque to this client — the upstream server validates
  it and replies with numeric 381 (RPL_YOUREOPER, success) or 491
  (ERR_NOOPERHOST) / 464 (ERR_PASSWDMISMATCH) on failure.
  Bouncer-side: never log the line —
  `Session.Server.handle_call({:send_oper, ...})` redacts the
  password by emitting a static log message body (no interpolation).
  """
  @spec send_oper(pid(), String.t(), String.t()) :: send_result()
  def send_oper(client, name, password) do
    if Identifier.safe_oper_token?(name) and Identifier.safe_oper_token?(password),
      do: send_line(client, "OPER #{name} #{password}\r\n"),
      else: reject_invalid_line(:oper)
  end

  @doc """
  Raw IRC line escape hatch — used by `/quote` (issue #20 bundle).
  Validates that `line` has no embedded CR/LF/NUL (which would let the
  caller smuggle additional commands or terminate the frame early),
  then appends the trailing `\\r\\n` and ships it verbatim. The IRC
  server is the authority on protocol legality; this helper is the
  bouncer's "send anything that's a single safe line" door.

  Rejects empty `line` (the wire would be just `\\r\\n` which is
  protocol-illegal anyway).
  """
  @spec send_raw(pid(), String.t()) :: send_result()
  def send_raw(client, line) do
    if line != "" and Identifier.safe_line_token?(line),
      do: send_line(client, [line, "\r\n"]),
      else: reject_invalid_line(:raw)
  end

  @doc """
  Sends `AWAY :<reason>\\r\\n` (set) or bare `AWAY\\r\\n` (unset).

  - `send_away(client, reason)` with a non-empty `reason` sends `AWAY :reason`.
    Rejects an empty reason or CR/LF/NUL with `{:error, :invalid_line}`.
  - `send_away_unset(client)` sends bare `AWAY\\r\\n` to clear any active away
    status. Callers MUST use the separate arity — `send_away(client, nil)` is
    not a valid public call (no default-arg path per CLAUDE.md).

  IRC semantics: a bare `AWAY` with no trailing param clears away status
  (RFC 2812 §4.6). A populated `AWAY :reason` sets it. The two-function
  shape makes the distinction explicit at the call site.

  The empty-reason rejection mirrors `send_pong`/`send_raw`: an empty
  `AWAY :\\r\\n` IS the bare-AWAY un-away line, so accepting it here would
  emit a clear when the caller asked to set. The guard lives at this byte
  boundary (not only the `Session` facade) so a non-cic caller — the test
  harness or the Phase 6 listener facade — can't slip the silent-clear
  frame past this door even if the facade is bypassed. To clear, call
  `send_away_unset/1`.
  """
  @spec send_away(pid(), String.t()) :: send_result()
  def send_away(client, reason) when is_binary(reason) do
    if reason != "" and Identifier.safe_line_token?(reason),
      do: send_line(client, "AWAY :#{reason}\r\n"),
      else: reject_invalid_line(:away)
  end

  @doc "Sends bare `AWAY\\r\\n` to unset away status. No validation needed."
  @spec send_away_unset(pid()) :: send_result()
  def send_away_unset(client), do: send_line(client, "AWAY\r\n")

  @doc """
  Sends `PONG :<token>\\r\\n` in response to an upstream PING.

  The token is rejected with `{:error, :invalid_line}` when empty
  (would emit malformed `PONG :\\r\\n` with no token — RFC 2812 §3.7.3
  requires a server token in the trailing param) or when it carries
  any of the three CRLF/NUL framing bytes that
  `Grappa.IRC.Identifier.safe_line_token?/1` rejects.

  In normal operation `Grappa.IRC.Parser.strip_unsafe_bytes/1` strips
  the three bytes (`\\x00`, `\\r`, `\\n`) at the inbound boundary, so
  by the time `Session.Server` echoes the parsed token here it cannot
  carry any of those bytes — the safe-byte guard is defensive belt-
  and-braces against a future caller bypassing the parser path.
  H12 (decision G) closed the pre-cluster gap where
  `Parser.strip_crlf/1` covered only CR/LF while `safe_line_token?/1`
  also rejected NUL. S9 (cluster #10) closes the empty-token gap.
  """
  @spec send_pong(pid(), String.t()) :: send_result()
  def send_pong(client, token) do
    if token != "" and Identifier.safe_line_token?(token),
      do: send_line(client, "PONG :#{token}\r\n"),
      else: reject_invalid_line(:pong)
  end

  @doc """
  Sends `KICK <channel> <nick> :<reason>\\r\\n`. Validates the
  channel + nick syntax and rejects CR/LF/NUL in any field with
  `{:error, :invalid_line}`.

  Consolidates the raw `send_line` arm previously open-coded in
  `Grappa.Session.Server`'s `:send_kick` handle_call (resp-A4 close).
  """
  @spec send_kick(pid(), String.t(), String.t(), String.t()) :: send_result()
  def send_kick(client, channel, nick, reason) do
    if Identifier.valid_channel?(channel) and Identifier.valid_nick?(nick) and
         Identifier.safe_line_token?(reason) do
      send_line(client, "KICK #{channel} #{nick} :#{reason}\r\n")
    else
      reject_invalid_line(:kick)
    end
  end

  @doc """
  Sends `INVITE <nick> <channel>\\r\\n` (RFC 2812 §3.2.7 wire order:
  nick first, channel second). Validates nick + channel syntax and
  rejects malformed identifiers with `{:error, :invalid_line}`.

  Consolidates the raw `send_line` arm previously open-coded in
  `Grappa.Session.Server`'s `:send_invite` handle_call (resp-A4 close).
  """
  @spec send_invite(pid(), String.t(), String.t()) :: send_result()
  def send_invite(client, channel, nick) do
    if Identifier.valid_channel?(channel) and Identifier.valid_nick?(nick) do
      send_line(client, "INVITE #{nick} #{channel}\r\n")
    else
      reject_invalid_line(:invite)
    end
  end

  @doc """
  Sends `MODE <channel> b\\r\\n` — the banlist query form (no sign,
  just the mode letter). Numerics 367 RPL_BANLIST + 368
  RPL_ENDOFBANLIST reply with the ban list. Validates the channel
  syntax with `{:error, :invalid_line}` on rejection.

  Consolidates the raw `send_line` arm previously open-coded in
  `Grappa.Session.Server`'s `:send_banlist` handle_call (resp-A4 close).
  """
  @spec send_banlist(pid(), String.t()) :: send_result()
  def send_banlist(client, channel) do
    if Identifier.valid_channel?(channel),
      do: send_line(client, "MODE #{channel} b\r\n"),
      else: reject_invalid_line(:banlist)
  end

  @doc """
  Sends `MODE <channel>\\r\\n` — the bare channel-mode QUERY form (no
  sign, no mode letters, no `b` argument). Elicits 324 RPL_CHANNELMODEIS
  (+ 329 RPL_CREATIONTIME) from the upstream, which EventRouter folds
  into the `channel_modes` cache and broadcasts to cic. ircds do NOT
  send 324 unsolicited on JOIN (unlike the 332/333 topic numerics), so
  `Grappa.Session.Server` issues this query in its `:joined` apply-effects
  arm (#216) to make channel modes visible from the moment of join.

  Validates the channel syntax with `{:error, :invalid_line}` on
  rejection. Sibling to `send_banlist/2` — same `MODE <channel> …` verb,
  the only difference is the absent trailing `b` (query-all-modes vs
  query-banlist).
  """
  @spec send_channel_modes(pid(), String.t()) :: send_result()
  def send_channel_modes(client, channel) do
    if Identifier.valid_channel?(channel),
      do: send_line(client, "MODE #{channel}\r\n"),
      else: reject_invalid_line(:channel_modes)
  end

  @doc """
  Sends `WHOIS [<server>] <nick>\\r\\n`.

  `server` is the optional RFC 2812 §3.6.2 target-server the query routes
  through (#198): when nil the frame is the single-target `WHOIS <nick>`,
  when a binary the two-arg `WHOIS <server> <nick>` (the server answers on
  behalf of the queried nick). The nick is validated with `valid_nick?/1`;
  the server — a single routing slot that may be a server name or a nick —
  with the single-token `safe_oper_token?/1` predicate (no
  whitespace/CRLF/NUL, so it cannot splice an extra wire slot or inject a
  follow-up command). Either rejection yields `{:error, :invalid_line}`.
  The multi-target comma-separated list (RFC 2812 §3.6.2) stays out of MVP
  scope.
  """
  @spec send_whois(pid(), String.t(), String.t() | nil) :: send_result()
  def send_whois(client, nick, nil) do
    if Identifier.valid_nick?(nick),
      do: send_line(client, "WHOIS #{nick}\r\n"),
      else: reject_invalid_line(:whois)
  end

  def send_whois(client, nick, server) when is_binary(server) do
    if Identifier.valid_nick?(nick) and Identifier.safe_oper_token?(server),
      do: send_line(client, "WHOIS #{server} #{nick}\r\n"),
      else: reject_invalid_line(:whois)
  end

  @doc """
  Sends `WHOWAS <nick>\\r\\n`. Validates nick syntax with
  `{:error, :invalid_line}` on rejection. Single-target form only —
  multi-target WHOWAS (RFC 2812 §3.6.3 allows comma-separated list +
  optional `<count> <server>`) is out of MVP scope.

  Numerics 314 RPL_WHOWASUSER (one per historical entry) + 312
  RPL_WHOISSERVER reuse (carrying ctime(logoff_time) in trailing) + 369
  RPL_ENDOFWHOWAS (terminator) reply with the WHOWAS list. 406
  ERR_WASNOSUCHNICK fires on no-history. EventRouter folds the burst
  into `state.whowas_pending` and emits `{:whowas_bundle, target, accum}`
  on 369 (or a `not_found: true` bundle on 406).
  """
  @spec send_whowas(pid(), String.t()) :: send_result()
  def send_whowas(client, nick) do
    if Identifier.valid_nick?(nick),
      do: send_line(client, "WHOWAS #{nick}\r\n"),
      else: reject_invalid_line(:whowas)
  end

  @doc """
  Sends `WHO <target>\\r\\n` where `<target>` is a channel OR a host/nick
  mask (RFC 2812 §3.6.1). Returns `{:error, :invalid_line}` on rejection.

  #221: the gate is `safe_oper_token?/1` (a single wire token — non-empty,
  no whitespace/CRLF/NUL), NOT `valid_channel?/1`. A masked `/who *!*@host`
  is a legitimate query; the pre-#221 channel-only gate rejected it outbound
  so it never reached upstream — the first break in the `/who <mask>` "total
  silence" chain. The single-token gate still blocks a space (which would
  splice extra WHO wire slots) and CRLF (command injection).

  Numerics 352 RPL_WHOREPLY (one per matching user) + 315 RPL_ENDOFWHO
  (terminator) reply with the WHO list. EventRouter folds each 352 into
  `state.who_pending` (also upserting `userhost_cache`) and, on 315, drains
  the accumulator into ONE ephemeral `{:who_reply, target, users}` effect
  (#169) — broadcast on the user topic for cic's WhoModal, never persisted.
  For a mask WHO, solanum sets the 352 channel field to `"*"`; EventRouter's
  who_fold correlates via the single-in-flight-WHO fallback.
  """
  @spec send_who(pid(), String.t()) :: send_result()
  def send_who(client, target) do
    if Identifier.safe_oper_token?(target),
      do: send_line(client, "WHO #{target}\r\n"),
      else: reject_invalid_line(:who)
  end

  @doc """
  Sends `NAMES <channel>\\r\\n`. Validates channel syntax with
  `{:error, :invalid_line}` on rejection. The single-target form is
  the ergonomic call shape — RFC 2812 §3.2.5 also allows a
  comma-separated list, out of MVP scope.

  Numerics 353 RPL_NAMREPLY (one or more, space-separated nicks with
  optional `@`/`+` prefix) + 366 RPL_ENDOFNAMES (terminator) reply
  with the membership list. EventRouter folds 353 into
  `state.names_pending` and emits N+1 `:persist` `:notice` rows on
  366 if the operator is NOT in the target channel; if joined, the
  existing 366 → `members_seeded` flow refreshes the MembersPane and
  no scrollback rows are emitted.
  """
  @spec send_names(pid(), String.t()) :: send_result()
  def send_names(client, channel) do
    if Identifier.valid_channel?(channel),
      do: send_line(client, "NAMES #{channel}\r\n"),
      else: reject_invalid_line(:names)
  end

  @doc """
  Sends `MODE <nick> <modes>\\r\\n` — user-mode change on the
  caller-supplied nick. The caller (`Grappa.Session.Server`) passes
  its `state.nick` as the nick arg so this helper stays a pure
  byte-encoding boundary with no Session-state dependency. Validates
  nick syntax + rejects CR/LF/NUL in modes with
  `{:error, :invalid_line}`.

  Consolidates the raw `send_line` arm previously open-coded in
  `Grappa.Session.Server`'s `:send_umode` handle_call (resp-A4 close).
  """
  @spec send_umode(pid(), String.t(), String.t()) :: send_result()
  def send_umode(client, nick, modes) do
    if Identifier.valid_nick?(nick) and Identifier.safe_line_token?(modes) do
      send_line(client, "MODE #{nick} #{modes}\r\n")
    else
      reject_invalid_line(:umode)
    end
  end

  @doc """
  Sends `MODE <nick>\\r\\n` — the bare user-mode QUERY form (no sign, no
  mode letters). Elicits 221 RPL_UMODEIS from the upstream, which
  `Grappa.Session.Server` folds into its per-session `umodes` set and
  broadcasts to cic. ircds do NOT report the user's own umode set
  unsolicited at registration (only mode CHANGES echo back), so
  `Session.Server` issues this query in the 001 RPL_WELCOME arm (#229)
  to make umodes visible from the moment of connect.

  Validates the nick syntax with `{:error, :invalid_line}` on rejection.
  Umode twin of `send_channel_modes/2` (bare `MODE #chan`) — the
  per-user analogue of #216's channel-mode-on-join query.
  """
  @spec send_umode_query(pid(), String.t()) :: send_result()
  def send_umode_query(client, nick) do
    if Identifier.valid_nick?(nick),
      do: send_line(client, "MODE #{nick}\r\n"),
      else: reject_invalid_line(:umode_query)
  end

  @doc """
  Sends `TOPIC <channel> :\\r\\n` — empty trailing parameter clears
  the channel topic per RFC 2812 §3.2.4 (irssi `/topic -delete`
  convention). Validates channel syntax with `{:error, :invalid_line}`
  on rejection.

  Consolidates the raw `send_line` arm previously open-coded in
  `Grappa.Session.Server`'s `:send_topic_clear` handle_call (resp-A4 close).
  """
  @spec send_topic_clear(pid(), String.t()) :: send_result()
  def send_topic_clear(client, channel) do
    if Identifier.valid_channel?(channel),
      do: send_line(client, "TOPIC #{channel} :\r\n"),
      else: reject_invalid_line(:topic_clear)
  end

  @doc """
  Sends bare `LUSERS\\r\\n` upstream — server replies with the
  251/252/253?/254/255/265/266 sequence which `EventRouter` folds into
  `state.lusers_pending` and `Server.apply_effects` flushes as a
  `{:lusers_bundle, accum}` effect on 266.

  No params, no validation: LUSERS is universally accepted.
  """
  @spec send_lusers(pid()) :: send_result()
  def send_lusers(client) do
    send_line(client, "LUSERS\r\n")
  end

  @doc """
  #127 — sends bare `INFO\\r\\n` upstream. Server replies with the
  371 RPL_INFO burst + 374 RPL_ENDOFINFO terminator; `EventRouter` folds
  them into `state.info_pending` (when primed) and `Server.apply_effects`
  flushes a `{:server_reply, :info, lines}` modal effect on 374.

  No params, no validation: INFO is universally accepted.
  """
  @spec send_info(pid()) :: send_result()
  def send_info(client) do
    send_line(client, "INFO\r\n")
  end

  @doc """
  #127 — sends bare `VERSION\\r\\n` upstream. Server replies with
  351 RPL_VERSION (single line); `EventRouter` drains a
  `{:server_reply, :version, [line]}` modal effect on 351 when primed.

  No params, no validation: VERSION is universally accepted.
  """
  @spec send_version(pid()) :: send_result()
  def send_version(client) do
    send_line(client, "VERSION\r\n")
  end

  @doc """
  #127 — sends bare `MOTD\\r\\n` upstream. Server replies with the
  375/372/376 sequence (or 422 ERR_NOMOTD); when primed by `:send_motd`,
  `EventRouter` folds the burst into `state.motd_pending` and
  `Server.apply_effects` flushes a `{:server_reply, :motd, lines}` modal
  effect on the terminator. Connect-time MOTD (unprimed) stays on `$server`.

  No params, no validation: MOTD is universally accepted.
  """
  @spec send_motd(pid()) :: send_result()
  def send_motd(client) do
    send_line(client, "MOTD\r\n")
  end

  # S10 (cluster #10): byte-boundary observability for invalid_line
  # rejections. Every public send_* helper funnels its `else` arm
  # through here so a silently-rejected outbound verb is greppable
  # in the operator log via `verb=:foo` + `reason=:invalid_line`.
  # Logger metadata (network, user) on the calling Session.Server
  # propagates automatically — Session.Server sets `Logger.metadata`
  # at init/1 and Client runs in the same logger context for the
  # outbound call.
  @typep verb ::
           :privmsg
           | :join
           | :part
           | :topic
           | :nick
           | :quit
           | :away
           | :pong
           | :kick
           | :invite
           | :banlist
           | :umode
           | :umode_query
           | :topic_clear
           | :whois
           | :whowas
           | :who
           | :names
           | :oper
           | :raw

  @spec reject_invalid_line(verb()) :: {:error, :invalid_line}
  defp reject_invalid_line(verb) do
    Logger.warning("rejected outbound IRC verb at byte boundary",
      verb: verb,
      reason: :invalid_line
    )

    {:error, :invalid_line}
  end

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

    # #89 — TLS posture observability. The connection now uses
    # `verify: :verify_peer` against the system CA store (see
    # `tls_connect_opts/1`). This info line lands BEFORE AuthFSM.new/1 —
    # `init/1` may abort if the FSM rejects the opts (missing password
    # etc.), and we want the posture visible regardless. Observability,
    # not contingent on handshake validity.
    if opts.tls do
      Logger.info("TLS posture: verify_peer — certificate chain will be validated against the system CA store (#89)")
    end

    case AuthFSM.new(opts) do
      {:ok, fsm} ->
        state = %__MODULE__{
          socket: nil,
          transport: if(opts.tls, do: :ssl, else: :tcp),
          dispatch_to: opts.dispatch_to,
          fsm: fsm,
          # #100 liveness — resolve config (opts override for tests) at
          # init; timers stay nil until the socket comes up in
          # handle_continue(:connect, _).
          liveness_idle_ms: Map.get(opts, :liveness_idle_ms, @liveness_idle_ms),
          liveness_timeout_ms: Map.get(opts, :liveness_timeout_ms, @liveness_timeout_ms),
          idle_timer: nil,
          ping_timer: nil
        }

        {:ok, state, {:continue, {:connect, opts}}}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl GenServer
  def handle_continue({:connect, opts}, state) do
    host = to_charlist(opts.host)
    # #271 — the DNS resolver + socket connect fun are injected here as the real
    # production funs, so the leaf-selection + rotation logic (resolve_targets/3,
    # connect_rotating/7) is unit-testable via the `__*_for_test__` seams without
    # standing up a socket. See do_connect/5.
    deps = %{resolver: &:inet_res.lookup/3, connect_fun: &default_connect/5}

    case do_connect(host, opts.port, opts.tls, Map.get(opts, :source_address), deps) do
      {:ok, socket} ->
        connected = %{state | socket: socket}
        # U-2 (UD7): announce the post-connect / post-TLS / pre-handshake
        # boundary upward so `Session.Server` can re-fire it as the
        # `:connected` phase signal toward `Visitors.Login.wait_for_ready/5`.
        # Lets Login distinguish a TCP-blackhole connect timeout from a
        # rDNS-blocked welcome timeout — different upstream pathologies
        # with different Retry-After hints at the HTTP edge.
        send(state.dispatch_to, :irc_connected)
        {fsm, sends} = AuthFSM.initial_handshake(state.fsm)
        # `_ =`-discard: a peer RST between connect-success and the
        # first handshake byte will surface as `{:error, :closed}` from
        # transport_send. The recv-loop's `{:tcp_closed, _}` info
        # message follows and stops the Client cleanly. Crashing here
        # would cascade through Session.Server's narrow exit-catch
        # list at session/server.ex:660-677 (U-cluster cleanup
        # 2026-05-17 root cause).
        Enum.each(sends, &(_ = transport_send(connected, &1)))
        # #100 — arm the liveness idle timer now that the socket is up. Every
        # inbound line resets it (arm_idle/1); if it ever elapses we self-PING.
        {:noreply, arm_idle(%{connected | fsm: fsm})}

      {:error, reason} ->
        Process.send_after(self(), {:connect_failed_giveup, reason}, @connect_failure_sleep_ms)
        {:noreply, state}
    end
  end

  @impl GenServer
  # #100 — any inbound byte proves the socket is alive. Reset the liveness
  # cycle (cancel a pending self-PING reply window, re-arm the idle timer)
  # at this single choke point BEFORE parsing, so even a malformed line —
  # which `process_line/2` logs + drops — still counts as liveness. The
  # server's PONG to our own probe flows through here too, closing the loop.
  def handle_info({:tcp, _, line}, state), do: process_line(line, arm_idle(state))
  def handle_info({:ssl, _, line}, state), do: process_line(line, arm_idle(state))
  def handle_info({:tcp_closed, _}, state), do: {:stop, :tcp_closed, state}
  def handle_info({:ssl_closed, _}, state), do: {:stop, :ssl_closed, state}

  # #100 — liveness phase 1: idle window elapsed (no inbound for
  # `liveness_idle_ms`). Send our own PING and open the reply window; if
  # `liveness_timeout_ms` passes with still no inbound, phase 2 fires. The
  # PING token is a fixed liveness marker — the reply resets the cycle via
  # the inbound choke point above regardless of the token echoed back.
  # `_ =`-discard the send result: a dead socket returns `{:error, _}` and
  # the ping_timer will fire the stop anyway (or a `:tcp_closed` beats it);
  # either way the reconnect chain engages.
  def handle_info(:liveness_idle, state) do
    _ = transport_send(state, "PING :grappa-liveness\r\n")
    timer = Process.send_after(self(), :liveness_timeout, state.liveness_timeout_ms)
    {:noreply, %{state | idle_timer: nil, ping_timer: timer}}
  end

  # #100 — liveness phase 2: the self-PING went unanswered for the full
  # reply window. The peer is unreachable (half-open socket). Stop with
  # `:ping_timeout` → link EXIT → Session.Server abnormal terminate/2 →
  # Backoff.record_failure → `:transient` respawn (the existing chain).
  def handle_info(:liveness_timeout, state) do
    Logger.warning("upstream liveness timeout — no reply to self-PING, declaring connection dead",
      liveness_idle_ms: state.liveness_idle_ms,
      liveness_timeout_ms: state.liveness_timeout_ms
    )

    {:stop, :ping_timeout, %{state | ping_timer: nil}}
  end

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
    # transport_send returns {:error, :no_socket | :closed | _} when
    # the socket is nil (connect_failed pre-assignment, or recv-loop
    # nilled post-tcp_closed) or closed-but-not-nil (race between
    # SEND and recv-loop dispatch of {:tcp_closed, _}). Pre-fix this
    # was `:ok = transport_send(...)`, which raised MatchError on
    # the closed-non-nil shape AND propagated the FunctionClauseError
    # from :gen_tcp.send(nil, _) on the nil-socket shape. Either
    # crash cascaded into Session.Server.terminate/2 whose narrow
    # exit-catch list missed the wrapped MatchError shape — supervisor
    # blocked 5s per dying child, CI's reset_session_supervisor 15s
    # registry-clear budget exhausted on BootstrapTest + class
    # siblings (run 25975442301, 2026-05-17). Returning the honest
    # tuple lets the caller decide (Session.Server.terminate/2
    # discards the result; an interactive caller can retry).
    {:reply, transport_send(state, ensure_crlf(line)), state}
  end

  # IRC framing requires every line to end with CRLF. The high-level
  # send_* helpers (send_privmsg/3, send_join/3, etc.) already include
  # \r\n in their format strings — but bypass paths like a raw
  # send_line/2 from a controller or a CTCP-reply effect can forget,
  # and a missing terminator silently concatenates with the next
  # outbound frame, garbling both lines on the wire (CP23 cluster
  # `code-reload` learned this when the CTCP VERSION reply landed
  # without \r\n and ate the next PRIVMSG).
  #
  # Guarantee CRLF here at the transport boundary so no upstream
  # caller can produce a malformed frame. Idempotent: if the line
  # already ends with \r\n it's passed through; if it ends with bare
  # \n or has no terminator at all, \r\n is appended.
  @spec ensure_crlf(iodata()) :: binary()
  defp ensure_crlf(line) do
    bin = IO.iodata_to_binary(line)

    cond do
      String.ends_with?(bin, "\r\n") -> bin
      String.ends_with?(bin, "\n") -> String.trim_trailing(bin, "\n") <> "\r\n"
      true -> bin <> "\r\n"
    end
  end

  ## Connection

  # Explicit 30s connect timeout on both transports. The Erlang default
  # is `:infinity` — a black-holed SYN would deadlock `handle_continue`
  # forever, leaving the GenServer alive-but-unreachable until
  # `:gen_tcp` / `:ssl` give up. 30s is the standard upstream-handshake
  # ceiling; Phase 5 reconnect/backoff revisits this when retry policy
  # lands.
  #
  # #271 — this is the PER-LEAF ceiling. `connect_rotating/7` tries each
  # resolved leaf sequentially, so an all-leaves-black-holed outage (SYN
  # dropped, not refused) can block `handle_continue` for up to
  # N × @connect_timeout_ms before the give-up throttle engages
  # (~60s for azzurra's 2 leaves). Accepted tradeoff for the MVP: (1) a
  # leaf that is genuinely DOWN usually REFUSES (ECONNREFUSED is instant),
  # so rotation is fast in the common case; (2) this is strictly BETTER
  # than the pre-#271 behavior, where the stable getaddrinfo RFC-6724 sort
  # re-picked the SAME dead leaf on every backoff respawn and NEVER
  # recovered — one rotation cycle now finds a live leaf. Phase 5's retry
  # policy can budget the ceiling across the set if the double-black-hole
  # window ever bites in practice.
  @connect_timeout_ms 30_000

  # #271 — injectable seams for the leaf-selection + rotation path. Production
  # wires the real resolver (`:inet_res.lookup/3`) + socket connect fun
  # (`default_connect/5`) in handle_continue/2; tests inject fakes via the
  # `__*_for_test__` seams to assert the connect TARGET shape (IP tuple vs
  # hostname) + rotation without opening a socket. A map threaded through
  # do_connect/5 (not start_link opts) because the full Client start path has no
  # need to substitute these — only the pure-ish connect logic does. `resolver`
  # matches `:inet_res.lookup/3`; `connect_fun` abstracts the
  # `:gen_tcp.connect/4` / `:ssl.connect/4` pair over the `:tcp | :ssl` tag.
  # `target` is an IP tuple (or the hostname charlist fallback), both legal
  # first args to the connect funs.
  @typep leaf_target :: :inet.ip_address() | :inet.hostname()
  @typep resolver_fun :: (charlist(), :in, :a | :aaaa -> [:inet.ip_address()])
  @typep connect_fun ::
           (:tcp | :ssl, leaf_target(), :inet.port_number(), keyword(), timeout() ->
              {:ok, :gen_tcp.socket() | :ssl.sslsocket()} | {:error, term()})
  @typep connect_deps :: %{resolver: resolver_fun(), connect_fun: connect_fun()}

  @spec do_connect(charlist(), :inet.port_number(), boolean(), String.t() | nil, connect_deps()) ::
          {:ok, :gen_tcp.socket() | :ssl.sslsocket()} | {:error, term()}
  defp do_connect(host, port, tls, source_address, deps) do
    case source_bind(host, source_address) do
      {:ok, {bind_opts, fam}} ->
        connect_with_rotation(host, port, tls, bind_opts, fam, deps)

      {:error, {:source_family_mismatch, _, _, _} = reason} ->
        # Permanent misconfig (e.g. a v4 source pinned to a v6-only
        # upstream). Surface it loud; the existing connect-fail throttle
        # + :transient give-up machinery handles the rest. `:error` is
        # the allowlisted Logger key (config/config.exs) — the full
        # tuple rides inside it, no metadata-allowlist churn.
        Logger.error("outbound source-address family mismatch — refusing connect",
          error: inspect(reason)
        )

        {:error, reason}
    end
  end

  # #271 — grappa OWNS the leaf choice instead of delegating it to getaddrinfo.
  # Handing the HOSTNAME to :ssl.connect/:gen_tcp.connect lets the OS apply
  # RFC-6724 destination-address sorting, which is STABLE: the same leaf wins
  # every connect, so a multi-AAAA round-robin pool collapses onto ONE leaf
  # (load imbalance + a single leaf down taking every session with it). Here we
  # resolve the full RR set for the chosen family ourselves, shuffle it, and
  # dial the IP TUPLE — bypassing the getaddrinfo sort. SNI + hostname
  # verification stay anchored to the ORIGINAL hostname (transport_connect/7
  # threads `host` into tls_connect_opts/1, NOT the target) so #89 verify_peer
  # still validates the picked leaf's cert (its SAN covers the hostname).
  @spec connect_with_rotation(
          charlist(),
          :inet.port_number(),
          boolean(),
          keyword(),
          :inet | :inet6,
          connect_deps()
        ) :: {:ok, :gen_tcp.socket() | :ssl.sslsocket()} | {:error, term()}
  defp connect_with_rotation(host, port, tls, bind_opts, fam, deps) do
    host
    |> resolve_targets(fam, deps.resolver)
    |> connect_rotating(host, port, tls, bind_opts, fam, deps.connect_fun)
  end

  # Resolve the round-robin candidate set for `fam` and shuffle it so each
  # connect rolls a fresh leaf order. An IP-literal host has nothing to rotate —
  # dial it directly (this also keeps IP-literal upstreams and the IRCServer
  # test harness, host "127.0.0.1", off the resolver entirely). A DNS name is
  # queried for AAAA (v6 source) or A (v4 source); an empty answer falls back to
  # handing the hostname to the connect fun — no worse than the pre-#271
  # behavior for a host with no record in the chosen family.
  @spec resolve_targets(charlist(), :inet | :inet6, resolver_fun()) :: [leaf_target(), ...]
  defp resolve_targets(host, fam, resolver) do
    case :inet.parse_address(host) do
      {:ok, ip} ->
        [ip]

      {:error, _} ->
        rr_type = if fam == :inet6, do: :aaaa, else: :a

        case resolver.(host, :in, rr_type) do
          [_ | _] = addrs -> Enum.shuffle(addrs)
          [] -> [host]
        end
    end
  end

  # Try the shuffled leaf set in order until one connects. A dead leaf rolls to
  # the next member BEFORE the :transient give-up, so a single down leaf can no
  # longer park every session. The last member's result is surfaced verbatim: on
  # exhaustion the real {:error, reason} propagates into the existing
  # connect-fail throttle + give-up chain (rotation must not swallow a genuine
  # give-up). Three-clause recursive shape (collect-until-success traversal),
  # tail-recursive — CLAUDE.md.
  @spec connect_rotating(
          [leaf_target(), ...],
          charlist(),
          :inet.port_number(),
          boolean(),
          keyword(),
          :inet | :inet6,
          connect_fun()
        ) :: {:ok, :gen_tcp.socket() | :ssl.sslsocket()} | {:error, term()}
  defp connect_rotating([target], host, port, tls, bind_opts, fam, connect_fun) do
    transport_connect(target, host, port, tls, bind_opts, fam, connect_fun)
  end

  defp connect_rotating([target | rest], host, port, tls, bind_opts, fam, connect_fun) do
    case transport_connect(target, host, port, tls, bind_opts, fam, connect_fun) do
      {:ok, _} = ok ->
        ok

      {:error, reason} ->
        Logger.warning("upstream leaf connect failed — rotating to next leaf",
          error: inspect({target, reason})
        )

        connect_rotating(rest, host, port, tls, bind_opts, fam, connect_fun)
    end
  end

  # `target` is the IP tuple we dial (or the hostname fallback); `host` is the
  # ORIGINAL hostname threaded into tls_connect_opts/1 for SNI + hostname check.
  # Keeping the two separate is the #89 invariant: dial the picked leaf's IP but
  # verify its cert against the hostname we were asked to reach.
  @spec transport_connect(
          leaf_target(),
          charlist(),
          :inet.port_number(),
          boolean(),
          keyword(),
          :inet | :inet6,
          connect_fun()
        ) :: {:ok, :gen_tcp.socket() | :ssl.sslsocket()} | {:error, term()}
  defp transport_connect(target, _, port, false, bind_opts, fam, connect_fun) do
    connect_fun.(:tcp, target, port, [:binary, fam, packet: :line, active: :once] ++ bind_opts, @connect_timeout_ms)
  end

  defp transport_connect(target, host, port, true, bind_opts, fam, connect_fun) do
    connect_fun.(
      :ssl,
      target,
      port,
      [:binary, fam, packet: :line, active: :once] ++ tls_connect_opts(host) ++ bind_opts,
      @connect_timeout_ms
    )
  end

  # Production socket connect. Injected as the connect fun in handle_continue/2;
  # tests substitute a recording fake through __connect_with_rotation_for_test__.
  @spec default_connect(:tcp | :ssl, leaf_target(), :inet.port_number(), keyword(), timeout()) ::
          {:ok, :gen_tcp.socket() | :ssl.sslsocket()} | {:error, term()}
  defp default_connect(:tcp, target, port, opts, timeout), do: :gen_tcp.connect(target, port, opts, timeout)

  defp default_connect(:ssl, target, port, opts, timeout) do
    # `:ssl.connect/4` returns `{:ok, sslsocket}` OR — when hello-handshake
    # extensions are requested — `{:ok, sslsocket, protocol_extensions}`. We
    # request no such opts, so the 3-tuple never fires at runtime; normalise it
    # to the 2-tuple regardless so the `{:ok, socket}` contract holds
    # end-to-end (handle_continue/2 matches the 2-tuple — a 3-tuple would
    # CaseClauseError) and Dialyzer's success typing agrees with the spec.
    case :ssl.connect(target, port, opts, timeout) do
      {:ok, socket} -> {:ok, socket}
      {:ok, socket, _} -> {:ok, socket}
      {:error, _} = err -> err
    end
  end

  # #89 — TLS certificate-chain verification (replaces the Phase-1
  # `verify: :verify_none` expedient). Four load-bearing opts:
  #
  #   * `verify: :verify_peer` — reject a peer whose cert chain does not
  #     validate. This is the whole point; without it the other opts are
  #     inert.
  #   * `cacerts: :public_key.cacerts_get()` — the OS trust store (OTP 25+
  #     reads the platform CA bundle: /etc/ssl/cert.pem on FreeBSD, the
  #     macOS keychain, the Linux ca-certificates bundle). No cacertfile to
  #     ship or rotate — the operator's system trust store IS the anchor
  #     set. `cacerts_get/0` raises if no store is found; that's the honest
  #     loud failure (a box with no CA bundle can't safely verify_peer). The
  #     raise is evaluated inside `handle_continue(:connect, _)`, so it
  #     crashes the Client, propagates the link signal to `Session.Server`,
  #     and drives its terminate/2 → Backoff → `:transient` respawn path —
  #     loud + throttled, NOT a silent downgrade to no-verification. (This
  #     is the crash path, distinct from the `{:connect_failed_giveup, _}`
  #     deferred throttle, which fires only when `do_connect` RETURNS
  #     `{:error, _}` from a handshake failure.)
  #   * `depth: 3` — cap the intermediate-CA chain length. Azzurra's chain
  #     is leaf → Let's Encrypt intermediate → ISRG root (depth 2); 3 leaves
  #     one slot of headroom for a cross-signed root without inviting an
  #     arbitrarily long attacker-supplied chain.
  #   * hostname verification — `server_name_indication` sends SNI (so a
  #     round-robin pool member serves the cert whose SAN covers the dialed
  #     host) AND `customize_hostname_check` with the RFC-6125 https
  #     match_fun rejects a valid-CA cert issued for the wrong host (the
  #     MITM-with-any-leaf class). SNI is the charlist host we dialed.
  #
  # Operator trust-store strategy is documented in the moduledoc "TLS
  # posture" section + docs/OPERATIONS.md. The upstream cert was probed
  # against the live prod node before this flip (issue #89): azzurra's
  # round-robin members all chain to ISRG Root with `irc.azzurra.chat` in
  # SAN, so verify_peer is safe and does not risk locking the bouncer out.
  @tls_verify_depth 3

  @spec tls_connect_opts(charlist()) :: [:ssl.tls_client_option()]
  defp tls_connect_opts(host) do
    [
      verify: :verify_peer,
      cacerts: :public_key.cacerts_get(),
      depth: @tls_verify_depth,
      server_name_indication: host,
      customize_hostname_check: [
        match_fun: :public_key.pkix_verify_hostname_match_fun(:https)
      ]
    ]
  end

  @doc false
  # Test-only seam for the #89 verify_peer opts. Production callers go
  # through transport_connect/7. Mirrors __source_bind_for_test__/2 —
  # greppable, absent from public docs. Lets the client_test assert the
  # ssl-opts SHAPE without standing up a real TLS listener (the real
  # handshake to azzurra was proven out-of-band, see issue #89).
  @spec __tls_connect_opts_for_test__(charlist()) :: [:ssl.tls_client_option()]
  def __tls_connect_opts_for_test__(host), do: tls_connect_opts(host)

  # Fixed source present → bind that literal as `ifaddr` over its own
  # family, after confirming the upstream is reachable in that family.
  # NULL source → the existing rotating-pool / kernel-default path,
  # verbatim. Deterministic for a fixed source (no per-connect roll) so
  # the upstream sees a stable O-line host on every retry (spec §2).
  @spec source_bind(charlist(), String.t() | nil) ::
          {:ok, {keyword(), :inet | :inet6}}
          | {:error, {:source_family_mismatch, String.t(), String.t(), :inet | :inet6}}
  defp source_bind(host, nil), do: {:ok, resolve_and_ifaddr(host)}

  defp source_bind(host, source) when is_binary(source) do
    # parse_source_family/1 returns {fam, tuple} (tag-first, :inet idiom);
    # we emit {opts, fam} below to match resolve_and_ifaddr/1's order.
    {fam, source_tuple} = parse_source_family(source)

    case :inet.getaddr(host, fam) do
      {:ok, _} -> {:ok, {[ifaddr: source_tuple], fam}}
      {:error, _} -> {:error, {:source_family_mismatch, source, to_string(host), fam}}
    end
  end

  # The source string is a strict literal (validated at the Server
  # changeset boundary), so exactly one parser succeeds. A failure here
  # is a broken invariant — let it crash (no silent fallback).
  @spec parse_source_family(String.t()) :: {:inet | :inet6, :inet.ip_address()}
  defp parse_source_family(source) do
    charlist = String.to_charlist(source)

    case :inet.parse_ipv4strict_address(charlist) do
      {:ok, v4} ->
        {:inet, v4}

      {:error, _} ->
        {:ok, v6} = :inet.parse_ipv6strict_address(charlist)
        {:inet6, v6}
    end
  end

  @doc false
  # Test-only seam for the family / ifaddr / mismatch logic. Production
  # callers go through do_connect/5. Mirrors the __merge_autojoin_for_test__
  # convention in Networks.SessionPlan — greppable, absent from public docs.
  @spec __source_bind_for_test__(charlist(), String.t() | nil) ::
          {:ok, {keyword(), :inet | :inet6}}
          | {:error, {:source_family_mismatch, String.t(), String.t(), :inet | :inet6}}
  def __source_bind_for_test__(host, source), do: source_bind(host, source)

  @doc false
  # #271 test seams — mirror __source_bind_for_test__/2. Production callers go
  # through handle_continue/2 → do_connect/5. Greppable, absent from public docs.
  # `__resolve_targets_for_test__` pins the leaf-PICK (full RR set considered +
  # shuffle); `__connect_with_rotation_for_test__` pins the connect TARGET shape
  # (IP tuple, not hostname), the #89 SNI/hostname-check anchor, and
  # rotate-on-fail — with an injected resolver + connect fun so no socket opens.
  @spec __resolve_targets_for_test__(charlist(), :inet | :inet6, resolver_fun()) ::
          [leaf_target(), ...]
  def __resolve_targets_for_test__(host, fam, resolver), do: resolve_targets(host, fam, resolver)

  @spec __connect_with_rotation_for_test__(
          charlist(),
          :inet.port_number(),
          boolean(),
          keyword(),
          :inet | :inet6,
          resolver_fun(),
          connect_fun()
        ) :: {:ok, :gen_tcp.socket() | :ssl.sslsocket()} | {:error, term()}
  def __connect_with_rotation_for_test__(host, port, tls, bind_opts, fam, resolver, connect_fun) do
    connect_with_rotation(host, port, tls, bind_opts, fam, %{
      resolver: resolver,
      connect_fun: connect_fun
    })
  end

  # Outbound v6 source-address selection.
  #
  # If the DB-driven rotation pool (`Grappa.OutboundV6Pool`, curated via
  # the `in_pool` vhosts — #228) is non-empty + the upstream host has an
  # AAAA record, pick a random pool entry and bind it as `ifaddr` on a v6
  # socket. Otherwise fall through to v4 with kernel-default source
  # selection.
  #
  # Pre-resolving + selecting the address family BEFORE the connect
  # call is mandatory: passing a v6 `ifaddr` to `:gen_tcp.connect/4`
  # forces the lookup into AAAA-only territory, and a v4-only
  # upstream (e.g. `irc.example.org` with only A records) surfaces
  # as `:nxdomain` rather than the more accurate "destination has
  # no v6 address" error. Resolving here lets us downgrade to v4
  # gracefully when the host can't be reached over v6 at all.
  #
  # Pick happens per-connect so each retry rolls a fresh source.
  #
  # `ifaddr` works for both `:gen_tcp.connect/4` and
  # `:ssl.connect/4` — ssl forwards inet options to its underlying
  # gen_tcp socket at handshake setup.
  @spec resolve_and_ifaddr(charlist()) :: {keyword(), :inet | :inet6}
  defp resolve_and_ifaddr(host) do
    case Grappa.OutboundV6Pool.pick() do
      {:ok, ip6} ->
        case :inet_res.lookup(host, :in, :aaaa) do
          [_ | _] -> {[ifaddr: ip6], :inet6}
          [] -> {[], :inet}
        end

      :none ->
        {[], :inet}
    end
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
        # `_ =`-discard for same reason as handle_continue connect-
        # success: peer RST mid-handshake reply is benign, recv-loop
        # `:tcp_closed` follows. transport_setopts still asserts `:ok`
        # because it's a local opt change (no I/O) — it cannot fail
        # for a transport-level reason short of the socket already
        # being gone, in which case the next info-message will stop us.
        Enum.each(sends, &(_ = transport_send(state, &1)))
        :ok = transport_setopts(state, active: :once)
        {:noreply, %{state | fsm: fsm}}

      {:stop, reason, fsm, sends} ->
        # Same discard rationale; the FSM has already decided to stop
        # so an outbound write failure changes nothing.
        Enum.each(sends, &(_ = transport_send(state, &1)))
        log_stop_reason(reason, fsm)
        {:stop, reason, %{state | fsm: fsm}}
    end
  end

  # #100 — reset the liveness cycle to phase 1 (idle countdown). Called on
  # connect-success and on EVERY inbound line. Cancels whichever timer is
  # armed (idle counting down, OR the ping reply window if we're mid-probe),
  # drains any already-fired timer message stranded in the mailbox, then
  # arms a fresh idle timer.
  #
  # The drain is load-bearing: `Process.cancel_timer/1` returns `false` when
  # the timer already fired and its message is queued behind the inbound line
  # currently being processed. Without draining, that stale `:liveness_idle`
  # / `:liveness_timeout` would run AFTER we re-armed and either double-probe
  # or falsely stop a live connection. Same discipline as
  # `Session.Server.cancel_and_drain/2`.
  @spec arm_idle(t()) :: t()
  defp arm_idle(state) do
    cancel_and_drain(state.idle_timer, :liveness_idle)
    cancel_and_drain(state.ping_timer, :liveness_timeout)
    timer = Process.send_after(self(), :liveness_idle, state.liveness_idle_ms)
    %{state | idle_timer: timer, ping_timer: nil}
  end

  # Cancel `ref` and, if it had already fired, drain the stranded `msg` from
  # the mailbox. `nil` ref is a no-op. Mirrors `Session.Server.cancel_and_drain/2`
  # — kept local so `IRC.Client` stays free of the optional `Grappa`-app deps
  # (extraction memory `project_extract_irc_libs`). `msg` is one of the two
  # liveness timer atoms (typed narrow — Dialyzer rejects a wider `atom()`
  # spec as a supertype since those are the only call sites).
  @spec cancel_and_drain(reference() | nil, :liveness_idle | :liveness_timeout) :: :ok
  defp cancel_and_drain(nil, _), do: :ok

  defp cancel_and_drain(ref, msg) when is_reference(ref) and is_atom(msg) do
    case Process.cancel_timer(ref) do
      ms_left when is_integer(ms_left) -> :ok
      false -> drain_liveness(msg)
    end
  end

  defp drain_liveness(msg) do
    receive do
      ^msg -> drain_liveness(msg)
    after
      0 -> :ok
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

  # Nil-socket guard: connect_failed before socket assignment, or
  # recv-loop nilled post-tcp_closed. Returns honest tagged tuple
  # rather than letting :gen_tcp.send(nil, _) raise FunctionClauseError
  # (which would crash the Client and cascade through Session.Server's
  # terminate/2 — see handle_call({:send, _}, _, _) comment).
  defp transport_send(%{socket: nil}, _), do: {:error, :no_socket}

  defp transport_send(%{transport: :tcp, socket: sock}, data),
    do: :gen_tcp.send(sock, data)

  defp transport_send(%{transport: :ssl, socket: sock}, data),
    do: :ssl.send(sock, data)

  defp transport_setopts(%{transport: :tcp, socket: sock}, opts),
    do: :inet.setopts(sock, opts)

  defp transport_setopts(%{transport: :ssl, socket: sock}, opts),
    do: :ssl.setopts(sock, opts)
end
