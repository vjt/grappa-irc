defmodule Grappa.Session.GhostRecoveryTest do
  use ExUnit.Case, async: true

  alias Grappa.IRC.Message
  alias Grappa.Session.GhostRecovery

  describe "step/2 state transitions" do
    test ":idle on 433 with cached password → :awaiting_ghost_notice + GHOST emitted" do
      state = GhostRecovery.init("vjt", "s3cret")
      msg = %Message{command: {:numeric, 433}, params: ["*", "vjt", "Nickname is already in use."]}

      assert {:cont, next, lines} = GhostRecovery.step(state, msg)

      assert next.phase == :awaiting_ghost_notice
      assert next.try_nick == "vjt_"
      assert "NICK vjt_\r\n" in lines
      assert "PRIVMSG NickServ :GHOST vjt s3cret\r\n" in lines
    end

    test ":idle on 433 without cached password → :failed + only NICK underscore" do
      state = GhostRecovery.init("vjt", nil)
      msg = %Message{command: {:numeric, 433}, params: ["*", "vjt", "Nickname is already in use."]}

      assert {:stop, next, lines} = GhostRecovery.step(state, msg)

      assert next.phase == :failed
      assert lines == ["NICK vjt_\r\n"]
    end

    test ":awaiting_ghost_notice on NickServ NOTICE → :awaiting_whois + WHOIS emitted" do
      state = %GhostRecovery{
        phase: :awaiting_ghost_notice,
        orig_nick: "vjt",
        try_nick: "vjt_",
        password: "s3cret"
      }

      msg = %Message{
        command: :notice,
        prefix: {:nick, "NickServ", "services", "services.azzurra.org"},
        params: ["vjt_", "vjt has been ghosted."]
      }

      assert {:cont, next, lines} = GhostRecovery.step(state, msg)

      assert next.phase == :awaiting_whois
      assert lines == ["WHOIS vjt\r\n"]
    end

    test ":awaiting_ghost_notice ignores NOTICE from non-NickServ source" do
      state = %GhostRecovery{phase: :awaiting_ghost_notice, orig_nick: "vjt"}

      msg = %Message{
        command: :notice,
        prefix: {:nick, "alice", nil, nil},
        params: ["vjt_", "hi"]
      }

      assert {:cont, ^state, []} = GhostRecovery.step(state, msg)
    end

    test ":awaiting_whois on 401 for our queried nick → :succeeded + NICK + IDENTIFY" do
      state = %GhostRecovery{
        phase: :awaiting_whois,
        orig_nick: "vjt",
        try_nick: "vjt_",
        password: "s3cret"
      }

      msg = %Message{command: {:numeric, 401}, params: ["vjt_", "vjt", "No such nick"]}

      assert {:stop, next, lines} = GhostRecovery.step(state, msg)

      assert next.phase == :succeeded
      assert "NICK vjt\r\n" in lines
      assert "PRIVMSG NickServ :IDENTIFY s3cret\r\n" in lines
    end

    test ":awaiting_whois on 311 for our queried nick → :failed" do
      state = %GhostRecovery{phase: :awaiting_whois, orig_nick: "vjt"}

      msg = %Message{
        command: {:numeric, 311},
        params: ["vjt_", "vjt", "user", "host", "*", "Real"]
      }

      assert {:stop, next, lines} = GhostRecovery.step(state, msg)

      assert next.phase == :failed
      assert lines == []
    end

    test ":awaiting_whois ignores 401/311 for unrelated queried nick" do
      state = %GhostRecovery{phase: :awaiting_whois, orig_nick: "vjt"}

      unrelated_401 = %Message{command: {:numeric, 401}, params: ["vjt_", "alice", "No such nick"]}
      assert {:cont, ^state, []} = GhostRecovery.step(state, unrelated_401)

      unrelated_311 = %Message{
        command: {:numeric, 311},
        params: ["vjt_", "bob", "user", "host", "*", "Real"]
      }

      assert {:cont, ^state, []} = GhostRecovery.step(state, unrelated_311)
    end

    # S2 (#364 codebase review 2026-07-19) — the 401/311 echo comes from the
    # ghost holder's server-side user record and can differ in CASE (or the
    # rfc1459 bracket-fold `[]\~` → `{}|^`) from the configured orig_nick.
    # Pre-fix these guarded `when queried == orig` (bare ==), so a folded
    # echo missed the clause, fell to the no-op catch-all, and stalled the FSM
    # until the 8s :ghost_timeout forced :failed — a one-round-trip recovery
    # silently degraded. Both sides must fold via Identifier.canonical_nick/1
    # (GH #121), mirroring EventRouter.nick_eq?/2.
    test ":awaiting_whois on 401 for a CASE-differing echo still succeeds (#364 S2)" do
      state = %GhostRecovery{
        phase: :awaiting_whois,
        orig_nick: "Kazam",
        try_nick: "Kazam_",
        password: "s3cret"
      }

      # Server echoes the folded/downcased form in params[1].
      msg = %Message{command: {:numeric, 401}, params: ["Kazam_", "kazam", "No such nick"]}

      assert {:stop, next, lines} = GhostRecovery.step(state, msg)
      assert next.phase == :succeeded
      assert "NICK Kazam\r\n" in lines
      assert "PRIVMSG NickServ :IDENTIFY s3cret\r\n" in lines
    end

    test ":awaiting_whois on 311 for a bracket-fold echo still fails-fast (#364 S2)" do
      # rfc1459: orig `foo[x]` folds to `foo{x}` — the server's 311 echo.
      state = %GhostRecovery{phase: :awaiting_whois, orig_nick: "foo[x]"}

      msg = %Message{
        command: {:numeric, 311},
        params: ["foo[x]_", "foo{x}", "user", "host", "*", "Real"]
      }

      assert {:stop, next, []} = GhostRecovery.step(state, msg)
      assert next.phase == :failed
    end

    test ":timeout in any non-terminal phase → :failed" do
      for phase <- [:idle, :awaiting_ghost_notice, :awaiting_whois] do
        state = %GhostRecovery{phase: phase, orig_nick: "vjt"}
        assert {:stop, %{phase: :failed}, []} = GhostRecovery.step(state, :timeout)
      end
    end

    test "terminal phases pass any input through with no effect" do
      for phase <- [:succeeded, :failed] do
        state = %GhostRecovery{phase: phase, orig_nick: "vjt"}
        msg = %Message{command: {:numeric, 433}, params: ["*", "vjt"]}
        assert {:cont, ^state, []} = GhostRecovery.step(state, msg)
        assert {:cont, ^state, []} = GhostRecovery.step(state, :timeout)
      end
    end

    test "unrelated inbound message is a no-op" do
      state = GhostRecovery.init("vjt", "s3cret")
      msg = %Message{command: :privmsg, params: ["#room", "hi"]}
      assert {:cont, ^state, []} = GhostRecovery.step(state, msg)
    end
  end

  describe "init/2" do
    test "starts in :idle with orig_nick + password fields populated" do
      assert %GhostRecovery{
               phase: :idle,
               orig_nick: "vjt",
               password: "s3cret",
               try_nick: nil
             } = GhostRecovery.init("vjt", "s3cret")
    end

    test "accepts nil password (anon-shape recovery without ghosting capacity)" do
      assert %GhostRecovery{phase: :idle, orig_nick: "vjt", password: nil} =
               GhostRecovery.init("vjt", nil)
    end
  end
end
