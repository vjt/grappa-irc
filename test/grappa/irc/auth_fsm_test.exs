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
  end

  describe "initial_handshake/1" do
    test ":none -> NICK + USER, no PASS, no CAP; phase stays :pre_register" do
      state = new!(%{})
      assert {%AuthFSM{phase: :pre_register}, sends} = AuthFSM.initial_handshake(state)
      assert send_lines(sends) == ["NICK vjt", "USER vjt 0 * :Vincenzo"]
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
end
