defmodule Grappa.Admission.Telemetry do
  @moduledoc """
  Telemetry emission helpers for the admission-control subsystem.

  Events:

    * `[:grappa, :admission, :circuit, :open]`
      measurements: `%{}` (no numeric measurements; payload is metadata)
      metadata: `%{network_id: integer(), threshold: integer(), cooldown_ms: integer()}`
      Emitted once per closed→open transition in `NetworkCircuit`.

    * `[:grappa, :admission, :circuit, :close]`
      measurements: `%{}`
      metadata: `%{network_id: integer(), reason: :success | :cooldown_expired}`
      Emitted once per open→closed transition in `NetworkCircuit`.
      `:success` — cleared by `record_success/1`.
      `:cooldown_expired` — detected by `check/1` and routed as a
      `{:cooldown_expire, network_id}` cast for exactly-once delivery.

    * `[:grappa, :admission, :capacity, :reject]`
      measurements: `%{}`
      metadata: `%{flow: atom(), error: atom() | tuple(), network_id: integer(), client_id: String.t() | nil}`
      Emitted from `Admission.check_capacity/1` on every rejection.
      Distinct concern from `:circuit, :open` — fires on every rejected
      candidate during an open window, not just on the transition.

  Phase 5 PromEx exporter (deferred) will subscribe to these prefixes via
  `:telemetry.attach_many/4` or `TelemetryMetricsPrometheus`.
  """

  @spec circuit_open(integer(), integer(), integer()) :: :ok
  def circuit_open(network_id, threshold, cooldown_ms)
      when is_integer(network_id) and is_integer(threshold) and is_integer(cooldown_ms) do
    :telemetry.execute(
      [:grappa, :admission, :circuit, :open],
      %{},
      %{network_id: network_id, threshold: threshold, cooldown_ms: cooldown_ms}
    )
  end

  @spec circuit_close(integer(), :success | :cooldown_expired) :: :ok
  def circuit_close(network_id, reason)
      when is_integer(network_id) and reason in [:success, :cooldown_expired] do
    :telemetry.execute(
      [:grappa, :admission, :circuit, :close],
      %{},
      %{network_id: network_id, reason: reason}
    )
  end

  @spec capacity_reject(atom(), term(), integer(), String.t() | nil) :: :ok
  def capacity_reject(flow, error, network_id, client_id)
      when is_atom(flow) and is_integer(network_id) do
    :telemetry.execute(
      [:grappa, :admission, :capacity, :reject],
      %{},
      %{flow: flow, error: error, network_id: network_id, client_id: client_id}
    )
  end
end
