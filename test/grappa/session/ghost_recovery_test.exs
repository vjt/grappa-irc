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

    # #618 (d) — the passwordless 433 is NOT this FSM's job. `AuthFSM`'s
    # bounded ladder owns it for every auth_method except
    # `:nickserv_identify`, and this FSM is only ever armed for that one.
    # A hand-built nil-password struct (which `init/2` now refuses) must
    # fall through to the no-op catch-all, never emit a NICK: the GHOST
    # that makes the underscore temporary cannot be sent without a password,
    # so a NICK here would strand the session on `vjt_` with no way back.
    test ":idle on 433 with no password is a no-op, not a bare NICK underscore" do
      state = %GhostRecovery{phase: :idle, orig_nick: "vjt", password: nil}
      msg = %Message{command: {:numeric, 433}, params: ["*", "vjt", "Nickname is already in use."]}

      assert {:cont, ^state, []} = GhostRecovery.step(state, msg)
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
    # ghost holder's server-side user record and can differ in CASE from the
    # configured orig_nick (ASCII fold, #121/#525: A-Z only — the bracket
    # chars `[ ] \ ~` are NOT folded, so a brace twin would NOT match).
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

    test ":awaiting_whois on 311 for a case-fold echo still fails-fast (#525)" do
      # ASCII: orig `foo[x]` matches the server's 311 echo in a different
      # CASE `FOO[X]` (brackets preserved — a brace twin would NOT match).
      state = %GhostRecovery{phase: :awaiting_whois, orig_nick: "foo[x]"}

      msg = %Message{
        command: {:numeric, 311},
        params: ["foo[x]_", "FOO[X]", "user", "host", "*", "Real"]
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

    # #618 (d) — a cached password is a PRECONDITION. The FSM used to accept
    # nil and carry a dedicated no-password 433 clause; the only caller that
    # ever reached it was this test file, because the one production entry
    # point (`Session.Server`'s `:nickserv_identify` 433 arm) is guarded
    # `when is_binary(pwd)` and `pending_password` is only ever staged for
    # `:nickserv_identify`. This asserts the guard, so a future caller cannot
    # quietly resurrect the untested branch by passing nil.
    test "rejects a nil password rather than building a ghost-less FSM" do
      assert_raise FunctionClauseError, fn -> GhostRecovery.init("vjt", nil) end
    end
  end
end
