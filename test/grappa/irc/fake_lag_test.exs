defmodule Grappa.IRC.FakeLagTest do
  @moduledoc """
  #800 S7 — unit tests for the outbound-cost model.

  These pin the ARITHMETIC of the model, not the ircd. Whether bahamut
  actually charges what `FakeLag` models is exactly the open question the
  instrumentation exists to answer; see the module's own boundary note.
  """
  use ExUnit.Case, async: true

  alias Grappa.IRC.FakeLag

  # A monotonic-clock reading is an arbitrary integer that may be negative
  # (`System.monotonic_time/1` starts wherever the VM says). Anchoring the
  # tests at a negative origin keeps a `nil`/zero sentinel from ever
  # passing by accident.
  @t0 -1_000_000

  describe "record/3 — the modelled bank" do
    test "one short command banks bahamut's flat two-second floor" do
      {_, sample} = FakeLag.record(FakeLag.new(), 64, @t0)

      assert sample.bank_model_s == 2.0
    end

    test "cost grows a second per WHOLE 120 bytes — integer division, as in C" do
      {_, at_239} = FakeLag.record(FakeLag.new(), 239, @t0)
      {_, at_240} = FakeLag.record(FakeLag.new(), 240, @t0)

      assert at_239.bank_model_s == 3.0
      assert at_240.bank_model_s == 4.0
    end

    test "back-to-back commands stack, so a burst is what runs the bank up" do
      {after_first, _} = FakeLag.record(FakeLag.new(), 64, @t0)
      {_, sample} = FakeLag.record(after_first, 64, @t0)

      assert sample.bank_model_s == 4.0
    end

    test "wall-clock time between commands drains the bank" do
      {after_first, _} = FakeLag.record(FakeLag.new(), 64, @t0)
      {_, sample} = FakeLag.record(after_first, 64, @t0 + 1_500)

      assert sample.bank_model_s == 2.5
    end

    test "an idle gap longer than the bank clears it — no debt carries over" do
      {after_first, _} = FakeLag.record(FakeLag.new(), 64, @t0)
      {_, sample} = FakeLag.record(after_first, 64, @t0 + 9_000)

      assert sample.bank_model_s == 2.0
    end
  end

  describe "record/3 — distance from the drain gate" do
    test "reports headroom against the ceiling, not just the bank" do
      {_, sample} = FakeLag.record(FakeLag.new(), 64, @t0)

      assert sample.ceiling_s == 10.0
      assert sample.headroom_s == 8.0
    end

    test "headroom goes negative past the gate rather than clamping" do
      state =
        Enum.reduce(1..6, FakeLag.new(), fn _, acc ->
          {acc, _} = FakeLag.record(acc, 64, @t0)
          acc
        end)

      {_, sample} = FakeLag.record(state, 64, @t0)

      assert sample.bank_model_s == 14.0
      assert sample.headroom_s == -4.0
    end

    test "traffic paced slower than its own cost never builds a bank" do
      # The #800 text claims the cost bites only on a connection that has
      # accumulated debt over hundreds of preceding specs. `since` is
      # compared against wall-clock `now`, so it drains in real time: 25
      # minutes of one-command-per-three-seconds leaves the floor, not a
      # ceiling. Pinned here because it is arithmetic, not a measurement —
      # what a real run does is what the instrumentation reports.
      state =
        Enum.reduce(0..499, FakeLag.new(), fn i, acc ->
          {acc, _} = FakeLag.record(acc, 64, @t0 + i * 3_000)
          acc
        end)

      {_, sample} = FakeLag.record(state, 64, @t0 + 500 * 3_000)

      assert sample.bank_model_s == 2.0
    end

    test "a sustained burst runs the MODEL past the gate — a known divergence" do
      # The model advances the bank when WE write; bahamut advances it
      # when IT parses, and past the gate it stops parsing, so the real
      # bank saturates near the ceiling while ours keeps climbing. A
      # modelled bank far above 10 therefore reads as "we wrote much more
      # than the server could drain", NOT as a literal server-side figure.
      state =
        Enum.reduce(0..99, FakeLag.new(), fn i, acc ->
          {acc, _} = FakeLag.record(acc, 64, @t0 + i * 100)
          acc
        end)

      {_, sample} = FakeLag.record(state, 64, @t0 + 10_000)

      assert sample.bank_model_s > 100.0
    end
  end

  describe "record/3 — the observed 10s window" do
    test "counts the command being recorded" do
      {_, sample} = FakeLag.record(FakeLag.new(), 64, @t0)

      assert sample.commands_10s == 1
      assert sample.penalty_10s_s == 2.0
    end

    test "keeps a command that is exactly ten seconds old" do
      {after_first, _} = FakeLag.record(FakeLag.new(), 64, @t0)
      {_, sample} = FakeLag.record(after_first, 64, @t0 + 10_000)

      assert sample.commands_10s == 2
      assert sample.penalty_10s_s == 4.0
    end

    test "drops a command that has aged out of the window" do
      {after_first, _} = FakeLag.record(FakeLag.new(), 64, @t0)
      {_, sample} = FakeLag.record(after_first, 64, @t0 + 10_001)

      assert sample.commands_10s == 1
      assert sample.penalty_10s_s == 2.0
    end

    test "the window does not grow without bound as an idle connection ticks" do
      state =
        Enum.reduce(0..200, FakeLag.new(), fn i, acc ->
          {acc, _} = FakeLag.record(acc, 64, @t0 + i * 1_000)
          acc
        end)

      {_, sample} = FakeLag.record(state, 64, @t0 + 201_000)

      assert sample.commands_10s == 11
    end
  end

  # issue 2430 — the three readings `Grappa.Session.E2ePacer` paces against,
  # through `Grappa.IRC.Client`.
  describe "bank_ms/2, cost_ms/1, ceiling_ms/0 — what E2E pacing reads" do
    test "a connection that has sent nothing owes nothing" do
      assert FakeLag.bank_ms(FakeLag.new(), @t0) == 0
    end

    test "the bank is the debt left at the reading, and drains to zero, never below" do
      {state, _} = FakeLag.record(FakeLag.new(), 400, @t0)

      assert FakeLag.bank_ms(state, @t0) == 5_000
      assert FakeLag.bank_ms(state, @t0 + 1_500) == 3_500
      assert FakeLag.bank_ms(state, @t0 + 60_000) == 0
    end

    test "cost is the record/3 arithmetic, in ms" do
      assert FakeLag.cost_ms(119) == 2_000
      assert FakeLag.cost_ms(120) == 3_000
      assert FakeLag.cost_ms(404) == 5_000
    end

    test "the ceiling is the drain gate the samples measure headroom from" do
      {_, sample} = FakeLag.record(FakeLag.new(), 64, @t0)
      assert FakeLag.ceiling_ms() == round(sample.ceiling_s * 1_000)
    end
  end
end
