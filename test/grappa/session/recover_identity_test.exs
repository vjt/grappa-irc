defmodule Grappa.Session.RecoverIdentityTest do
  use ExUnit.Case, async: true

  alias Grappa.Session.RecoverIdentity

  # Source-verified ordering (GH #581): `+r` is per-nick and only lands
  # when you IDENTIFY while ON the registered nick (sameNick).
  #
  # #623 — the RECLAIM leg is now SEQUENCED, not raced. After a 433/437
  # the FSM sends RECOVER/RELEASE, then on the settle tick sends the
  # re-NICK ALONE and waits for the nick change to be OBSERVED
  # (`:nick_observed`) before the IDENTIFY — a services-side ordering lag
  # can no longer land the IDENTIFY under the OLD (Guest) nick, which
  # never yields `+r`. A 433/437 on the re-NICK is a bounded RETRY (the
  # hold has not cleared yet), NOT a one-shot failure (reverses F2), all
  # inside the host's untouched 15s overall deadline. The two terminal
  # legs are now DISTINCT + trace-diagnosable: nick-never-reclaimed →
  # :nick_unavailable (leg a, `:awaiting_nick`), reclaimed-but-+r-never-
  # confirmed → :identify_unconfirmed (leg b, `:awaiting_final_r`).

  describe "init/2" do
    test "starts in :idle with cred_nick + secret populated, no verb/reason" do
      assert %RecoverIdentity{
               phase: :idle,
               cred_nick: "vjt",
               secret: "s3cret",
               verb: nil,
               reason: nil
             } = RecoverIdentity.init("vjt", "s3cret")
    end
  end

  describe "step/2 — happy path (nick free)" do
    test ":idle + :start → :awaiting_r + NICK then IDENTIFY (sameNick), in order" do
      state = RecoverIdentity.init("vjt", "s3cret")

      assert {:cont, next, lines} = RecoverIdentity.step(state, :start)

      assert next.phase == :awaiting_r
      # NICK MUST precede IDENTIFY so the identify is sameNick and commits +r.
      # The INITIAL leg keeps NICK+IDENTIFY together: when the nick is free the
      # NICK lands with no hold to propagate, so the trailing IDENTIFY is
      # sameNick. (The RECLAIM leg — after RECOVER forced off a live holder —
      # is the racy one #623 sequences.)
      assert lines == ["NICK vjt\r\n", "PRIVMSG NickServ :IDENTIFY vjt s3cret\r\n"]
    end

    test ":awaiting_r + :r_observed → :succeeded, no lines" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}

      assert {:stop, next, []} = RecoverIdentity.step(state, :r_observed)
      assert next.phase == :succeeded
      assert next.reason == nil
    end
  end

  describe "step/2 — wrong password (clean NICK, no +r)" do
    test ":awaiting_r + :timeout → :failed :wrong_password, no lines" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}

      assert {:stop, next, []} = RecoverIdentity.step(state, :timeout)
      assert next.phase == :failed
      assert next.reason == :wrong_password
    end
  end

  describe "step/2 — nick held → verb → settle" do
    test ":awaiting_r + {:nick_error, 433} → :awaiting_verb_settle verb :recover + RECOVER" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}

      assert {:cont, next, lines} = RecoverIdentity.step(state, {:nick_error, 433})

      assert next.phase == :awaiting_verb_settle
      assert next.verb == :recover
      assert lines == ["PRIVMSG NickServ :RECOVER vjt s3cret\r\n"]
    end

    test ":awaiting_r + {:nick_error, 437} → :awaiting_verb_settle verb :release + RELEASE" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}

      assert {:cont, next, lines} = RecoverIdentity.step(state, {:nick_error, 437})

      assert next.phase == :awaiting_verb_settle
      assert next.verb == :release
      assert lines == ["PRIVMSG NickServ :RELEASE vjt s3cret\r\n"]
    end

    test ":awaiting_verb_settle + :settle → :awaiting_nick + NICK ALONE (no IDENTIFY yet)" do
      state = %RecoverIdentity{
        phase: :awaiting_verb_settle,
        cred_nick: "vjt",
        secret: "s3cret",
        verb: :recover
      }

      assert {:cont, next, lines} = RecoverIdentity.step(state, :settle)

      # #623: NICK ALONE. The IDENTIFY waits for :nick_observed so it can never
      # land under the old (Guest) nick and silently fail to grant +r.
      assert next.phase == :awaiting_nick
      assert next.verb == :recover
      assert lines == ["NICK vjt\r\n"]
    end

    test ":awaiting_verb_settle + :timeout → :failed :services_declined" do
      state = %RecoverIdentity{phase: :awaiting_verb_settle, cred_nick: "vjt", verb: :recover}

      assert {:stop, next, []} = RecoverIdentity.step(state, :timeout)
      assert next.phase == :failed
      assert next.reason == :services_declined
    end
  end

  describe "step/2 — #623 reclaim leg: IDENTIFY only after the nick change is OBSERVED" do
    test ":awaiting_nick + :nick_observed → :awaiting_final_r + IDENTIFY ALONE" do
      state = %RecoverIdentity{
        phase: :awaiting_nick,
        cred_nick: "vjt",
        secret: "s3cret",
        verb: :recover
      }

      assert {:cont, next, lines} = RecoverIdentity.step(state, :nick_observed)

      assert next.phase == :awaiting_final_r
      # We are now provably ON the credential nick, so this IDENTIFY is sameNick
      # and commits +r.
      assert lines == ["PRIVMSG NickServ :IDENTIFY vjt s3cret\r\n"]
    end

    test ":awaiting_final_r + :r_observed → :succeeded" do
      state = %RecoverIdentity{
        phase: :awaiting_final_r,
        cred_nick: "vjt",
        secret: "s3cret",
        verb: :recover
      }

      assert {:stop, next, []} = RecoverIdentity.step(state, :r_observed)
      assert next.phase == :succeeded
    end
  end

  describe "step/2 — #623 bounded retry: a 433/437 on the re-NICK is a RETRY, not a one-shot fail" do
    # #623 reverses F2. A refused re-NICK means the hold has not cleared YET —
    # services freed it asynchronously and are lagging. Retrying the NICK as
    # the hold clears is exactly what absorbs the jitter; it is NOT an "empty
    # retry" (RECOVER already ran, so we do NOT re-issue it). The retry emits
    # NO line — it returns to :awaiting_verb_settle so the host re-arms the
    # settle beat, which re-sends the NICK. The loop is bounded by the host's
    # untouched 15s overall deadline.
    test ":awaiting_nick + {:nick_error, 433} → :awaiting_verb_settle (retry), verb kept, NO line" do
      state = %RecoverIdentity{
        phase: :awaiting_nick,
        cred_nick: "vjt",
        secret: "s3cret",
        verb: :recover
      }

      assert {:cont, next, lines} = RecoverIdentity.step(state, {:nick_error, 433})
      assert next.phase == :awaiting_verb_settle
      assert next.verb == :recover
      # No RECOVER re-issue, no NICK here — the settle tick re-sends the NICK.
      assert lines == []
    end

    test ":awaiting_nick + {:nick_error, 437} → :awaiting_verb_settle (retry), verb kept, NO line" do
      state = %RecoverIdentity{
        phase: :awaiting_nick,
        cred_nick: "vjt",
        secret: "s3cret",
        verb: :release
      }

      assert {:cont, next, lines} = RecoverIdentity.step(state, {:nick_error, 437})
      assert next.phase == :awaiting_verb_settle
      assert next.verb == :release
      assert lines == []
    end

    test "full reclaim loop: verb → settle → 433 (retry) → settle → nick_observed → +r → succeeded" do
      state = RecoverIdentity.init("vjt", "s3cret")

      assert {:cont, s1, _} = RecoverIdentity.step(state, :start)

      assert {:cont, s2, ["PRIVMSG NickServ :RECOVER vjt s3cret\r\n"]} =
               RecoverIdentity.step(s1, {:nick_error, 433})

      assert s2.phase == :awaiting_verb_settle

      # First settle → NICK; the hold has NOT cleared yet → 433 → retry.
      assert {:cont, s3, ["NICK vjt\r\n"]} = RecoverIdentity.step(s2, :settle)
      assert s3.phase == :awaiting_nick
      assert {:cont, s4, []} = RecoverIdentity.step(s3, {:nick_error, 433})
      assert s4.phase == :awaiting_verb_settle

      # Second settle → NICK; this time it lands and is OBSERVED → IDENTIFY.
      assert {:cont, s5, ["NICK vjt\r\n"]} = RecoverIdentity.step(s4, :settle)
      assert s5.phase == :awaiting_nick

      assert {:cont, s6, ["PRIVMSG NickServ :IDENTIFY vjt s3cret\r\n"]} =
               RecoverIdentity.step(s5, :nick_observed)

      assert s6.phase == :awaiting_final_r

      assert {:stop, s7, []} = RecoverIdentity.step(s6, :r_observed)
      assert s7.phase == :succeeded
    end
  end

  describe "step/2 — #623 distinct terminal legs (trace-diagnosable)" do
    # leg (a): the re-NICK never lands within the deadline (the hold never
    # cleared, or services kept renaming us) → :nick_unavailable.
    test ":awaiting_nick + :timeout → :failed :nick_unavailable (leg a)" do
      state = %RecoverIdentity{phase: :awaiting_nick, cred_nick: "vjt", verb: :recover}

      assert {:stop, next, []} = RecoverIdentity.step(state, :timeout)
      assert next.phase == :failed
      assert next.reason == :nick_unavailable
    end

    # leg (b): the re-NICK landed (we are ON the nick) and the sameNick
    # IDENTIFY went out, but +r never confirmed by the deadline → a DISTINCT
    # reason from leg (a). Password is proven correct (RECOVER ran), so this
    # is NOT :wrong_password.
    test ":awaiting_final_r + :timeout → :failed :identify_unconfirmed (leg b)" do
      state = %RecoverIdentity{phase: :awaiting_final_r, cred_nick: "vjt", verb: :recover}

      assert {:stop, next, []} = RecoverIdentity.step(state, :timeout)
      assert next.phase == :failed
      assert next.reason == :identify_unconfirmed
    end
  end

  describe "step/2 — wire lines keep the credential nick RAW (key/display/wire split)" do
    # cred_nick is a DISPLAY/WIRE token: its case is presentation and must
    # NOT be folded on the wire. The FSM never lower-cases it.
    test "mixed-case cred_nick round-trips verbatim through NICK/IDENTIFY/RECOVER" do
      state = RecoverIdentity.init("Vjt", "s3cret")
      assert {:cont, r1, l1} = RecoverIdentity.step(state, :start)
      assert l1 == ["NICK Vjt\r\n", "PRIVMSG NickServ :IDENTIFY Vjt s3cret\r\n"]

      assert {:cont, r2, l2} = RecoverIdentity.step(r1, {:nick_error, 433})
      assert l2 == ["PRIVMSG NickServ :RECOVER Vjt s3cret\r\n"]

      # The reclaim leg keeps the raw case too — NICK alone, then IDENTIFY alone.
      assert {:cont, r3, ["NICK Vjt\r\n"]} = RecoverIdentity.step(r2, :settle)

      assert {:cont, _, ["PRIVMSG NickServ :IDENTIFY Vjt s3cret\r\n"]} =
               RecoverIdentity.step(r3, :nick_observed)
    end
  end

  describe "step/2 — no-ops (off-phase inputs and terminal passthrough)" do
    test "off-phase input is a no-op {:cont, state, []}" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}
      # :settle is only valid in :awaiting_verb_settle; :nick_observed only in
      # :awaiting_nick.
      assert {:cont, ^state, []} = RecoverIdentity.step(state, :settle)
      assert {:cont, ^state, []} = RecoverIdentity.step(state, :nick_observed)
    end

    test "a :start on an already-started FSM is a no-op" do
      state = %RecoverIdentity{phase: :awaiting_r, cred_nick: "vjt", secret: "s3cret"}
      assert {:cont, ^state, []} = RecoverIdentity.step(state, :start)
    end

    test "terminal phases pass any input through unchanged with no lines" do
      for phase <- [:succeeded, :failed] do
        state = %RecoverIdentity{phase: phase, cred_nick: "vjt", secret: "s3cret"}
        assert {:cont, ^state, []} = RecoverIdentity.step(state, :start)
        assert {:cont, ^state, []} = RecoverIdentity.step(state, :r_observed)
        assert {:cont, ^state, []} = RecoverIdentity.step(state, {:nick_error, 433})
        assert {:cont, ^state, []} = RecoverIdentity.step(state, :settle)
        assert {:cont, ^state, []} = RecoverIdentity.step(state, :nick_observed)
        assert {:cont, ^state, []} = RecoverIdentity.step(state, :timeout)
      end
    end
  end
end
