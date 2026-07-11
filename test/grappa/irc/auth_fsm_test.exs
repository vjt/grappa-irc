defmodule Grappa.IRC.AuthFSMTest do
  @moduledoc """
  Pure-function unit tests for the auth state machine.

  No GenServer, no socket, no Bypass — these tests exercise transitions
  with synthetic `Grappa.IRC.Message` structs and assert the
  `(state, [iodata])` tuple shape directly. The integration coverage
  lives in `Grappa.IRC.ClientTest`; this file pins the FSM in isolation
  so the Phase 6 listener facade can reuse it without inheriting the
  GenServer infrastructure.
  """
  use ExUnit.Case, async: true

  alias Grappa.IRC.{AuthFSM, Message}

  defp base_opts(overrides) do
    Map.merge(
      %{
        nick: "vjt",
        ident: "vjt",
        realname: "Vincenzo",
        sasl_user: "vjt",
        auth_method: :none
      },
      overrides
    )
  end

  defp new!(overrides) do
    {:ok, state} = AuthFSM.new(base_opts(overrides))
    state
  end

  defp send_lines(sends) do
    sends |> IO.iodata_to_binary() |> String.split("\r\n", trim: true)
  end

  describe "new/1" do
    test ":none with no password is allowed (only no-secret branch)" do
      assert {:ok,
              %AuthFSM{
                auth_method: :none,
                phase: :pre_register,
                password: nil,
                caps_buffer: []
              }} = AuthFSM.new(base_opts(%{}))
    end

    test ":sasl without password returns {:error, {:missing_password, :sasl}}" do
      assert {:error, {:missing_password, :sasl}} =
               AuthFSM.new(base_opts(%{auth_method: :sasl}))
    end

    test ":nickserv_identify with empty-string password is rejected" do
      assert {:error, {:missing_password, :nickserv_identify}} =
               AuthFSM.new(base_opts(%{auth_method: :nickserv_identify, password: ""}))
    end

    test ":server_pass with valid password is accepted" do
      assert {:ok, %AuthFSM{password: "swordfish", auth_method: :server_pass}} =
               AuthFSM.new(base_opts(%{auth_method: :server_pass, password: "swordfish"}))
    end

    test ":auto with valid password is accepted" do
      assert {:ok, %AuthFSM{auth_method: :auto, password: "swordfish"}} =
               AuthFSM.new(base_opts(%{auth_method: :auto, password: "swordfish"}))
    end

    test "@derive Inspect redacts password (no plaintext leak in inspection)" do
      state = new!(%{auth_method: :sasl, password: "swordfish"})
      refute inspect(state) =~ "swordfish"
    end

    # Codebase review 2026-05-12 irc/S5 (HIGH): AuthFSM trusts caller-
    # supplied nick / realname / sasl_user / password for line
    # construction (NICK / USER / PASS / PRIVMSG NickServ :IDENTIFY /
    # SASL PLAIN). Today saved by `Networks.Credential` validator on
    # the write path; the Phase-6 listener facade reuses the FSM as a
    # library and could bypass that schema. Make AuthFSM self-defending:
    # `new/1` rejects CRLF/NUL in any line-bound field at the boundary,
    # not relying on upstream callers. The new error shape is
    # `{:invalid_line_token, field}` so the operator (or future REST
    # caller) can grep which field tripped the guard.
    test ":sasl with CR in nick rejected at new/1 (irc/S5)" do
      assert {:error, {:invalid_line_token, :nick}} =
               AuthFSM.new(base_opts(%{auth_method: :sasl, nick: "vjt\rEVIL", password: "p"}))
    end

    test ":sasl with LF in realname rejected at new/1 (irc/S5)" do
      assert {:error, {:invalid_line_token, :realname}} =
               AuthFSM.new(base_opts(%{auth_method: :sasl, realname: "Vincenzo\nNICK pwn", password: "p"}))
    end

    test ":sasl with NUL in sasl_user rejected at new/1 (irc/S5)" do
      assert {:error, {:invalid_line_token, :sasl_user}} =
               AuthFSM.new(base_opts(%{auth_method: :sasl, sasl_user: "vjt\x00", password: "p"}))
    end

    test "CR in ident rejected at new/1 (irc/S5, #152)" do
      # ident lands on the USER line's username slot — same CRLF-injection
      # class as nick/realname/sasl_user. The schema sanitizes/validates
      # ident upstream, but the FSM self-defends (Phase-6 listener + any
      # future REST caller that bypasses the changeset).
      assert {:error, {:invalid_line_token, :ident}} =
               AuthFSM.new(base_opts(%{auth_method: :sasl, ident: "grp\rEVIL", password: "p"}))
    end

    test ":sasl with NUL in password rejected at new/1 (irc/S5+S4)" do
      assert {:error, {:invalid_line_token, :password}} =
               AuthFSM.new(base_opts(%{auth_method: :sasl, password: "swo\x00rd"}))
    end

    test ":server_pass with CRLF in password rejected at new/1 (irc/S5)" do
      assert {:error, {:invalid_line_token, :password}} =
               AuthFSM.new(base_opts(%{auth_method: :server_pass, password: "p\r\nQUIT :pwn"}))
    end

    test ":nickserv_identify with CRLF in password rejected at new/1 (irc/S5)" do
      assert {:error, {:invalid_line_token, :password}} =
               AuthFSM.new(base_opts(%{auth_method: :nickserv_identify, password: "p\r\nQUIT :pwn"}))
    end

    # S30 — PASS is a single wire token (RFC 2812 §3.1.1). A space/tab in a
    # :server_pass / :auto password would split it, silently truncating
    # server-side to the first token → 464 + restart loop with no breadcrumb.
    test ":server_pass with a space in password rejected at new/1 (S30)" do
      assert {:error, {:invalid_line_token, :password}} =
               AuthFSM.new(base_opts(%{auth_method: :server_pass, password: "sword fish"}))
    end

    test ":auto with a tab in password rejected at new/1 (S30)" do
      assert {:error, {:invalid_line_token, :password}} =
               AuthFSM.new(base_opts(%{auth_method: :auto, password: "sword\tfish"}))
    end

    # :sasl base64-encodes the payload, so a space in the password is safe on
    # the wire — the stricter PASS gate must NOT tighten SASL.
    test ":sasl with a space in password is still accepted (only CR/LF/NUL barred)" do
      assert {:ok, %AuthFSM{auth_method: :sasl, password: "sword fish"}} =
               AuthFSM.new(base_opts(%{auth_method: :sasl, password: "sword fish"}))
    end

    test ":none with CRLF in nick rejected at new/1 (irc/S5)" do
      # :none also writes NICK + USER lines; the guard applies regardless
      # of auth_method since every method emits NICK/USER at handshake.
      assert {:error, {:invalid_line_token, :nick}} =
               AuthFSM.new(base_opts(%{auth_method: :none, nick: "vjt\r\nQUIT"}))
    end
  end

  # Codebase review 2026-05-12 irc/S4 (HIGH): RFC 4616 §2 forbids NUL
  # in any SASL PLAIN field (NUL is the field separator). Without an
  # encoder-side guard a NUL-bearing password / sasl_user would slip
  # past `new/1`'s shape check (`is_binary` + non-empty) and become a
  # malformed AUTHENTICATE blob the upstream cannot decode (opaque
  # 904 ERR_SASLFAIL). The primary gate is `new/1`'s safe-line check
  # (irc/S5); this defense-in-depth gate at the encoder mirrors the
  # H10 `is_binary(pw)` clause already in place — a future code path
  # that mutates state.{sasl_user,password} after init crashes with a
  # FunctionClauseError naming this clause instead of leaking bytes.
  describe "sasl_plain_payload/1 — NUL guard (irc/S4)" do
    test "NUL-bearing password raises ArgumentError naming the field rather than emitting malformed AUTHENTICATE" do
      # Bypass new/1's safe-line guard by mutating state.password in
      # the test — simulates a future code path that re-loads the
      # credential post-init without re-validating.
      state =
        Map.put(
          %{new!(%{auth_method: :sasl, password: "swordfish"}) | password: "swo\x00rd"},
          :phase,
          :sasl_pending
        )

      assert_raise ArgumentError, ~r/NUL byte in password/, fn ->
        AuthFSM.step(state, %Message{command: :authenticate, params: ["+"]})
      end
    end

    test "NUL-bearing sasl_user raises ArgumentError naming the field rather than emitting malformed AUTHENTICATE" do
      state =
        Map.put(
          %{new!(%{auth_method: :sasl, password: "swordfish"}) | sasl_user: "vj\x00t"},
          :phase,
          :sasl_pending
        )

      assert_raise ArgumentError, ~r/NUL byte in sasl_user/, fn ->
        AuthFSM.step(state, %Message{command: :authenticate, params: ["+"]})
      end
    end
  end

  describe "initial_handshake/1" do
    test ":none -> NICK + USER, no PASS, no CAP; phase stays :pre_register" do
      state = new!(%{})
      assert {%AuthFSM{phase: :pre_register}, sends} = AuthFSM.initial_handshake(state)
      assert send_lines(sends) == ["NICK vjt", "USER vjt 0 * :Vincenzo"]
    end

    test "USER line uses ident (not nick) when ident differs from nick (#152)" do
      # The USER username slot carries `ident`, decoupled from the nick.
      state = new!(%{ident: "grp"})
      assert {%AuthFSM{}, sends} = AuthFSM.initial_handshake(state)
      assert send_lines(sends) == ["NICK vjt", "USER grp 0 * :Vincenzo"]
    end

    test ":server_pass -> PASS BEFORE NICK + USER, no CAP" do
      state = new!(%{auth_method: :server_pass, password: "swordfish"})
      assert {%AuthFSM{phase: :pre_register}, sends} = AuthFSM.initial_handshake(state)

      assert send_lines(sends) == [
               "PASS swordfish",
               "NICK vjt",
               "USER vjt 0 * :Vincenzo"
             ]
    end

    test ":sasl -> CAP LS 302 + NICK + USER (no PASS); phase advances to :awaiting_cap_ls" do
      state = new!(%{auth_method: :sasl, password: "swordfish"})
      assert {%AuthFSM{phase: :awaiting_cap_ls}, sends} = AuthFSM.initial_handshake(state)

      assert send_lines(sends) == [
               "CAP LS 302",
               "NICK vjt",
               "USER vjt 0 * :Vincenzo"
             ]
    end

    test ":auto with password -> PASS + CAP LS 302 + NICK + USER; phase :awaiting_cap_ls" do
      state = new!(%{auth_method: :auto, password: "swordfish"})
      assert {%AuthFSM{phase: :awaiting_cap_ls}, sends} = AuthFSM.initial_handshake(state)

      assert send_lines(sends) == [
               "PASS swordfish",
               "CAP LS 302",
               "NICK vjt",
               "USER vjt 0 * :Vincenzo"
             ]
    end

    test ":nickserv_identify -> NICK + USER only; password emitted post-001" do
      state = new!(%{auth_method: :nickserv_identify, password: "swordfish"})
      assert {%AuthFSM{phase: :pre_register}, sends} = AuthFSM.initial_handshake(state)
      assert send_lines(sends) == ["NICK vjt", "USER vjt 0 * :Vincenzo"]
    end
  end

  describe "step/2 — CAP negotiation chain (auth_method :sasl)" do
    setup do
      {state, _} = AuthFSM.initial_handshake(new!(%{auth_method: :sasl, password: "swordfish"}))
      %{state: state}
    end

    test "CAP LS :sasl=PLAIN -> CAP REQ :sasl + phase :awaiting_cap_ack", %{state: state} do
      msg = %Message{command: :cap, params: ["*", "LS", "sasl=PLAIN"]}

      assert {:cont, %AuthFSM{phase: :awaiting_cap_ack, caps_buffer: []}, sends} =
               AuthFSM.step(state, msg)

      assert send_lines(sends) == ["CAP REQ :sasl"]
    end

    test "CAP LS without sasl on :sasl auth -> :stop :sasl_unavailable + CAP END flush",
         %{state: state} do
      msg = %Message{command: :cap, params: ["*", "LS", "extended-join chghost"]}

      assert {:stop, :sasl_unavailable, %AuthFSM{phase: :pre_register, caps_buffer: []}, sends} =
               AuthFSM.step(state, msg)

      assert send_lines(sends) == ["CAP END"]
    end

    test "CAP LS continuation accumulates caps_buffer (`*` continuation marker)",
         %{state: state} do
      msg1 = %Message{command: :cap, params: ["*", "LS", "*", "extended-join chghost"]}
      assert {:cont, state2, []} = AuthFSM.step(state, msg1)
      assert state2.phase == :awaiting_cap_ls
      assert "extended-join" in state2.caps_buffer
      assert "chghost" in state2.caps_buffer

      msg2 = %Message{command: :cap, params: ["*", "LS", "sasl=PLAIN"]}

      assert {:cont, %AuthFSM{phase: :awaiting_cap_ack, caps_buffer: []}, sends} =
               AuthFSM.step(state2, msg2)

      assert send_lines(sends) == ["CAP REQ :sasl"]
    end

    test "CAP REQ ACK :sasl -> AUTHENTICATE PLAIN + phase :sasl_pending",
         %{state: state} do
      msg = %Message{command: :cap, params: ["*", "ACK", "sasl"]}
      ack_state = %{state | phase: :awaiting_cap_ack}

      assert {:cont, %AuthFSM{phase: :sasl_pending}, sends} =
               AuthFSM.step(ack_state, msg)

      assert send_lines(sends) == ["AUTHENTICATE PLAIN"]
    end

    test "CAP REQ NAK :sasl on :sasl auth -> :stop :sasl_unavailable + CAP END flush",
         %{state: state} do
      msg = %Message{command: :cap, params: ["*", "NAK", "sasl"]}
      ack_state = %{state | phase: :awaiting_cap_ack}

      assert {:stop, :sasl_unavailable, %AuthFSM{phase: :pre_register, caps_buffer: []}, sends} =
               AuthFSM.step(ack_state, msg)

      assert send_lines(sends) == ["CAP END"]
    end
  end

  describe "step/2 — CAP NAK on :auto auth (Bahamut/Azzurra fallback)" do
    test "CAP REQ NAK on :auto -> CAP END flush, no crash, phase :pre_register" do
      {state, _} = AuthFSM.initial_handshake(new!(%{auth_method: :auto, password: "swordfish"}))
      ack_state = %{state | phase: :awaiting_cap_ack}

      msg = %Message{command: :cap, params: ["*", "NAK", "sasl"]}

      assert {:cont, %AuthFSM{phase: :pre_register, caps_buffer: []}, sends} =
               AuthFSM.step(ack_state, msg)

      assert send_lines(sends) == ["CAP END"]
    end
  end

  # H9 (REV-F): combined CAP REQ `:sasl labeled-response` NAK fallback.
  # Bahamut + some Solanum variants advertise `labeled-response` in CAP LS
  # but NAK the combined REQ blob; pre-fix that immediately declared
  # `:sasl_unavailable` and a `:sasl`-required credential restart-looped
  # permanently. The fallback REQ exercises `:sasl` alone before giving up.
  describe "step/2 — H9 combined-REQ fallback on NAK (REV-F)" do
    setup do
      {state, _} = AuthFSM.initial_handshake(new!(%{auth_method: :sasl, password: "swordfish"}))
      %{state: state}
    end

    test "CAP LS :sasl + labeled-response -> combined CAP REQ + phase :awaiting_cap_ack_combined",
         %{state: state} do
      msg = %Message{command: :cap, params: ["*", "LS", "sasl=PLAIN labeled-response"]}

      assert {:cont, %AuthFSM{phase: :awaiting_cap_ack_combined, caps_buffer: []}, sends} =
               AuthFSM.step(state, msg)

      assert send_lines(sends) == ["CAP REQ :sasl labeled-response"]
    end

    test "combined CAP REQ NAK -> fallback CAP REQ :sasl + phase :awaiting_cap_ack_sasl_only (NO :stop)",
         %{state: state} do
      combined_state = %{state | phase: :awaiting_cap_ack_combined}
      msg = %Message{command: :cap, params: ["*", "NAK", "sasl labeled-response"]}

      assert {:cont, %AuthFSM{phase: :awaiting_cap_ack_sasl_only}, sends} =
               AuthFSM.step(combined_state, msg)

      assert send_lines(sends) == ["CAP REQ :sasl"]
    end

    test "fallback REQ ACK :sasl -> AUTHENTICATE PLAIN + phase :sasl_pending (SASL proceeds)",
         %{state: state} do
      fallback_state = %{state | phase: :awaiting_cap_ack_sasl_only}
      msg = %Message{command: :cap, params: ["*", "ACK", "sasl"]}

      assert {:cont, %AuthFSM{phase: :sasl_pending}, sends} =
               AuthFSM.step(fallback_state, msg)

      assert send_lines(sends) == ["AUTHENTICATE PLAIN"]
    end

    test "fallback REQ NAK -> :stop :sasl_unavailable + CAP END (genuine no-SASL)",
         %{state: state} do
      fallback_state = %{state | phase: :awaiting_cap_ack_sasl_only}
      msg = %Message{command: :cap, params: ["*", "NAK", "sasl"]}

      assert {:stop, :sasl_unavailable, %AuthFSM{phase: :pre_register, caps_buffer: []}, sends} =
               AuthFSM.step(fallback_state, msg)

      assert send_lines(sends) == ["CAP END"]
    end

    test ":auto auth: combined NAK ALSO triggers fallback (preserves SASL eligibility)" do
      # Pre-H9, `:auto` combined-NAK fell through to cap_unavailable's
      # non-`:sasl` clause (no :stop, PASS-handoff path) — losing SASL
      # entirely even when the server supported it. Post-H9 the fallback
      # exercises `:sasl` alone first; only the SECOND NAK falls back
      # to the PASS-handoff path.
      {state, _} = AuthFSM.initial_handshake(new!(%{auth_method: :auto, password: "swordfish"}))
      combined_state = %{state | phase: :awaiting_cap_ack_combined}
      msg = %Message{command: :cap, params: ["*", "NAK", "sasl labeled-response"]}

      assert {:cont, %AuthFSM{phase: :awaiting_cap_ack_sasl_only}, sends} =
               AuthFSM.step(combined_state, msg)

      assert send_lines(sends) == ["CAP REQ :sasl"]
    end

    test ":auto auth: fallback REQ NAK -> :cont (PASS-handoff, NO :stop on :auto)" do
      # Mirror of the unchanged-behavior invariant for `:auto`: when
      # SASL is genuinely unavailable, `:auto` falls back cleanly
      # (no stop) instead of crashing. The post-H9 path arrives here
      # through `:awaiting_cap_ack_sasl_only -> cap_unavailable/1`,
      # whose non-`:sasl` clause is the existing `:auto` fallback.
      {state, _} = AuthFSM.initial_handshake(new!(%{auth_method: :auto, password: "swordfish"}))
      fallback_state = %{state | phase: :awaiting_cap_ack_sasl_only}
      msg = %Message{command: :cap, params: ["*", "NAK", "sasl"]}

      assert {:cont, %AuthFSM{phase: :pre_register, caps_buffer: []}, sends} =
               AuthFSM.step(fallback_state, msg)

      assert send_lines(sends) == ["CAP END"]
    end

    test "non-combined SASL-only REQ NAK on :sasl auth UNCHANGED (no labeled-response → no fallback)",
         %{state: state} do
      # Invariant preservation: if `labeled-response` was NOT advertised
      # in CAP LS, the REQ goes out as `:sasl` alone → phase
      # `:awaiting_cap_ack` (not `:awaiting_cap_ack_combined`). NAK on
      # this phase is still the immediate `:sasl_unavailable` declaration
      # — there's nothing to fall back FROM. Re-asserts the existing
      # behavior under H9 to pin the per-phase NAK dispatch.
      ack_state = %{state | phase: :awaiting_cap_ack}
      msg = %Message{command: :cap, params: ["*", "NAK", "sasl"]}

      assert {:stop, :sasl_unavailable, %AuthFSM{phase: :pre_register, caps_buffer: []}, sends} =
               AuthFSM.step(ack_state, msg)

      assert send_lines(sends) == ["CAP END"]
    end
  end

  describe "step/2 — SASL chain" do
    setup do
      {state, _} = AuthFSM.initial_handshake(new!(%{auth_method: :sasl, password: "swordfish"}))
      %{state: %{state | phase: :sasl_pending}}
    end

    test "AUTHENTICATE + -> AUTHENTICATE <base64 PLAIN payload>; state unchanged",
         %{state: state} do
      msg = %Message{command: :authenticate, params: ["+"]}

      assert {:cont, ^state, sends} = AuthFSM.step(state, msg)
      [line] = send_lines(sends)
      "AUTHENTICATE " <> b64 = line
      # PLAIN: \0authzid\0authcid\0password — authzid=authcid=sasl_user
      assert Base.decode64!(b64) == <<0, "vjt", 0, "vjt", 0, "swordfish">>
    end

    test "903 SASL ok -> CAP END + phase :pre_register + caps_buffer cleared",
         %{state: state} do
      msg = %Message{command: {:numeric, 903}}

      assert {:cont, %AuthFSM{phase: :pre_register, caps_buffer: []}, sends} =
               AuthFSM.step(state, msg)

      assert send_lines(sends) == ["CAP END"]
    end

    test "904 SASL fail -> :stop {:sasl_failed, 904}", %{state: state} do
      msg = %Message{command: {:numeric, 904}}
      assert {:stop, {:sasl_failed, 904}, _, []} = AuthFSM.step(state, msg)
    end

    test "905 SASL fail -> :stop {:sasl_failed, 905}", %{state: state} do
      msg = %Message{command: {:numeric, 905}}
      assert {:stop, {:sasl_failed, 905}, _, []} = AuthFSM.step(state, msg)
    end
  end

  describe "step/2 — registration completion (numeric 001)" do
    test "001 -> :registered + caps_buffer cleared (no NickServ identify on :auto)" do
      {state, _} = AuthFSM.initial_handshake(new!(%{auth_method: :auto, password: "swordfish"}))
      # Mid-LS residue: simulate a server emitting 001 while continuation
      # chunks were buffered. The leave_cap_negotiation invariant must
      # still wipe caps_buffer (C6 / S6).
      mid_ls_state = %{state | caps_buffer: ["stale", "chunks"]}

      msg = %Message{command: {:numeric, 1}}

      assert {:cont, %AuthFSM{phase: :registered, caps_buffer: []}, []} =
               AuthFSM.step(mid_ls_state, msg)
    end

    test "001 with auth_method :nickserv_identify -> PRIVMSG NickServ :IDENTIFY <pw>" do
      {state, _} = AuthFSM.initial_handshake(new!(%{auth_method: :nickserv_identify, password: "swordfish"}))

      msg = %Message{command: {:numeric, 1}}

      assert {:cont, %AuthFSM{phase: :registered, caps_buffer: []}, sends} =
               AuthFSM.step(state, msg)

      assert send_lines(sends) == ["PRIVMSG NickServ :IDENTIFY swordfish"]
    end

    test "001 on :none -> :registered, no extra sends" do
      {state, _} = AuthFSM.initial_handshake(new!(%{}))

      msg = %Message{command: {:numeric, 1}}

      assert {:cont, %AuthFSM{phase: :registered, caps_buffer: []}, []} =
               AuthFSM.step(state, msg)
    end
  end

  describe "step/2 — error numerics" do
    setup do
      %{state: new!(%{})}
    end

    test "433 NICKNAMEINUSE -> :stop {:nick_rejected, 433, nick}", %{state: state} do
      msg = %Message{command: {:numeric, 433}}

      assert {:stop, {:nick_rejected, 433, "vjt"}, _, []} =
               AuthFSM.step(state, msg)
    end

    test "432 ERRONEUSNICKNAME -> :stop {:nick_rejected, 432, nick}", %{state: state} do
      msg = %Message{command: {:numeric, 432}}

      assert {:stop, {:nick_rejected, 432, "vjt"}, _, []} =
               AuthFSM.step(state, msg)
    end

    test "unrelated numeric (e.g. 421 :Unknown command) is a no-op", %{state: state} do
      msg = %Message{command: {:numeric, 421}}
      assert {:cont, ^state, []} = AuthFSM.step(state, msg)
    end

    test ":nickserv_identify -> 433 is :cont (host drives ghost recovery)" do
      state = new!(%{auth_method: :nickserv_identify, password: "s3cret"})
      msg = %Message{command: {:numeric, 433}, params: ["*", "vjt", "Nickname is already in use."]}

      assert {:cont, ^state, []} = AuthFSM.step(state, msg)
    end

    test ":nickserv_identify -> 432 is :cont (host drives ghost recovery)" do
      state = new!(%{auth_method: :nickserv_identify, password: "s3cret"})
      msg = %Message{command: {:numeric, 432}, params: ["*", "vjt", "Erroneous Nickname"]}

      assert {:cont, ^state, []} = AuthFSM.step(state, msg)
    end

    test "non-:nickserv_identify modes still :stop on 432/433" do
      msg_433 = %Message{command: {:numeric, 433}, params: ["*", "vjt"]}
      msg_432 = %Message{command: {:numeric, 432}, params: ["*", "vjt"]}

      for {method, opts} <- [
            {:none, %{auth_method: :none}},
            {:sasl, %{auth_method: :sasl, password: "s3cret"}},
            {:server_pass, %{auth_method: :server_pass, password: "s3cret"}},
            {:auto, %{auth_method: :auto, password: "s3cret"}}
          ] do
        state = new!(opts)

        assert {:stop, {:nick_rejected, 433, "vjt"}, _, []} = AuthFSM.step(state, msg_433),
               "expected mode #{inspect(method)} to stop on 433"

        assert {:stop, {:nick_rejected, 432, "vjt"}, _, []} = AuthFSM.step(state, msg_432),
               "expected mode #{inspect(method)} to stop on 432"
      end
    end
  end

  describe "step/2 — Bahamut/Azzurra: 001 before any CAP reply" do
    test "auth_method :auto + 001 from :awaiting_cap_ls -> :registered (no stall)" do
      {state, _} = AuthFSM.initial_handshake(new!(%{auth_method: :auto, password: "swordfish"}))
      assert state.phase == :awaiting_cap_ls

      msg = %Message{command: {:numeric, 1}}

      assert {:cont, %AuthFSM{phase: :registered, caps_buffer: []}, []} =
               AuthFSM.step(state, msg)
    end
  end

  describe "step/2 — stray CAP LS post-registration (F1 phase guard)" do
    test "stray CAP LS continuation in :registered phase is absorbed; caps_buffer untouched" do
      state = new!(%{auth_method: :auto, password: "swordfish"})
      registered = %{state | phase: :registered}

      msg = %Message{command: :cap, params: ["vjt", "LS", "*", "stray-cap-1 stray-cap-2"]}

      assert {:cont, %AuthFSM{phase: :registered, caps_buffer: []}, []} =
               AuthFSM.step(registered, msg)
    end

    test "stray CAP ACK in :registered phase is absorbed (no AUTHENTICATE leak)" do
      state = new!(%{auth_method: :auto, password: "swordfish"})
      registered = %{state | phase: :registered}

      msg = %Message{command: :cap, params: ["vjt", "ACK", "sasl"]}
      assert {:cont, ^registered, []} = AuthFSM.step(registered, msg)
    end
  end

  # Codebase review 2026-05-08 IRC S1-S4 (4× HIGH).
  # The FSM clauses for 432/433, AUTHENTICATE +, 904/905 had no phase
  # guard — they fired regardless of `phase`. Once `:registered` was
  # reached:
  #   * 432/433 from a `/nick badname` user-issued NICK crashed the
  #     entire Session via `:nick_rejected` stop (S1).
  #   * Stray AUTHENTICATE + from a buggy/malicious upstream elicited
  #     a verbatim SASL credential reply over the still-cleartext
  #     wire (Phase-1 `verify: :verify_none`) — credential leak (S2).
  #   * Stray 904/905 from observability noise crashed the Session
  #     via `:sasl_failed` stop (S3).
  # Fix: phase guard at the top of `step/2` — once `:registered`, the
  # only auth-relevant message that can still arrive is itself
  # absorbed (cap continuations covered by F1; numerics + AUTHENTICATE
  # by these guards). The host (Session.Server) handles
  # post-registration semantics for these messages independently
  # (numeric_router routes 432/433 to active windows; AUTHENTICATE has
  # no post-registration verb).
  describe "step/2 — stray auth events post-registration (S1-S4 phase guards)" do
    test "S1: stray 432 in :registered phase is absorbed (no :nick_rejected stop)" do
      state = new!(%{auth_method: :auto, password: "swordfish"})
      registered = %{state | phase: :registered}

      msg = %Message{command: {:numeric, 432}, params: ["vjt", "9bad", "Erroneous nickname"]}
      assert {:cont, ^registered, []} = AuthFSM.step(registered, msg)
    end

    test "S1: stray 433 in :registered phase is absorbed (no :nick_rejected stop)" do
      state = new!(%{auth_method: :auto, password: "swordfish"})
      registered = %{state | phase: :registered}

      msg = %Message{command: {:numeric, 433}, params: ["vjt", "alice", "Nickname is already in use"]}
      assert {:cont, ^registered, []} = AuthFSM.step(registered, msg)
    end

    test "S2: stray AUTHENTICATE + in :registered phase NEVER replies with credentials" do
      state = new!(%{auth_method: :sasl, sasl_user: "vjt", password: "secret-do-not-leak"})
      registered = %{state | phase: :registered}

      msg = %Message{command: :authenticate, params: ["+"]}
      assert {:cont, ^registered, sends} = AuthFSM.step(registered, msg)
      # Critical: post-registration AUTHENTICATE + must produce ZERO
      # bytes upstream. Any payload here would carry the SASL PLAIN
      # blob — a credential leak under verify_none.
      assert sends == []
    end

    test "S3: stray 904 in :registered phase is absorbed (no :sasl_failed stop)" do
      state = new!(%{auth_method: :sasl, sasl_user: "vjt", password: "secret"})
      registered = %{state | phase: :registered}

      msg = %Message{command: {:numeric, 904}, params: ["vjt", "SASL authentication failed"]}
      assert {:cont, ^registered, []} = AuthFSM.step(registered, msg)
    end

    test "S3: stray 905 in :registered phase is absorbed (no :sasl_failed stop)" do
      state = new!(%{auth_method: :sasl, sasl_user: "vjt", password: "secret"})
      registered = %{state | phase: :registered}

      msg = %Message{command: {:numeric, 905}, params: ["vjt", "SASL message too long"]}
      assert {:cont, ^registered, []} = AuthFSM.step(registered, msg)
    end

    test "control: 001 is still the LS->REGISTERED transition (phase guard MUST NOT short-circuit it)" do
      state = new!(%{auth_method: :auto, password: "swordfish"})
      pre = %{state | phase: :awaiting_cap_ls}

      msg = %Message{command: {:numeric, 1}, params: ["vjt", "Welcome"]}
      assert {:cont, %AuthFSM{phase: :registered, caps_buffer: []}, []} = AuthFSM.step(pre, msg)
    end
  end

  describe "step/2 — non-auth Messages are pass-through (no-op)" do
    test "PRIVMSG inbound is a no-op for the FSM (Client forwards to dispatch_to)" do
      {state, _} = AuthFSM.initial_handshake(new!(%{}))

      msg = %Message{
        prefix: {:nick, "alice", "~a", "host"},
        command: :privmsg,
        params: ["#chan", "hello"]
      }

      assert {:cont, ^state, []} = AuthFSM.step(state, msg)
    end

    test "PING inbound is a no-op for the FSM (Client owns PONG echo)" do
      {state, _} = AuthFSM.initial_handshake(new!(%{}))

      msg = %Message{command: :ping, params: ["server.tld"]}
      assert {:cont, ^state, []} = AuthFSM.step(state, msg)
    end
  end

  # C1 (CRITICAL — 2026-05-12 codebase review): the `AUTHENTICATE +`
  # clause was matched UNCONDITIONALLY for every phase below `:registered`
  # (the pre-existing `:registered` catch-all only absorbed the
  # post-handshake case). A hostile / buggy / MitM upstream could
  # therefore elicit a verbatim SASL credential reply BEFORE SASL had
  # been negotiated by sending `AUTHENTICATE +` while the FSM was in
  # `:pre_register` / `:awaiting_cap_ls` / `:awaiting_cap_ack`. Under
  # Phase-1 `verify: :verify_none` this credential leak was
  # network-exploitable.
  #
  # Fix: pin the AUTHENTICATE-`+` clause on `phase: :sasl_pending` (the
  # only legitimate phase per the IRCv3 SASL spec). The S2 post-
  # registration test above already pins the `:registered` arm; these
  # tests pin the three remaining pre-handshake arms. Together with the
  # existing `step/2 — SASL chain` describe block (which keeps the
  # legitimate `:sasl_pending → AUTHENTICATE <base64>` reply working),
  # the four-arm matrix is closed.
  describe "step/2 — C1 pre-handshake AUTHENTICATE + phase guard" do
    for phase <- [:pre_register, :awaiting_cap_ls, :awaiting_cap_ack] do
      @phase phase

      test "stray AUTHENTICATE + in #{@phase} phase NEVER replies with credentials" do
        state = new!(%{auth_method: :sasl, sasl_user: "vjt", password: "secret-do-not-leak"})
        pinned = %{state | phase: @phase}

        msg = %Message{command: :authenticate, params: ["+"]}

        assert {:cont, ^pinned, sends} = AuthFSM.step(pinned, msg)
        # Critical: pre-`:sasl_pending` AUTHENTICATE + must produce ZERO
        # bytes upstream. Any payload here would carry the SASL PLAIN
        # blob — a credential leak under verify_none. Mirrors the S2
        # post-registration test above.
        assert sends == []
      end
    end

    test "control: AUTHENTICATE + in :sasl_pending STILL emits the SASL PLAIN reply" do
      # Belt-and-braces: the phase guard MUST NOT short-circuit the
      # legitimate transition. Mirror of the existing SASL-chain happy
      # path in `describe "step/2 — SASL chain"` above; restated here
      # so a refactor of either describe block keeps both invariants
      # visible.
      state = new!(%{auth_method: :sasl, sasl_user: "vjt", password: "swordfish"})
      pending = %{state | phase: :sasl_pending}

      msg = %Message{command: :authenticate, params: ["+"]}

      assert {:cont, ^pending, sends} = AuthFSM.step(pending, msg)
      [line] = send_lines(sends)
      "AUTHENTICATE " <> b64 = line
      assert Base.decode64!(b64) == <<0, "vjt", 0, "vjt", 0, "swordfish">>
    end
  end
end
