defmodule Grappa.IRC.AuthFSM do
  @moduledoc """
  Pure finite-state machine for the upstream IRC registration handshake.

  No process, no socket, no Logger. Inputs are an opts map (at boot)
  and `Grappa.IRC.Message` structs (per inbound line). Outputs are the
  next FSM state plus a list of iodata frames the caller must flush to
  the wire. The caller (`Grappa.IRC.Client`) owns the GenServer and the
  transport; this module owns the protocol logic.

  This shape was extracted from `Grappa.IRC.Client` per the 2026-04-27
  architecture review (finding A3, CP10 D2). The verb-keyed sub-context
  principle from D1/A2 (DESIGN_NOTES "Sub-contexts split by VERB, not
  by NOUN") applies: the IRC-client GenServer keeps transport + line
  dispatch + outbound helpers; the auth-handshake verbs (CAP/SASL/PASS
  state transitions) extract here.

  The Phase 6 IRCv3 listener facade reuses the SHAPE — pure FSM,
  `step/2` returning `(state, [iodata]) | {:stop, reason, state, [iodata]}`,
  no Logger/process coupling — not this FSM itself. The listener
  handles the SERVER side of registration (it RECEIVES PASS/CAP/NICK/USER
  from a downstream PWA client and SENDS 001/903/904); a peer module
  will live alongside under the same shape template. What's reusable
  is the framework, not the bytes.

  ## Phases

      :pre_register                  -- pre-handshake; nothing sent yet
      :awaiting_cap_ls               -- CAP LS 302 sent; collecting LS replies
                                        (continuation lines accumulate `caps_buffer`)
      :awaiting_cap_ack              -- CAP REQ sent; waiting on ACK or NAK.
                                        Either standalone `:sasl`, standalone
                                        `:labeled-response`, OR — for the combined
                                        request branch — sent via this phase when
                                        only one cap is in flight.
      :awaiting_cap_ack_combined     -- Combined CAP REQ `:sasl labeled-response`
                                        sent; waiting on ACK or NAK. On NAK the
                                        FSM falls back to a `:sasl`-alone REQ
                                        (H9, REV-F) before declaring
                                        `:sasl_unavailable`. On ACK, behaves
                                        identically to `:awaiting_cap_ack`.
      :awaiting_cap_ack_sasl_only    -- Fallback `:sasl` REQ in flight after a
                                        combined-REQ NAK. ACK proceeds with the
                                        AUTHENTICATE chain; NAK now genuinely
                                        means the server doesn't support SASL
                                        (combined-REQ NAK was the
                                        `labeled-response` mis-impl signal,
                                        not the SASL-unavailable signal).
      :sasl_pending                  -- AUTHENTICATE PLAIN sent; waiting on SASL numeric
      :registered                    -- 001 received; CAP and `caps_buffer` cleared

  ## Auth methods (mirror `Grappa.Networks.Credential`)

      :none               -> NICK, USER
      :server_pass        -> PASS (from the dedicated `:server_pass` slot,
                             #1044 — NOT `:password`, which on such a row is
                             the NickServ secret), NICK, USER
      :nickserv_identify  -> NICK, USER (the built-in IDENTIFY is NOT emitted
                             here — Grappa.Session.Server sends it at 001,
                             AFTER the on-connect perform list, so it can be
                             suppressed when the list already identified; #189)
      :sasl               -> CAP LS 302, NICK, USER -> CAP REQ :sasl,
                             AUTHENTICATE PLAIN, AUTHENTICATE <base64>
                             -> on 903 CAP END;
                             on 904/905 stop {:sasl_failed, n}
      :auto               -> PASS (if pw), CAP LS 302, NICK, USER
                             -> if SASL advertised: SASL chain
                             -> if 421/no-reply/001: continue
                             (PASS-handoff path, Bahamut/Azzurra)

  ## Stop reasons

      {:sasl_failed, 904 | 905}      -- upstream rejected SASL credentials
      :sasl_unavailable              -- :sasl mandatory but server did not
                                        advertise / NAK'd it
      {:nick_rejected, 432 | 433, n} -- upstream rejected NICK during register

  ## Nick-collision fallback (#676)

  A 433 during registration is NOT immediately fatal. The FSM walks a
  bounded ladder of alternate nicks — `<nick>_`, then random-suffixed
  variants — re-sending NICK for each and only stopping with
  `{:nick_rejected, 433, _}` once the ladder is spent. `state.nick`
  tracks the candidate in flight; 001's `welcomed_nick` is the final
  authority (`Grappa.Session.EventRouter` reconciles it, and tells the
  user when it differs from what they asked for).

  Two carve-outs: `:nickserv_identify` keeps its silent `:cont` (the host
  drives GHOST / recover-identity off that numeric), and 432 still stops
  outright — an erroneous nick is a SHAPE rejection, so a suffixed retry
  would re-send the same bad shape.

  Caller is responsible for Logger emission on stop reasons; the FSM
  itself emits no side effect beyond the returned `[iodata]` frames.
  """

  alias Grappa.IRC.{Identifier, Message}

  @auth_methods [:auto, :sasl, :server_pass, :nickserv_identify, :none]

  # GH #1169. The only SASL mechanism this FSM drives. It names the
  # `AUTHENTICATE <mech>` line AND the operator breadcrumb on a failure
  # numeric, from one place: the defect that motivated the breadcrumb was
  # a comment restating the encoder's shape and drifting from it, and a
  # mechanism string restated at the log site would drift the same way.
  @sasl_mechanism "PLAIN"

  @type auth_method :: :auto | :sasl | :server_pass | :nickserv_identify | :none

  @type phase ::
          :pre_register
          | :awaiting_cap_ls
          | :awaiting_cap_ack
          | :awaiting_cap_ack_combined
          | :awaiting_cap_ack_sasl_only
          | :sasl_pending
          | :registered

  @type opts :: %{
          required(:nick) => String.t(),
          required(:ident) => String.t(),
          required(:realname) => String.t(),
          required(:sasl_user) => String.t(),
          required(:auth_method) => auth_method(),
          optional(:password) => String.t() | nil,
          # GH #1044 — the SERVER `PASS` secret, held apart from `:password`.
          # A password-gated network wants a gate secret AND a NickServ one at
          # the same time, so the two roles get one slot each: on
          # `:server_pass` the PASS line reads THIS, and `:password` keeps its
          # NickServ meaning (emitted post-001 by the host, never here).
          optional(:server_pass) => String.t() | nil
        }

  @typedoc """
  One key of `t:opts/0`.

  Spelled out rather than `atom()` so dialyzer ties `@opt_keys` to it: the
  list and this union have to agree exactly or `opt_keys/0`'s contract stops
  matching its success typing, which is the only automatic check binding the
  DATA copy of the key set to a declared one.
  """
  @type opt_key ::
          :auth_method | :ident | :nick | :password | :realname | :sasl_user | :server_pass

  # `t:opts/0` as DATA, so a caller holding a WIDER map can hand `new/1`
  # exactly this FSM's domain instead of its own. Kept adjacent to the type
  # because the two must name the same keys: a field added to one and not the
  # other silently stops being forwarded.
  @opt_keys [:nick, :ident, :realname, :sasl_user, :auth_method, :password, :server_pass]

  @doc """
  The keys `t:opts/0` declares, for callers whose own opts map is a
  superset of this one.

  `Grappa.IRC.Client` holds transport, dispatch and liveness keys the FSM
  has no business seeing; it narrows with `Map.take/2` through this list so
  the closed `t:opts/0` describes what actually crosses the boundary rather
  than what we wished crossed it. Exported rather than restated at the call
  site so the list cannot drift from the type it mirrors.
  """
  @spec opt_keys() :: [opt_key(), ...]
  def opt_keys, do: @opt_keys

  @type stop_reason ::
          {:sasl_failed, 904 | 905}
          | :sasl_unavailable
          | {:nick_rejected, 432 | 433, String.t()}

  @type t :: %__MODULE__{
          nick: String.t(),
          orig_nick: String.t(),
          nick_suffixes: [String.t()],
          nick_cap: pos_integer(),
          ident: String.t(),
          realname: String.t(),
          sasl_user: String.t(),
          password: String.t() | nil,
          server_pass: String.t() | nil,
          auth_method: auth_method(),
          phase: phase(),
          caps_buffer: [String.t()],
          sasl_fields: sasl_fields()
        }

  @typedoc """
  How many NUL-delimited fields the SASL PLAIN payload this FSM emitted
  actually carried, or `:none` when it never got to emit one (GH #1169).

  Counted from the bytes that went on the wire, NOT from the encoder's
  declared shape: a restatement of the shape is what the operator already
  had, and it read the same whether the payload was well-formed or not.
  """
  @type sasl_fields :: pos_integer() | :none

  @enforce_keys [
    :nick,
    :orig_nick,
    :nick_cap,
    :ident,
    :realname,
    :sasl_user,
    :auth_method,
    :phase
  ]
  # `:password` and `:server_pass` are the struct's secrets — `@derive
  # Inspect` excludes BOTH so SASL-report dumps + IEx `:sys.get_state/1`
  # (transitively via the host Client struct) introspection never leak
  # plaintext. CLAUDE.md "Credentials ... never logged." #1044 added the
  # second one: a new secret field that is not listed here leaks on the
  # first crash dump.
  @derive {Inspect, except: [:password, :server_pass]}
  defstruct [
    :nick,
    :orig_nick,
    :ident,
    :realname,
    :sasl_user,
    :password,
    :server_pass,
    :auth_method,
    :phase,
    :nick_cap,
    nick_suffixes: [],
    caps_buffer: [],
    # GH #1169: unset until the AUTHENTICATE payload is actually emitted.
    sasl_fields: :none
  ]

  @doc """
  Builds the initial FSM state from an opts map. Validates that any
  auth-method other than `:none` carries a non-empty password — Networks.Credential
  enforces the same invariant on the write side; the FSM enforces it
  again so a half-built opts map (test, REPL, future caller) crashes
  at boot rather than mid-SASL with an opaque `<<nil::binary>>` :badarg.

  Codebase review 2026-05-12 irc/S5 (HIGH): also rejects CR/LF/NUL in
  any line-bound field (`nick`, `realname`, `sasl_user`, `password`)
  with `{:error, {:invalid_line_token, field}}`. Today
  `Networks.Credential` enforces the same invariant on the write
  path; the FSM enforces it AGAIN so the Phase-6 listener facade
  reusing this module as a library (and any future REST caller that
  bypasses the schema) cannot inject CRLF into the registration
  handshake. Self-defending boundary, not relying on upstream callers.
  irc/S4's encoder-level guard remains as defense-in-depth.
  """
  @spec new(opts()) ::
          {:ok, t()}
          | {:error, {:missing_password, auth_method()}}
          | {:error, {:missing_server_pass, :server_pass}}
          | {:error, {:invalid_line_token, :nick | :ident | :realname | :sasl_user | :password | :server_pass}}
  def new(%{auth_method: m} = opts) when m in @auth_methods do
    with :ok <- validate_password_present(opts),
         :ok <- validate_line_safe(opts) do
      {:ok,
       %__MODULE__{
         nick: opts.nick,
         orig_nick: opts.nick,
         nick_suffixes: nick_fallback_ladder(),
         nick_cap: Identifier.max_nick_length(),
         ident: opts.ident,
         realname: opts.realname,
         sasl_user: opts.sasl_user,
         password: Map.get(opts, :password),
         server_pass: Map.get(opts, :server_pass),
         auth_method: m,
         phase: :pre_register,
         caps_buffer: []
       }}
    end
  end

  # #676 — the bounded 433 fallback ladder, drawn ONCE per connection so
  # `step/2` stays pure and deterministic: the suffixes are DATA on the
  # struct, not a per-step `:rand` call. Underscore first (the classic IRC
  # client move, and the spelling a returning user recognises as "that's
  # me"), then random tails — vjt's ruling, because a second underscore
  # just walks into the next occupied slot on a busy network.
  #
  # The bound IS the list length. Unbounded retries against a hostile or
  # duplicated nick space is a respawn flood, the same trap the e2e
  # fixtures hit with shared-leaf 433 autokill.
  @nick_fallback_attempts 3

  # Floor for a cap inferred from a 433 echo. RFC 1459's NICKLEN is 9 and no
  # real ircd advertises less, so anything below it is not a short network —
  # it is a stale/duplicate 433 still echoing an earlier, shorter nick while
  # we already fly a longer candidate. Believing that echo derives an absurd
  # cap and (with a 3-char suffix) drives `Identifier.collision_fallback/3`
  # through its own `cap > suffix` guard, crashing the Client on a numeric
  # it was supposed to recover from.
  @min_learnable_nick_cap 9

  defp nick_fallback_ladder do
    draws = Stream.repeatedly(&Identifier.random_nick_suffix/0)

    ["_" | draws |> Stream.uniq() |> Enum.take(@nick_fallback_attempts - 1)]
  end

  defp validate_password_present(%{auth_method: :none}), do: :ok

  # GH #1044 — `:server_pass` is the one method whose required secret is NOT
  # `:password`. The PASS line reads the dedicated slot, so that is what must
  # be present; `:password` on such a row is the NickServ secret, which the
  # FSM never emits and must therefore never demand (a gate-only credential
  # legitimately carries none). The error names the slot that is missing
  # rather than reusing `:missing_password`, which since #1044 would point
  # the operator at the OTHER secret.
  defp validate_password_present(%{auth_method: :server_pass} = opts) do
    case Map.get(opts, :server_pass) do
      pw when is_binary(pw) and pw != "" -> :ok
      _ -> {:error, {:missing_server_pass, :server_pass}}
    end
  end

  defp validate_password_present(%{password: pw}) when is_binary(pw) and pw != "",
    do: :ok

  defp validate_password_present(%{auth_method: m}),
    do: {:error, {:missing_password, m}}

  # irc/S5: reject CR/LF/NUL in every field that lands on the wire as
  # part of the registration handshake. `:nick`, `:ident`, `:realname`,
  # `:sasl_user` are always emitted (NICK + USER + AUTHENTICATE PLAIN);
  # `:password` is emitted on `:server_pass` (PASS), `:nickserv_identify`
  # (PRIVMSG NickServ :IDENTIFY), and `:sasl` (SASL PLAIN payload).
  # `:none` carries no password but still emits NICK + USER, so the
  # nick/ident/realname/sasl_user gates fire regardless of method.
  @line_bound_fields [:nick, :ident, :realname, :sasl_user]
  defp validate_line_safe(opts) do
    case Enum.find(@line_bound_fields, fn f ->
           not Identifier.safe_line_token?(Map.fetch!(opts, f))
         end) do
      nil -> validate_password_line_safe(opts)
      field -> {:error, {:invalid_line_token, field}}
    end
  end

  defp validate_password_line_safe(%{auth_method: :none}), do: :ok

  # GH #1044 — on `:server_pass` the two secrets take DIFFERENT gates, because
  # they land on different wire shapes. The `server_pass` becomes the single
  # PASS token, so it takes S30's strict single-token rule below; the
  # `password` is the NickServ secret, which leaves as a PRIVMSG trailing
  # param where a space is legal, so it only takes the CR/LF/NUL floor. It is
  # checked here even though the FSM never emits it: it crosses this boundary,
  # and the self-defending posture applies to everything that does.
  defp validate_password_line_safe(%{auth_method: :server_pass} = opts) do
    with :ok <- validate_pass_token(Map.get(opts, :server_pass), :server_pass) do
      case Map.get(opts, :password) do
        pw when is_binary(pw) and pw != "" -> validate_line_token(pw, :password)
        _ -> :ok
      end
    end
  end

  # S30 — :auto ships the password as the SINGLE PASS wire token (RFC 2812
  # §3.1.1). safe_line_token? (CR/LF/NUL only) let a space or tab through,
  # which the server splits off → the password silently truncates to the first
  # token → 464 ERR_PASSWDMISMATCH + a restart loop with no breadcrumb. Gate
  # the PASS-bound password with the stricter single-token predicate OPER
  # already uses. `validate_password_present/1` has already guaranteed a
  # non-empty binary here.
  defp validate_password_line_safe(%{auth_method: :auto, password: pw}),
    do: validate_pass_token(pw, :password)

  # :sasl (base64-encoded payload) and :nickserv_identify keep the
  # CR/LF/NUL-only line-token gate — a space is legal in those.
  defp validate_password_line_safe(%{password: pw}), do: validate_line_token(pw, :password)

  # The two gates, named once each so the per-method arms above read as the
  # POLICY (which secret takes which rule) rather than restating the
  # predicate. #1044 made the distinction load-bearing: with two secrets on
  # one row, a copy-pasted gate is how the wrong rule ends up on the wrong
  # slot.
  # The field union is the two slots that can carry a PASS-bound secret, not
  # the whole `opt_key()`: Dialyzer measures the narrower one off the call
  # sites and rejects the wider spec as a supertype. Narrowing it here means
  # a third caller has to name its field, which is the right friction.
  @spec validate_pass_token(term(), :password | :server_pass) ::
          :ok | {:error, {:invalid_line_token, :password | :server_pass}}
  defp validate_pass_token(token, field) do
    if Identifier.safe_oper_token?(token),
      do: :ok,
      else: {:error, {:invalid_line_token, field}}
  end

  @spec validate_line_token(term(), :password) :: :ok | {:error, {:invalid_line_token, :password}}
  defp validate_line_token(token, field) do
    if Identifier.safe_line_token?(token),
      do: :ok,
      else: {:error, {:invalid_line_token, field}}
  end

  @doc """
  Returns the bytes the client must send immediately after the socket
  is up: optional PASS, optional CAP LS 302, then NICK + USER. The state
  may advance to `:awaiting_cap_ls` if CAP LS was emitted.
  """
  @spec initial_handshake(t()) :: {t(), [iodata()]}
  def initial_handshake(state) do
    # Helpers prepend onto a reversed accumulator (cons is O(1) vs `++` O(n));
    # we reverse once at the end. Final list order: PASS, CAP LS, NICK, USER.
    {final_state, reversed_sends} =
      {state, []}
      |> maybe_send_pass()
      |> maybe_send_cap_ls()
      |> send_nick_and_user()

    {final_state, Enum.reverse(reversed_sends)}
  end

  @doc """
  The SASL parameters an operator needs to read a failure numeric: the
  mechanism driven, and the form of the authzid field the encoder sends.

  GH #1169. A 904 says only "authentication failed" — a wrong password and
  a payload the server could not parse are the same numeric. These two
  fields separate them at a glance.

  `mechanism` comes from the same attribute that writes the `AUTHENTICATE`
  line, so it cannot name a mechanism the FSM does not drive. `authzid`
  is a label, not a derivation: the encoder hard-codes an empty authzid
  and has no state to read it back from, so the tie between the label and
  the bytes is held by a test that decodes an emitted payload and checks
  its first field really is empty. Change the encoder's authzid and that
  test fails — which is the point, since the defect this breadcrumb was
  written for was prose about the encoder drifting from the encoder.

  `sasl_fields` is the one field that is neither a label nor a constant,
  and it is why this function takes a state at all. Both of the others
  read IDENTICALLY on a healthy handshake and on the malformed payload
  that motivated #1169, so neither could ever separate two 904s: the
  defect was a payload carrying one field too many, and the field COUNT
  is the only thing that differed. It is counted off the payload the FSM
  really emitted (`record_sasl_fields/2`), so it reports what went out
  rather than what the encoder is supposed to send. `:none` means no
  payload was ever encoded — an upstream that refuses the mechanism
  answers the `AUTHENTICATE PLAIN` line itself, and that is a materially
  different failure from a rejected credential.

  The count is a number and reveals nothing: the field CONTENTS never
  reach a metadata key, here or anywhere on this line.
  """
  @spec sasl_breadcrumb(t()) ::
          [{:mechanism, String.t()} | {:authzid, String.t()} | {:sasl_fields, sasl_fields()}]
  def sasl_breadcrumb(%__MODULE__{} = state) do
    [
      mechanism: @sasl_mechanism,
      authzid: "empty",
      # `Map.get` rather than dot-access for the #216 hot-reload contract:
      # a struct built before this field existed answers `:none`.
      sasl_fields: Map.get(state, :sasl_fields) || :none
    ]
  end

  # GH #1044 — one arm per ROLE, and the two are deliberately not merged.
  # On `:server_pass` the PASS token is the network's gate secret, which has
  # its own slot; on `:auto` it is the services secret handed off to NickServ
  # (Bahamut/Azzurra), which is the same secret SASL would carry and so lives
  # in `:password`. Reading one slot with the other's method as a fallback is
  # exactly the two-homes-for-one-role split brain #124 cured.
  defp maybe_send_pass({%__MODULE__{auth_method: :server_pass, server_pass: pw} = state, sends})
       when is_binary(pw) and pw != "" do
    {state, ["PASS #{pw}\r\n" | sends]}
  end

  defp maybe_send_pass({%__MODULE__{auth_method: :auto, password: pw} = state, sends})
       when is_binary(pw) and pw != "" do
    {state, ["PASS #{pw}\r\n" | sends]}
  end

  defp maybe_send_pass(acc), do: acc

  # `CAP LS 302` is the IRCv3.2 negotiation opener — `302` advertises
  # cap-notify support so the server returns multi-line LS replies and
  # post-registration cap changes. We always request the modern dialect;
  # legacy ircd that doesn't grok CAP returns `421 :Unknown command CAP`
  # which the inbound state machine treats as "skip CAP, proceed".
  defp maybe_send_cap_ls({%__MODULE__{auth_method: m} = state, sends})
       when m in [:auto, :sasl] do
    {%{state | phase: :awaiting_cap_ls}, ["CAP LS 302\r\n" | sends]}
  end

  defp maybe_send_cap_ls(acc), do: acc

  # Server queues NICK/USER until CAP END when CAP LS is in flight, so
  # sending them before the SASL exchange completes is safe — the
  # registration is held open until we either CAP END or the server
  # gives up on CAP (`421` / no reply / `001`).
  defp send_nick_and_user({state, sends}) do
    # Reversed-build order: USER pushed before NICK so post-Enum.reverse
    # the final list reads NICK then USER.
    #
    # #152 — the USER username slot carries `ident`, decoupled from the
    # nick. `Networks.SessionPlan` / `Visitors.SessionPlan` thread
    # `Credential.effective_ident/1` / the visitor's ident-or-nick into
    # this field, so a credential that never set a distinct ident still
    # emits `USER <nick> ...` (fallback), preserving pre-#152 behaviour.
    {state,
     [
       "USER #{state.ident} 0 * :#{state.realname}\r\n",
       "NICK #{state.nick}\r\n"
       | sends
     ]}
  end

  @doc """
  Drives one parsed IRC `Message` through the FSM. Returns either
  `{:cont, new_state, [iodata]}` to continue with the optional outbound
  frames flushed, or `{:stop, reason, state, [iodata]}` to terminate
  with a structured reason and any final-flush bytes (e.g. a trailing
  `CAP END` before stopping on `:sasl_unavailable`).
  """
  @spec step(t(), Message.t()) ::
          {:cont, t(), [iodata()]} | {:stop, stop_reason(), t(), [iodata()]}
  # Codebase review 2026-05-08 IRC S1-S4 (4× HIGH): phase guard.
  # Once `:registered`, the FSM is done. Every subsequent IRC message
  # belongs to the host (Session.Server) which already receives it via
  # the `{:irc, msg}` dispatch in `IRC.Client.process_line/2`. Without
  # this guard, the post-handshake clauses below would still fire on
  # post-registration traffic:
  #   * 432/433 from a user-issued `/nick badname` would crash the
  #     Session via `:nick_rejected` stop (S1) — numeric_router already
  #     routes 432/433 to the active window post-registration.
  #   * Stray AUTHENTICATE + from a buggy/malicious upstream would
  #     elicit a verbatim SASL credential reply (S2) — credential leak
  #     under verify_none.
  #   * Stray 904/905 from observability noise would crash the Session
  #     via `:sasl_failed` stop (S3).
  # Cap-message guards already exist (F1 cluster); this generalizes
  # the principle to the four other auth-relevant message classes.
  # Catch-all for `:registered` MUST come BEFORE the per-command
  # clauses so the absorption is unconditional.
  def step(%__MODULE__{phase: :registered} = state, _), do: {:cont, state, []}

  def step(state, %Message{command: :cap, params: params}),
    do: handle_cap(params, state)

  # SASL PLAIN reply — only legitimate in `:sasl_pending` (the FSM phase
  # entered when CAP REQ ACK :sasl elicits the AUTHENTICATE PLAIN we
  # sent ourselves; the upstream's `AUTHENTICATE +` prompt is the
  # documented next step per IRCv3 SASL spec). C1 (CRITICAL — 2026-05-12
  # codebase review): pre-fix this clause matched UNCONDITIONALLY for
  # every phase below `:registered`, so a buggy / hostile / MitM
  # upstream could elicit a verbatim SASL credential reply BEFORE SASL
  # had been negotiated by sending `AUTHENTICATE +` while the FSM was
  # in `:pre_register` / `:awaiting_cap_ls` / `:awaiting_cap_ack` (or
  # the H9 cap-ack phase variants `:awaiting_cap_ack_combined` /
  # `:awaiting_cap_ack_sasl_only`). Under
  # Phase-1 `verify: :verify_none` the leak was network-exploitable.
  # The phase pin closes the leak; the catch-all clause below absorbs
  # stray pre-handshake `AUTHENTICATE` lines silently, mirroring the
  # post-`:registered` absorption above (line 227).
  def step(%__MODULE__{phase: :sasl_pending} = state, %Message{command: :authenticate, params: ["+"]}) do
    payload = sasl_plain_payload(state)
    {:cont, record_sasl_fields(state, payload), ["AUTHENTICATE #{payload}\r\n"]}
  end

  def step(state, %Message{command: :authenticate}), do: {:cont, state, []}
  # ^ C1 catch-all: AUTHENTICATE in `:registered` is absorbed by the
  # line-227 phase-guard arm; this clause covers stray AUTHENTICATE
  # in pre-`:sasl_pending` phases without leaking SASL credentials.

  def step(state, %Message{command: {:numeric, 903}}) do
    {:cont, leave_cap_negotiation(state, :pre_register), ["CAP END\r\n"]}
  end

  def step(state, %Message{command: {:numeric, code}}) when code in [904, 905] do
    {:stop, {:sasl_failed, code}, state, []}
  end

  # 432/433 during :nickserv_identify mode — keep the connection alive
  # so `Grappa.Session.Server` can drive `Grappa.Session.GhostRecovery`'s
  # mangled-NICK + GHOST + WHOIS + IDENTIFY recovery flow. The host owns
  # the wire emission; AuthFSM's role is reduced to "stay alive long
  # enough for the host to recover." Mode-1 (sasl / server_pass / none /
  # auto) retains the operator-must-fix `:nick_rejected` stop below.
  def step(
        %__MODULE__{auth_method: :nickserv_identify} = state,
        %Message{command: {:numeric, code}}
      )
      when code in [432, 433] do
    {:cont, state, []}
  end

  # #676 — 433 ERR_NICKNAMEINUSE with ladder left: retry under the next
  # candidate instead of dead-ending the login. A visitor whose nick is
  # taken upstream used to get no session at all (FSM stop → `:nick_in_use`
  # → HTTP 409) and had to go hunt for the nick field in settings; now they
  # land as `<nick>_` and can rename at leisure. `state.nick` moves to the
  # candidate so the stop reason (once the ladder runs out) names the nick
  # we last actually tried, and so 001's `welcomed_nick` reconciliation has
  # something truthful to compare against.
  #
  # Placed AFTER the `:nickserv_identify` clause on purpose: that mode's
  # 433 belongs to the host's GhostRecovery / RecoverIdentity flows, and a
  # ladder NICK here would race the GHOST sequence off its own nick.
  # 432 is deliberately NOT laddered — an erroneous nick is a SHAPE
  # rejection, and retrying `<badnick>_` re-sends the same bad shape.
  def step(
        %__MODULE__{nick_suffixes: [suffix | rest]} = state,
        %Message{command: {:numeric, 433}, params: params}
      ) do
    cap = learned_nick_cap(state, params)
    candidate = Identifier.collision_fallback(state.orig_nick, suffix, cap)

    {:cont, %{state | nick: candidate, nick_suffixes: rest, nick_cap: cap}, ["NICK #{candidate}\r\n"]}
  end

  # 432 ERR_ERRONEUSNICKNAME / 433 ERR_NICKNAMEINUSE during registration.
  # Without an explicit handler the FSM would sit in `:pre_register` /
  # `:awaiting_cap_*` forever; surface as a structured stop reason so
  # the supervised Session restart fails again identically (correct —
  # the credential nick is wrong, an operator must intervene).
  def step(state, %Message{command: {:numeric, code}})
      when code in [432, 433] do
    {:stop, {:nick_rejected, code, state.nick}, state, []}
  end

  # 001 RPL_WELCOME unconditionally promotes to `:registered`. No
  # `CAP END` is emitted here even when arriving from `:awaiting_cap_ls`:
  # IRCv3 cap negotiation is "active" only after the server replied to
  # `CAP LS`. If the server jumped straight to 001 (Bahamut/Azzurra,
  # very-old-ircd, or a server that 421'd CAP earlier and proceeded), it
  # never opened the negotiation, so closing it would be protocol noise.
  # `cap_unavailable/1` covers the cases where the negotiation WAS opened
  # and must be closed (CAP NAK, no-sasl LS, etc.).
  # #189 — the built-in NickServ IDENTIFY is NO LONGER emitted here. It
  # moved to `Grappa.Session.Server`'s 001 handler so it runs AFTER the
  # on-connect perform list (deterministic order, one process) and can be
  # suppressed when the list already consumed `$nickserv_pass`. AuthFSM's
  # 001 job is now purely the phase promotion + CAP-negotiation close.
  def step(state, %Message{command: {:numeric, 1}}) do
    {:cont, leave_cap_negotiation(state, :registered), []}
  end

  def step(state, _), do: {:cont, state, []}

  # #676 — the upstream NICKLEN, learned from the 433 echo.
  #
  # 005 RPL_ISUPPORT (where NICKLEN lives) only arrives AFTER 001, so at
  # 433 time the advertised cap is genuinely unknowable — the issue's
  # "truncate using the network's advertised NICKLEN" cannot be honoured
  # as written. The 433 line itself carries the evidence instead: an ircd
  # that silently truncated our NICK rejects the SHORTENED spelling, so an
  # echo shorter than what we sent IS the cap. Without this, a 30-char
  # nick on a NICKLEN=16 network would retry with a candidate the server
  # truncates straight back into the same collision, burning the whole
  # ladder on one unreachable nick.
  #
  # A proven cap STICKS (`state.nick_cap`): the clamped candidate fits, so
  # the next echo comes back verbatim and offers no second proof. Only a
  # fresh truncation lowers it — an equal-length echo says nothing.
  defp learned_nick_cap(%__MODULE__{nick: sent, nick_cap: cap}, [_, echoed | _])
       when is_binary(echoed) do
    if truncation_of?(echoed, sent),
      do: max(String.length(echoed), @min_learnable_nick_cap),
      else: cap
  end

  defp learned_nick_cap(%__MODULE__{nick_cap: cap}, _), do: cap

  # Truncation means the server took our nick and CUT it, so the echo is a
  # proper prefix of what we sent — nothing else counts as evidence. Read
  # positionally instead, and a 433 whose second param is a reason string
  # (a short or hostile ircd shape) gets mistaken for a cap.
  #
  # The fold is the identity authority (#121/#537): an ircd may echo the
  # nick case-normalised, and that is still us.
  defp truncation_of?(echoed, sent) do
    folded = Identifier.canonical_target(sent)

    String.length(echoed) < String.length(sent) and
      String.starts_with?(folded, Identifier.canonical_target(echoed))
  end

  # CAP LS continuation: 4th param == "*" marks "more lines coming."
  # IRCv3.2 splits long cap lists; accumulate in `caps_buffer` until a
  # non-* LS line finalizes the set. Without this, modern ircd
  # advertising >8 caps would land "sasl" in the second line and the
  # first line's mismatch would already have triggered cap_unavailable.
  #
  # Phase guard: a stray CAP LS post-registration (CAP NEW spam, buggy
  # upstream emitting `:server CAP nick LS * :junk` repeatedly) MUST
  # NOT mutate `caps_buffer` — without the guard the buffer grows
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
    {:cont, %{state | caps_buffer: parse_cap_list(chunk) ++ state.caps_buffer}, []}
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
  #
  # S4.2: `labeled-response` is requested alongside (or instead of)
  # `sasl` — the ACK blob may contain both. Session.Server handles CAP
  # ACK directly (via `{:irc, %Message{command: :cap, …}}` dispatch from
  # `IRC.Client`) to track which caps are active without coupling the FSM
  # to session state. The FSM only cares whether SASL was ACK'd to
  # drive the AUTHENTICATE flow.
  #
  # H9 (REV-F): both `:awaiting_cap_ack` and `:awaiting_cap_ack_combined`
  # (and the `:awaiting_cap_ack_sasl_only` fallback phase) reach this
  # clause through the guard match — ACK semantics are identical across
  # all three (drive AUTHENTICATE if SASL was ACK'd, otherwise close
  # negotiation). The NAK clause splits per-phase below to drive the
  # combined-REQ fallback.
  defp handle_cap([_, "ACK", caps_blob | _], %{phase: phase} = state)
       when phase in [:awaiting_cap_ack, :awaiting_cap_ack_combined, :awaiting_cap_ack_sasl_only] do
    acked = parse_cap_list(caps_blob)

    if "sasl" in acked do
      {:cont, %{state | phase: :sasl_pending}, ["AUTHENTICATE #{@sasl_mechanism}\r\n"]}
    else
      # SASL not ACK'd — `labeled-response` alone (or CAP END fallback).
      # Session.Server handles the `labeled-response` flag independently;
      # the FSM's job is to close the SASL negotiation cleanly.
      cap_unavailable(state)
    end
  end

  # H9 (REV-F): combined-REQ NAK falls back to `CAP REQ :sasl` alone.
  # Bahamut + some Solanum variants advertise `labeled-response` in
  # CAP LS but NAK the combined `CAP REQ :sasl labeled-response` blob,
  # which pre-fix declared `:sasl_unavailable` immediately and
  # restart-looped a `:sasl`-required credential permanently. The
  # fallback REQ exercises whether SASL is genuinely unavailable
  # (next NAK → `:sasl_unavailable`) or whether `labeled-response`
  # was the sole offender (ACK → SASL chain proceeds).
  #
  # `:auto` auth method also benefits: combined NAK previously fell
  # through to `cap_unavailable/1`'s non-`:sasl` clause (PASS-handoff
  # path, no stop), losing SASL even when the server supports it.
  # The fallback restores SASL eligibility for `:auto` too.
  defp handle_cap([_, "NAK", _ | _], %{phase: :awaiting_cap_ack_combined} = state) do
    {:cont, %{state | phase: :awaiting_cap_ack_sasl_only}, ["CAP REQ :sasl\r\n"]}
  end

  defp handle_cap([_, "NAK", _ | _], %{phase: phase} = state)
       when phase in [:awaiting_cap_ack, :awaiting_cap_ack_sasl_only],
       do: cap_unavailable(state)

  defp handle_cap(_, state), do: {:cont, state, []}

  # Phase guard lives in the `handle_cap` LS clauses above: a stray
  # post-registration CAP LS never reaches here. Caller invariant:
  # `state.phase == :awaiting_cap_ls`.
  #
  # S4.2: request `labeled-response` opportunistically alongside SASL.
  # The cap is IRCv3-standard; it lets Session.Server correlate numeric
  # replies to the originating command window without relying on heuristics.
  # We always request it when advertised, regardless of auth method, because
  # all command verbs (PRIVMSG, NICK, TOPIC, AWAY, etc.) benefit from label
  # correlation — not just SASL-related exchanges.
  #
  # Request shape:
  #   - SASL + labeled-response both advertised → `CAP REQ :sasl labeled-response`,
  #     phase `:awaiting_cap_ack_combined` (H9: on NAK, fall back to `:sasl` alone
  #     before declaring `:sasl_unavailable` — Bahamut/Solanum variants mis-implement
  #     `labeled-response` and NAK the combined blob, but ACK `:sasl` alone)
  #   - Only labeled-response → `CAP REQ :labeled-response`, phase `:awaiting_cap_ack`
  #     (NAK is non-fatal — `cap_unavailable/1` closes negotiation cleanly)
  #   - Only SASL → `CAP REQ :sasl`, phase `:awaiting_cap_ack` (existing behaviour,
  #     NAK declares `:sasl_unavailable` immediately — no labeled-response involved
  #     so no fallback shape applies)
  #   - Neither → fall through to cap_unavailable (existing behaviour)
  #
  # GH #388 generalised the "opportunistic" half from the single
  # `labeled-response` entry to the `@opportunistic_caps` list, adding
  # `account-notify`: the flavour-agnostic identity signal (inbound
  # `ACCOUNT` → `EventRouter`), which is how a solanum/atheme network tells
  # us an identify landed at all — it has no registered umode to watch.
  # Like `labeled-response` it is requested purely because it is advertised,
  # needs no follow-up exchange, and a NAK is non-fatal.
  #
  # The four shapes above are unchanged in BYTES for every existing case:
  # the list is ordered `labeled-response` first, and a server that does not
  # advertise `account-notify` (bahamut / all of prod) produces exactly the
  # pre-#388 REQ line.
  #
  # KNOWN EDGE: the H9 combined-NAK fallback re-requests `:sasl` ALONE, so
  # an ircd that both offers `account-notify` and NAKs the combined blob
  # loses it. That fallback exists for bahamut-family servers, which do not
  # offer `account-notify` in the first place, and SASL is the cap we cannot
  # trade away — so the loss is theoretical and the alternative (an extra
  # per-cap REQ ladder) buys nothing real.
  @opportunistic_caps ["labeled-response", "account-notify"]

  defp finalize_cap_ls(caps, state) do
    sasl_wanted = "sasl" in caps and state.auth_method in [:auto, :sasl]
    opportunistic = Enum.filter(@opportunistic_caps, &(&1 in caps))

    case {sasl_wanted, opportunistic} do
      {true, []} ->
        {:cont, leave_cap_negotiation(state, :awaiting_cap_ack), [cap_req(["sasl"])]}

      {true, extras} ->
        {:cont, leave_cap_negotiation(state, :awaiting_cap_ack_combined), [cap_req(["sasl" | extras])]}

      {false, []} ->
        cap_unavailable(state)

      {false, extras} ->
        # No SASL, but at least one opportunistic cap is available. Request
        # it and close CAP negotiation with CAP END — none of them has a
        # follow-up exchange (unlike SASL). Session.Server detects the ACK
        # independently.
        {:cont, leave_cap_negotiation(state, :awaiting_cap_ack), [cap_req(extras)]}
    end
  end

  @doc """
  Builds a `CAP REQ` line (CRLF included) asking for `caps`.

  Public for the same reason as `parse_cap_list/1` (issue 2097): the CAP
  NEW seam in `Grappa.Session.Server` re-requests an opportunistic cap the
  upstream re-advertises, and the shape of a CAP line belongs to the module
  that speaks CAP — not re-spelled at the second call site.
  """
  @spec cap_req([String.t()]) :: String.t()
  def cap_req(caps) when is_list(caps), do: "CAP REQ :#{Enum.join(caps, " ")}\r\n"

  # SASL not on offer (or NAK'd). Mandatory SASL (`:sasl`) crashes;
  # `:auto` falls back to the PASS-handoff path (PASS already sent at
  # init for legacy ircd) and ends CAP negotiation cleanly.
  defp cap_unavailable(%{auth_method: :sasl} = state) do
    {state, sends} = maybe_send_cap_end(state)
    {:stop, :sasl_unavailable, state, sends}
  end

  defp cap_unavailable(state) do
    {state, sends} = maybe_send_cap_end(state)
    {:cont, state, sends}
  end

  defp maybe_send_cap_end(%{phase: phase} = state)
       when phase in [
              :awaiting_cap_ls,
              :awaiting_cap_ack,
              :awaiting_cap_ack_combined,
              :awaiting_cap_ack_sasl_only,
              :sasl_pending
            ] do
    {leave_cap_negotiation(state, :pre_register), ["CAP END\r\n"]}
  end

  defp maybe_send_cap_end(state), do: {state, []}

  # Single source of truth for ANY phase change that should clear
  # `:caps_buffer`. `:caps_buffer` accumulates ONLY during
  # `:awaiting_cap_ls` and MUST be empty whenever the phase leaves
  # it. Owning both fields here means "exiting a phase clears all
  # phase-local state" lives in ONE place — no per-callsite reminder
  # to also-clear-the-buffer (today's S6 latency, Phase 5 reconnect's
  # bug). Routed by every transition out of `:awaiting_cap_ls`:
  #
  #   * finalize_cap_ls       (LS         -> AWAIT_ACK | AWAIT_ACK_COMBINED)
  #   * step/2 (numeric 1, _) (LS         -> REGISTERED)
  #   * step/2 (numeric 903)  (SASL_PEND  -> PRE_REGISTER)
  #   * maybe_send_cap_end    (any        -> PRE_REGISTER)
  #
  # The `AWAIT_ACK_COMBINED -> AWAIT_ACK_SASL_ONLY` transition (H9
  # combined-NAK fallback) does NOT route through here: the FSM is
  # still mid-CAP and `caps_buffer` was already cleared at the LS
  # boundary, so a direct `%{state | phase: ...}` is correct.
  defp leave_cap_negotiation(state, new_phase) do
    %{state | phase: new_phase, caps_buffer: []}
  end

  # SASL PLAIN payload is `[authzid] NUL authcid NUL passwd` (RFC 4616 §2)
  # — exactly two separators. The authzid is left EMPTY, which the RFC
  # defines as "authorize as the authenticated identity": the only case
  # Grappa can express, since the credential schema has no authzid column
  # separate from `sasl_user`.
  #
  # GH #1169: this used to emit `<<0, u, 0, u, 0, pw>>` — THREE separators,
  # four fields. An upstream splits on the first two NULs and takes the
  # remainder as the password, so atheme (Libera.Chat and every
  # atheme-fronted network) read `authcid=u` with a password of `u\0pw`
  # and answered with an opaque 904 ERR_SASLFAIL indistinguishable from a
  # wrong credential. The comment that stood here claimed the encoder put
  # `sasl_user` in BOTH fields; it never did — that shape would have been
  # `<<u, 0, u, 0, pw>>`, with no leading NUL. Whether atheme would also
  # reject an explicitly-equal authzid is untested and does not matter:
  # empty is what the RFC calls for and what every mainstream client sends.
  #
  # S29 H10: explicit `is_binary(pw)` guard so a contract violation
  # (state.password somehow nil at the AUTHENTICATE + step) crashes
  # with `FunctionClauseError` naming this clause instead of an
  # opaque `<<nil::binary>>` :badarg from the bitstring builder.
  # `new/1`'s `validate_password_present/1` is the primary gate;
  # this guard is defense-in-depth for any future code path that
  # mutates `state.password` after init.
  #
  # Codebase review 2026-05-12 irc/S4 (HIGH): RFC 4616 §2 forbids NUL
  # in the SASL PLAIN authzid/authcid/passwd fields (NUL is the field
  # separator). Without this encoder-side guard a NUL slipped past
  # the H10 shape check and produced a malformed AUTHENTICATE blob
  # the upstream cannot decode (opaque 904 ERR_SASLFAIL with no log
  # breadcrumb). The primary gate is `new/1`'s safe-line check (irc/S5);
  # this defense-in-depth `raise` at the encoder catches a future code
  # path that mutates `state.{sasl_user,password}` post-init without
  # re-validating, and surfaces as a structured ArgumentError naming
  # the offending field rather than as a malformed wire frame.
  defp sasl_plain_payload(%{sasl_user: u, password: pw})
       when is_binary(u) and is_binary(pw) do
    cond do
      String.contains?(u, "\x00") ->
        raise ArgumentError,
              "sasl_plain_payload: NUL byte in sasl_user (RFC 4616 forbids; reject at irc/S5 boundary)"

      String.contains?(pw, "\x00") ->
        raise ArgumentError,
              "sasl_plain_payload: NUL byte in password (RFC 4616 forbids; reject at irc/S5 boundary)"

      true ->
        Base.encode64(<<0, u::binary, 0, pw::binary>>)
    end
  end

  # GH #1169 — how many NUL-delimited fields the payload we just emitted
  # carried, for the failure breadcrumb.
  #
  # Derived by decoding the EMITTED base64 rather than by reading the
  # encoder's shape, and that indirection is the whole point: the defect
  # this breadcrumb exists for was a comment restating the encoder's shape
  # and drifting from it, so a count restated the same way would report
  # the intended payload while the wire carried another. Counting the
  # bytes that actually went out cannot drift, because there is nothing
  # left to drift from.
  #
  # Only the COUNT is kept. The decoded payload is a local that dies with
  # the call; its fields hold `sasl_user` and the password and neither is
  # stored, returned or logged.
  @spec record_sasl_fields(t(), String.t()) :: t()
  defp record_sasl_fields(state, payload) do
    fields =
      payload
      |> Base.decode64!()
      |> :binary.split(<<0>>, [:global])
      |> length()

    %{state | sasl_fields: fields}
  end

  @doc """
  Parses a CAP cap-list blob into bare capability names.

  The blob is the space-separated token list carried by every cap-bearing
  subcommand — `CAP LS`, `CAP ACK`, `CAP NEW`, `CAP DEL` — where IRCv3.2
  allows each token an optional `=<value>` suffix (`sasl=PLAIN,EXTERNAL`).
  Negotiation only ever inspects names, so the value is dropped.

  Public because the ACK and DEL seams in `Grappa.Session.Server` read the
  same blob (issue 2097). This module owns CAP negotiation, so the ONE
  parse of a cap list lives here rather than being re-spelled per reader:
  before 2097 `Session.Server` carried its own weaker copy that split on
  whitespace and kept the `=<value>` suffix attached, so a valued token
  missed the tracked-cap compare there while matching here.
  """
  # M-irc-3: explicit @spec + nil-reject. `String.split(_, "=", parts: 2)`
  # never returns an empty list for the `trim: true` output, so
  # `List.first/1` never returns nil today — but the type contract
  # surfaces nil as a possibility, and a future refactor that fed nil
  # into `"sasl" in caps` would crash silently with a wrong-shape miss.
  # Reject defensively so the cap-name list is `[String.t()]` by
  # construction.
  @spec parse_cap_list(String.t()) :: [String.t()]
  def parse_cap_list(blob) when is_binary(blob) do
    blob
    |> String.split(" ", trim: true)
    |> Enum.map(fn cap -> cap |> String.trim() |> String.split("=", parts: 2) |> List.first() end)
    |> Enum.reject(&is_nil/1)
  end
end
