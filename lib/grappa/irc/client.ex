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
          required(:realname) => String.t(),
          required(:sasl_user) => String.t(),
          required(:auth_method) => AuthFSM.auth_method(),
          optional(:password) => String.t() | nil,
          optional(:source_address) => String.t() | nil
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

  # Cluster visitor-auth hotfix: pre-crash throttle when do_connect/4
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

  - `send_away(client, reason)` with a non-nil `reason` sends `AWAY :reason`.
    Rejects CR/LF/NUL in the reason with `{:error, :invalid_line}`.
  - `send_away_unset(client)` sends bare `AWAY\\r\\n` to clear any active away
    status. Callers MUST use the separate arity — `send_away(client, nil)` is
    not a valid public call (no default-arg path per CLAUDE.md).

  IRC semantics: a bare `AWAY` with no trailing param clears away status
  (RFC 2812 §4.6). A populated `AWAY :reason` sets it. The two-function
  shape makes the distinction explicit at the call site.
  """
  @spec send_away(pid(), String.t()) :: send_result()
  def send_away(client, reason) when is_binary(reason) do
    if Identifier.safe_line_token?(reason),
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
  Sends `WHOIS <nick>\\r\\n`. Validates nick syntax with
  `{:error, :invalid_line}` on rejection. The single-target form is the
  ergonomic call shape — multi-target WHOIS (RFC 2812 §3.6.2 allows a
  comma-separated list AND a server prefix arg) is out of MVP scope.
  """
  @spec send_whois(pid(), String.t()) :: send_result()
  def send_whois(client, nick) do
    if Identifier.valid_nick?(nick),
      do: send_line(client, "WHOIS #{nick}\r\n"),
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
  Sends `WHO <channel>\\r\\n`. Validates channel syntax with
  `{:error, :invalid_line}` on rejection. The single-target form is
  the ergonomic call shape — RFC 2812 §3.6.1 allows a server-side
  mask + an `o` flag, both out of MVP scope.

  Numerics 352 RPL_WHOREPLY (one per matching user) + 315 RPL_ENDOFWHO
  (terminator) reply with the WHO list. EventRouter folds 352 into
  `state.who_pending` and emits `{:who_bundle, target, accum}` on 315.
  """
  @spec send_who(pid(), String.t()) :: send_result()
  def send_who(client, channel) do
    if Identifier.valid_channel?(channel),
      do: send_line(client, "WHO #{channel}\r\n"),
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

    case do_connect(host, opts.port, opts.tls, Map.get(opts, :source_address)) do
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
  @connect_timeout_ms 30_000

  defp do_connect(host, port, tls, source_address) do
    case source_bind(host, source_address) do
      {:ok, {bind_opts, fam}} ->
        transport_connect(host, port, tls, bind_opts, fam)

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

  defp transport_connect(host, port, false, bind_opts, fam) do
    :gen_tcp.connect(host, port, [:binary, fam, packet: :line, active: :once] ++ bind_opts, @connect_timeout_ms)
  end

  defp transport_connect(host, port, true, bind_opts, fam) do
    :ssl.connect(
      host,
      port,
      [:binary, fam, packet: :line, active: :once, verify: :verify_none] ++ bind_opts,
      @connect_timeout_ms
    )
  end

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
  # callers go through do_connect/4. Mirrors the __merge_autojoin_for_test__
  # convention in Networks.SessionPlan — greppable, absent from public docs.
  @spec __source_bind_for_test__(charlist(), String.t() | nil) ::
          {:ok, {keyword(), :inet | :inet6}}
          | {:error, {:source_family_mismatch, String.t(), String.t(), :inet | :inet6}}
  def __source_bind_for_test__(host, source), do: source_bind(host, source)

  # Outbound v6 source-address selection.
  #
  # If `GRAPPA_OUTBOUND_V6_POOL` is configured + the upstream host
  # has an AAAA record, pick a random pool entry and bind it as
  # `ifaddr` on a v6 socket. Otherwise fall through to v4 with
  # kernel-default source selection.
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
