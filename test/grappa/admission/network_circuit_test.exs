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
end
