defmodule Grappa.Session.BackoffTest do
  @moduledoc """
  Per-(subject, network_id) exponential backoff state. Tests cover:

    * `compute_wait/1` math — base × 2^(count-1) capped, with ±25%
      jitter window. Pinned within the expected window per count.
    * Failure bump → `wait_ms/2` returns the curve-driven value.
    * Success clears the entry → `wait_ms/2` returns 0.
    * ETS survives `Session.Server` crashes (simulated by spawning a
      caller process, recording failure, killing it, reading back).

  `async: false` because the Backoff GenServer + ETS table is a
  module-singleton (named-table), shared across the whole suite.
  Tests serialize on it.
  """
  use ExUnit.Case, async: false

  alias Grappa.Session.Backoff

  setup do
    # Fresh table state per test — clear all entries.
    for {key, _, _} <- Backoff.entries(), do: :ets.delete(:session_backoff_state, key)
    :ok
  end

  describe "compute_wait/1" do
    test "0 for fresh / cleared entry" do
      assert Backoff.compute_wait(0) == 0
    end

    test "count=1 lands within ±25% of base_ms" do
      base = Backoff.base_ms()
      jitter = trunc(base * 0.25)

      for _ <- 1..50 do
        ms = Backoff.compute_wait(1)
        assert ms >= base - jitter
        assert ms <= base + jitter
      end
    end

    test "count=2 lands within ±25% of 2 × base_ms" do
      target = Backoff.base_ms() * 2
      jitter = trunc(target * 0.25)

      for _ <- 1..50 do
        ms = Backoff.compute_wait(2)
        assert ms >= target - jitter
        assert ms <= target + jitter
      end
    end

    test "high count caps at cap_ms (±jitter)" do
      cap = Backoff.cap_ms()
      jitter = trunc(cap * 0.25)

      for _ <- 1..50 do
        # 30 iterations of doubling 5s = ~5e9 ms — definitely past the
        # cap. Pin that we don't return that or overflow.
        ms = Backoff.compute_wait(30)
        assert ms >= cap - jitter
        assert ms <= cap + jitter
      end
    end
  end

  describe "wait_ms/2" do
    test "fresh key returns 0" do
      assert Backoff.wait_ms({:user, "u1"}, 1) == 0
    end

    test "after one failure, returns count=1 window" do
      :ok = Backoff.record_failure({:user, "u1"}, 1)
      # Cast — wait for the GenServer to process.
      _ = :sys.get_state(Backoff)

      base = Backoff.base_ms()
      jitter = trunc(base * 0.25)
      ms = Backoff.wait_ms({:user, "u1"}, 1)
      assert ms >= base - jitter
      assert ms <= base + jitter
    end

    test "consecutive failures stack (count grows)" do
      key_subject = {:visitor, "v1"}

      for _ <- 1..3 do
        :ok = Backoff.record_failure(key_subject, 7)
      end

      _ = :sys.get_state(Backoff)
      assert Backoff.failure_count(key_subject, 7) == 3
    end

    test "isolation across (subject, network_id) keys" do
      :ok = Backoff.record_failure({:user, "u1"}, 1)
      :ok = Backoff.record_failure({:user, "u1"}, 1)
      :ok = Backoff.record_failure({:visitor, "v1"}, 1)
      _ = :sys.get_state(Backoff)

      assert Backoff.failure_count({:user, "u1"}, 1) == 2
      assert Backoff.failure_count({:visitor, "v1"}, 1) == 1
      # Different network — separate entry.
      assert Backoff.failure_count({:user, "u1"}, 99) == 0
    end
  end

  describe "record_success/2" do
    test "clears the entry — wait_ms returns 0 again" do
      :ok = Backoff.record_failure({:user, "u1"}, 1)
      :ok = Backoff.record_failure({:user, "u1"}, 1)
      _ = :sys.get_state(Backoff)
      assert Backoff.failure_count({:user, "u1"}, 1) == 2

      :ok = Backoff.record_success({:user, "u1"}, 1)
      _ = :sys.get_state(Backoff)
      assert Backoff.failure_count({:user, "u1"}, 1) == 0
      assert Backoff.wait_ms({:user, "u1"}, 1) == 0
    end

    test "success on missing key is a no-op" do
      :ok = Backoff.record_success({:user, "missing"}, 1)
      _ = :sys.get_state(Backoff)
      assert Backoff.failure_count({:user, "missing"}, 1) == 0
    end
  end

  describe "reset/2" do
    test "clears state for explicit (subject, network)" do
      :ok = Backoff.record_failure({:visitor, "v1"}, 7)
      :ok = Backoff.record_failure({:visitor, "v1"}, 7)
      _ = :sys.get_state(Backoff)

      assert Backoff.failure_count({:visitor, "v1"}, 7) == 2

      :ok = Backoff.reset({:visitor, "v1"}, 7)
      _ = :sys.get_state(Backoff)

      assert Backoff.failure_count({:visitor, "v1"}, 7) == 0
      assert Backoff.wait_ms({:visitor, "v1"}, 7) == 0
    end

    test "is no-op for fresh key" do
      :ok = Backoff.reset({:visitor, "fresh"}, 99)
      _ = :sys.get_state(Backoff)
      assert Backoff.failure_count({:visitor, "fresh"}, 99) == 0
    end
  end

  describe "ETS persistence across caller crashes" do
    test "failure recorded by a now-dead caller is still queryable" do
      key_subject = {:visitor, "ephemeral"}

      caller =
        spawn(fn ->
          :ok = Backoff.record_failure(key_subject, 42)
        end)

      # Wait for the spawned process to issue the cast and exit.
      ref = Process.monitor(caller)
      assert_receive {:DOWN, ^ref, :process, ^caller, _}

      # Force the GenServer to flush its mailbox.
      _ = :sys.get_state(Backoff)

      assert Backoff.failure_count(key_subject, 42) == 1
    end
  end
end
