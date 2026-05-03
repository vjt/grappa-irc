defmodule Grappa.Admission.TelemetryTest do
  @moduledoc """
  Direct tests for Grappa.Admission.Telemetry emission helpers.

  Each helper must invoke `:telemetry.execute/3` with the documented
  event name, measurements, and metadata shape.

  `async: false` because `:telemetry.attach/4` uses a global handler
  registry; concurrent tests with identical handler IDs race. We use
  `System.unique_integer/0` in IDs, but the shared NetworkCircuit ETS
  singleton still demands serialisation.
  """
  use ExUnit.Case, async: false

  alias Grappa.Admission.Telemetry

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp attach_event(event_name, test_pid) do
    id = "test-#{inspect(event_name)}-#{System.unique_integer([:positive])}"

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

  # ---------------------------------------------------------------------------
  # circuit_open/3
  # ---------------------------------------------------------------------------

  describe "circuit_open/3" do
    test "emits [:grappa, :admission, :circuit, :open] with correct metadata" do
      attach_event([:grappa, :admission, :circuit, :open], self())

      :ok = Telemetry.circuit_open(42, 5, 300_000)

      assert_receive {:telemetry, [:grappa, :admission, :circuit, :open], %{},
                      %{network_id: 42, threshold: 5, cooldown_ms: 300_000}}
    end

    test "measurements map is empty" do
      attach_event([:grappa, :admission, :circuit, :open], self())

      :ok = Telemetry.circuit_open(1, 3, 50)

      assert_receive {:telemetry, [:grappa, :admission, :circuit, :open], measurements, _}
      assert measurements == %{}
    end

    test "returns :ok" do
      assert :ok = Telemetry.circuit_open(1, 5, 300_000)
    end
  end

  # ---------------------------------------------------------------------------
  # circuit_close/2
  # ---------------------------------------------------------------------------

  describe "circuit_close/2 — reason: :success" do
    test "emits [:grappa, :admission, :circuit, :close] with reason :success" do
      attach_event([:grappa, :admission, :circuit, :close], self())

      :ok = Telemetry.circuit_close(42, :success)

      assert_receive {:telemetry, [:grappa, :admission, :circuit, :close], %{}, %{network_id: 42, reason: :success}}
    end

    test "returns :ok" do
      assert :ok = Telemetry.circuit_close(1, :success)
    end
  end

  describe "circuit_close/2 — reason: :cooldown_expired" do
    test "emits [:grappa, :admission, :circuit, :close] with reason :cooldown_expired" do
      attach_event([:grappa, :admission, :circuit, :close], self())

      :ok = Telemetry.circuit_close(99, :cooldown_expired)

      assert_receive {:telemetry, [:grappa, :admission, :circuit, :close], %{},
                      %{network_id: 99, reason: :cooldown_expired}}
    end
  end

  # ---------------------------------------------------------------------------
  # capacity_reject/4
  # ---------------------------------------------------------------------------

  describe "capacity_reject/4" do
    test "emits [:grappa, :admission, :capacity, :reject] with correct metadata" do
      attach_event([:grappa, :admission, :capacity, :reject], self())

      :ok = Telemetry.capacity_reject(:login_fresh, :client_cap_exceeded, 7, "44c2ab8a-cb38-4960-b92a-a7aefb190386")

      assert_receive {:telemetry, [:grappa, :admission, :capacity, :reject], %{},
                      %{
                        flow: :login_fresh,
                        error: :client_cap_exceeded,
                        network_id: 7,
                        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386"
                      }}
    end

    test "accepts nil client_id (bootstrap flows)" do
      attach_event([:grappa, :admission, :capacity, :reject], self())

      :ok = Telemetry.capacity_reject(:bootstrap_user, :network_cap_exceeded, 3, nil)

      assert_receive {:telemetry, [:grappa, :admission, :capacity, :reject], %{},
                      %{flow: :bootstrap_user, error: :network_cap_exceeded, client_id: nil}}
    end

    test "accepts tuple error (circuit-open shape)" do
      attach_event([:grappa, :admission, :capacity, :reject], self())

      :ok =
        Telemetry.capacity_reject(:login_fresh, {:network_circuit_open, 42}, 5, "3b8e0c4d-77f1-4a92-bc01-8e3e5a9c4d2f")

      assert_receive {:telemetry, [:grappa, :admission, :capacity, :reject], %{},
                      %{error: {:network_circuit_open, 42}, network_id: 5}}
    end

    test "returns :ok" do
      assert :ok = Telemetry.capacity_reject(:test, :test_error, 1, nil)
    end
  end
end
