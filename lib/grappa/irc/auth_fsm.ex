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
      :server_pass        -> PASS, NICK, USER
      :nickserv_identify  -> NICK, USER -> on 001:
                             PRIVMSG NickServ :IDENTIFY <pw>
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

  Caller is responsible for Logger emission on stop reasons; the FSM
  itself emits no side effect beyond the returned `[iodata]` frames.
  """

  alias Grappa.IRC.{Identifier, Message}

  @auth_methods [:auto, :sasl, :server_pass, :nickserv_identify, :none]

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
          optional(:password) => String.t() | nil
        }

  @type stop_reason ::
          {:sasl_failed, 904 | 905}
          | :sasl_unavailable
          | {:nick_rejected, 432 | 433, String.t()}

  @type t :: %__MODULE__{
          nick: String.t(),
          ident: String.t(),
          realname: String.t(),
          sasl_user: String.t(),
          password: String.t() | nil,
          auth_method: auth_method(),
          phase: phase(),
          caps_buffer: [String.t()]
        }

  @enforce_keys [:nick, :ident, :realname, :sasl_user, :auth_method, :phase]
  # `:password` is the only secret on the struct — `@derive Inspect`
  # excludes it so SASL-report dumps + IEx `:sys.get_state/1` (transitively
  # via the host Client struct) introspection never leak plaintext.
  # CLAUDE.md "Credentials ... never logged."
  @derive {Inspect, except: [:password]}
  defstruct [
    :nick,
    :ident,
    :realname,
    :sasl_user,
    :password,
    :auth_method,
    :phase,
    caps_buffer: []
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
          | {:error, {:invalid_line_token, :nick | :ident | :realname | :sasl_user | :password}}
  def new(%{auth_method: m} = opts) when m in @auth_methods do
    with :ok <- validate_password_present(opts),
         :ok <- validate_line_safe(opts) do
      {:ok,
       %__MODULE__{
         nick: opts.nick,
         ident: opts.ident,
         realname: opts.realname,
         sasl_user: opts.sasl_user,
         password: Map.get(opts, :password),
         auth_method: m,
         phase: :pre_register,
         caps_buffer: []
       }}
    end
  end

  defp validate_password_present(%{auth_method: :none}), do: :ok

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

  # S30 — :server_pass and :auto ship the password as the SINGLE PASS wire
  # token (RFC 2812 §3.1.1). safe_line_token? (CR/LF/NUL only) let a space or
  # tab through, which the server splits off → the password silently
  # truncates to the first token → 464 ERR_PASSWDMISMATCH + a restart loop
  # with no breadcrumb. Gate the PASS-bound password with the stricter
  # single-token predicate OPER already uses. `validate_password_present/1`
  # has already guaranteed a non-empty binary here.
  defp validate_password_line_safe(%{auth_method: m, password: pw})
       when m in [:server_pass, :auto] do
    if Identifier.safe_oper_token?(pw),
      do: :ok,
      else: {:error, {:invalid_line_token, :password}}
  end

  # :sasl (base64-encoded payload) and :nickserv_identify keep the
  # CR/LF/NUL-only line-token gate — a space is legal in those.
  defp validate_password_line_safe(%{password: pw}) do
    if Identifier.safe_line_token?(pw),
      do: :ok,
      else: {:error, {:invalid_line_token, :password}}
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

  defp maybe_send_pass({%__MODULE__{auth_method: m, password: pw} = state, sends})
       when m in [:auto, :server_pass] and is_binary(pw) and pw != "" do
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
    {:cont, state, ["AUTHENTICATE #{sasl_plain_payload(state)}\r\n"]}
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
  def step(state, %Message{command: {:numeric, 1}}) do
    {identified_state, sends} = maybe_nickserv_identify(state)
    {:cont, leave_cap_negotiation(identified_state, :registered), sends}
  end

  def step(state, _), do: {:cont, state, []}

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
      {:cont, %{state | phase: :sasl_pending}, ["AUTHENTICATE PLAIN\r\n"]}
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
  defp finalize_cap_ls(caps, state) do
    sasl_wanted = "sasl" in caps and state.auth_method in [:auto, :sasl]
    labeled_response = "labeled-response" in caps

    cond do
      sasl_wanted and labeled_response ->
        {:cont, leave_cap_negotiation(state, :awaiting_cap_ack_combined), ["CAP REQ :sasl labeled-response\r\n"]}

      sasl_wanted ->
        {:cont, leave_cap_negotiation(state, :awaiting_cap_ack), ["CAP REQ :sasl\r\n"]}

      labeled_response ->
        # No SASL, but labeled-response is available. Request it and close
        # CAP negotiation with CAP END — labeled-response has no follow-up
        # exchange (unlike SASL). Session.Server detects the ACK independently.
        {:cont, leave_cap_negotiation(state, :awaiting_cap_ack), ["CAP REQ :labeled-response\r\n"]}

      true ->
        cap_unavailable(state)
    end
  end

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

  defp maybe_nickserv_identify(%__MODULE__{auth_method: :nickserv_identify, password: pw} = state)
       when is_binary(pw) and pw != "" do
    {state, ["PRIVMSG NickServ :IDENTIFY #{pw}\r\n"]}
  end

  defp maybe_nickserv_identify(state), do: {state, []}

  # SASL PLAIN payload is `\0<authzid>\0<authcid>\0<password>`. We use
  # `sasl_user` for both authzid and authcid — they only differ when the
  # operator wants to authenticate as one identity but appear as another,
  # which Grappa doesn't expose in the credential schema.
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
        Base.encode64(<<0, u::binary, 0, u::binary, 0, pw::binary>>)
    end
  end

  # Parse a CAP LS / CAP ACK cap-list blob: space-separated cap tokens,
  # each optionally suffixed with `=<value>` (we drop the value, keeping
  # only the cap name) — IRCv3.2 cap negotiation only inspects names.
  #
  # M-irc-3: explicit @spec + nil-reject. `String.split(_, "=", parts: 2)`
  # never returns an empty list for the `trim: true` output, so
  # `List.first/1` never returns nil today — but the type contract
  # surfaces nil as a possibility, and a future refactor that fed nil
  # into `"sasl" in caps` would crash silently with a wrong-shape miss.
  # Reject defensively so the cap-name list is `[String.t()]` by
  # construction.
  @spec parse_cap_list(String.t()) :: [String.t()]
  defp parse_cap_list(blob) do
    blob
    |> String.split(" ", trim: true)
    |> Enum.map(fn cap -> cap |> String.split("=", parts: 2) |> List.first() end)
    |> Enum.reject(&is_nil/1)
  end
end
