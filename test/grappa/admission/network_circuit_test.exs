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
    # NetworkCircuit is supervised by Grappa.Application; just clear
    # state per test.
    for {key, _, _, _, _} <- NetworkCircuit.entries(),
        do: :ets.delete(:admission_network_circuit_state, key)

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

  # ---------------------------------------------------------------------------
  # Telemetry events
  # ---------------------------------------------------------------------------

  defp attach_circuit_event(event_name) do
    id = "nc-test-#{inspect(event_name)}-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach(
        id,
        event_name,
        fn name, measurements, metadata, pid ->
          send(pid, {:telemetry, name, measurements, metadata})
        end,
        test_pid
      )

    on_exit(fn -> :telemetry.detach(id) end)
    id
  end

  describe "telemetry — circuit open transition" do
    test "emits [:grappa, :admission, :circuit, :open] on closed→open transition" do
      attach_circuit_event([:grappa, :admission, :circuit, :open])
      net_id = 1001

      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net_id)
      end

      _ = :sys.get_state(NetworkCircuit)

      assert_receive {:telemetry, [:grappa, :admission, :circuit, :open], %{},
                      %{
                        network_id: ^net_id,
                        threshold: threshold,
                        cooldown_ms: _
                      }},
                     500

      assert threshold == NetworkCircuit.threshold()
    end

    test "does NOT double-emit :open when circuit is already open" do
      attach_circuit_event([:grappa, :admission, :circuit, :open])
      net_id = 1002

      # Open the circuit.
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net_id)
      end

      _ = :sys.get_state(NetworkCircuit)

      # Drain the first (and only) event.
      assert_receive {:telemetry, [:grappa, :admission, :circuit, :open], %{}, %{network_id: ^net_id}},
                     500

      # Additional failures on an already-open circuit must not re-emit.
      :ok = NetworkCircuit.record_failure(net_id)
      _ = :sys.get_state(NetworkCircuit)

      refute_receive {:telemetry, [:grappa, :admission, :circuit, :open], _, _}, 100
    end
  end

  describe "telemetry — circuit close on success" do
    test "emits [:grappa, :admission, :circuit, :close] reason :success when clearing open circuit" do
      attach_circuit_event([:grappa, :admission, :circuit, :close])
      net_id = 1003

      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net_id)
      end

      _ = :sys.get_state(NetworkCircuit)

      :ok = NetworkCircuit.record_success(net_id)
      _ = :sys.get_state(NetworkCircuit)

      assert_receive {:telemetry, [:grappa, :admission, :circuit, :close], %{},
                      %{network_id: ^net_id, reason: :success}},
                     500
    end

    test "does NOT emit :close on success when no prior ETS entry exists (noop delete)" do
      attach_circuit_event([:grappa, :admission, :circuit, :close])
      net_id = 1004

      # No failures — no ETS entry. record_success must be a noop w.r.t. telemetry.
      :ok = NetworkCircuit.record_success(net_id)
      _ = :sys.get_state(NetworkCircuit)

      refute_receive {:telemetry, [:grappa, :admission, :circuit, :close], _, _}, 100
    end
  end

  describe "telemetry — circuit close on cooldown expiry" do
    test "emits [:grappa, :admission, :circuit, :close] reason :cooldown_expired after cooldown" do
      attach_circuit_event([:grappa, :admission, :circuit, :close])
      net_id = 1005

      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net_id)
      end

      _ = :sys.get_state(NetworkCircuit)
      assert {:error, :open, _} = NetworkCircuit.check(net_id)

      # Test config sets cooldown_ms to ~50ms; sleep past it.
      Process.sleep(NetworkCircuit.cooldown_ms() + 30)

      # check/1 observes elapsed cooldown and casts {:cooldown_expire, net_id};
      # the cast lands in the GenServer and emits the event.
      assert NetworkCircuit.check(net_id) == :ok
      _ = :sys.get_state(NetworkCircuit)

      assert_receive {:telemetry, [:grappa, :admission, :circuit, :close], %{},
                      %{network_id: ^net_id, reason: :cooldown_expired}},
                     500
    end

    test "does NOT double-emit :cooldown_expired on repeated check calls after expiry" do
      attach_circuit_event([:grappa, :admission, :circuit, :close])
      net_id = 1006

      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net_id)
      end

      _ = :sys.get_state(NetworkCircuit)

      Process.sleep(NetworkCircuit.cooldown_ms() + 30)

      # First check triggers the cast.
      assert NetworkCircuit.check(net_id) == :ok
      _ = :sys.get_state(NetworkCircuit)

      # Drain the first event.
      assert_receive {:telemetry, [:grappa, :admission, :circuit, :close], %{},
                      %{network_id: ^net_id, reason: :cooldown_expired}},
                     500

      # Second check after ETS entry is gone must NOT re-emit.
      assert NetworkCircuit.check(net_id) == :ok
      _ = :sys.get_state(NetworkCircuit)

      refute_receive {:telemetry, [:grappa, :admission, :circuit, :close], _, _}, 100
    end
  end
end
