defmodule Grappa.Admission.NetworkCircuitTest do
  @moduledoc """
  Per-network failure circuit-breaker. Threshold + window govern
  open transition; cooldown + jitter govern close transition.

  `async: false` because the GenServer + ETS table is a module
  singleton (named-table) shared across the suite.
  """
  use ExUnit.Case, async: false

  alias Grappa.Admission.NetworkCircuit

  setup do
    start_supervised!(NetworkCircuit)

    on_exit(fn ->
      case :ets.whereis(:admission_network_circuit_state) do
        :undefined -> :ok
        _ -> :ets.delete_all_objects(:admission_network_circuit_state)
      end
    end)

    :ok
  end

  describe "compute_cooldown/2" do
    test "returns cooldown_ms ± 25% jitter window" do
      base = NetworkCircuit.cooldown_ms()
      jitter = trunc(base * 0.25)

      for _ <- 1..50 do
        ms = NetworkCircuit.compute_cooldown(base, 25)
        assert ms >= base - jitter
        assert ms <= base + jitter
      end
    end

    test "0 jitter pct returns exact base" do
      assert NetworkCircuit.compute_cooldown(1_000, 0) == 1_000
    end
  end

  describe "module-level config readers" do
    test "threshold/0 is positive" do
      assert NetworkCircuit.threshold() > 0
    end

    test "window_ms/0 is positive" do
      assert NetworkCircuit.window_ms() > 0
    end

    test "cooldown_ms/0 is positive" do
      assert NetworkCircuit.cooldown_ms() > 0
    end
  end

  describe "record_failure/1 + check/1" do
    test "fresh network reads :closed → check returns :ok" do
      assert NetworkCircuit.check(1) == :ok
    end

    test "single failure stays :closed (under threshold)" do
      :ok = NetworkCircuit.record_failure(1)
      _ = :sys.get_state(NetworkCircuit)
      assert NetworkCircuit.check(1) == :ok
    end

    test "threshold-many failures opens circuit; check returns retry_after" do
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(1)
      end

      _ = :sys.get_state(NetworkCircuit)

      assert {:error, :open, retry_after} = NetworkCircuit.check(1)
      assert retry_after > 0
      assert retry_after <= div(NetworkCircuit.cooldown_ms(), 1_000) + 1
    end

    test "isolated per-network_id" do
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(1)
      end

      _ = :sys.get_state(NetworkCircuit)

      assert {:error, :open, _} = NetworkCircuit.check(1)
      assert NetworkCircuit.check(2) == :ok
    end
  end

  describe "record_success/1" do
    test "clears state mid-window" do
      for _ <- 1..(NetworkCircuit.threshold() - 1) do
        :ok = NetworkCircuit.record_failure(1)
      end

      :ok = NetworkCircuit.record_success(1)
      _ = :sys.get_state(NetworkCircuit)

      assert NetworkCircuit.check(1) == :ok
    end

    test "clears open circuit" do
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(1)
      end

      _ = :sys.get_state(NetworkCircuit)
      assert {:error, :open, _} = NetworkCircuit.check(1)

      :ok = NetworkCircuit.record_success(1)
      _ = :sys.get_state(NetworkCircuit)

      assert NetworkCircuit.check(1) == :ok
    end
  end

  describe "window expiry" do
    test "failures outside window don't carry — count resets" do
      # Configure window_ms to a tiny value via compile_env wouldn't
      # work mid-test; rely on test config's :network_circuit_window_ms
      # being set to ~100ms in config/test.exs (Task 12). Sleep past
      # window, then verify a failure starts a fresh count.
      for _ <- 1..(NetworkCircuit.threshold() - 1) do
        :ok = NetworkCircuit.record_failure(1)
      end

      _ = :sys.get_state(NetworkCircuit)
      assert NetworkCircuit.check(1) == :ok

      Process.sleep(NetworkCircuit.window_ms() + 50)

      :ok = NetworkCircuit.record_failure(1)
      _ = :sys.get_state(NetworkCircuit)

      assert NetworkCircuit.check(1) == :ok
    end
  end

  describe "cooldown expiry" do
    test "open circuit returns to :closed after cooldown_ms" do
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(1)
      end

      _ = :sys.get_state(NetworkCircuit)
      assert {:error, :open, _} = NetworkCircuit.check(1)

      # Test config sets cooldown_ms to ~50ms.
      Process.sleep(NetworkCircuit.cooldown_ms() + 30)

      assert NetworkCircuit.check(1) == :ok
    end
  end
end
