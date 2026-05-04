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
      `{:cooldown_expire, network_id, observed_cooled_at_ms}` cast for
      exactly-once delivery. The trailing `cooled_at_ms` rides as an
      observation token: the handler match-pins it against the current
      ETS row, so a re-open between observation and cast handling
      cleanly no-ops without emitting a bogus :close (H6).

    * `[:grappa, :admission, :capacity, :reject]`
      measurements: `%{}`
      metadata: `%{flow: atom(), error: atom() | tuple(), network_id: integer(), client_id: Grappa.ClientId.t() | nil}`
      Emitted from `Admission.check_capacity/1` on every rejection.
      Distinct concern from `:circuit, :open` — fires on every rejected
      candidate during an open window, not just on the transition.

  Phase 5 PromEx exporter (deferred) will subscribe to these prefixes via
  `:telemetry.attach_many/4` or `TelemetryMetricsPrometheus`.
  """

  @spec circuit_open(integer(), integer(), integer()) :: :ok
  @doc """
  Emits `[:grappa, :admission, :circuit, :open]` on the closed→open
  circuit-breaker transition for `network_id`. The event carries
  `threshold` (failure count that tripped the open) and `cooldown_ms`
  (duration before the breaker auto-closes). PromEx subscriber deferred
  to Phase 5.
  """
  def circuit_open(network_id, threshold, cooldown_ms)
      when is_integer(network_id) and is_integer(threshold) and is_integer(cooldown_ms) do
    :telemetry.execute(
      [:grappa, :admission, :circuit, :open],
      %{},
      %{network_id: network_id, threshold: threshold, cooldown_ms: cooldown_ms}
    )
  end

  @spec circuit_close(integer(), :success | :cooldown_expired) :: :ok
  @doc """
  Emits `[:grappa, :admission, :circuit, :close]` on the open→closed
  circuit-breaker transition. `reason` is `:success` (cleared by a
  successful session handshake) or `:cooldown_expired` (the
  observation-token cooldown passed without a new open).
  """
  def circuit_close(network_id, reason)
      when is_integer(network_id) and reason in [:success, :cooldown_expired] do
    :telemetry.execute(
      [:grappa, :admission, :circuit, :close],
      %{},
      %{network_id: network_id, reason: reason}
    )
  end

  @spec capacity_reject(atom(), term(), integer(), Grappa.ClientId.t() | nil) :: :ok
  @doc """
  Emits `[:grappa, :admission, :capacity, :reject]` on every
  capacity-check rejection. `flow` is the admission flow atom (e.g.
  `:user`, `:visitor`), `error` is the rejection reason atom or tuple,
  `network_id` is the target network FK, and `client_id` is the
  originating client (nil for system flows). Fires per-rejection, not
  just on circuit open — enables per-network rejection-rate dashboards.
  """
  def capacity_reject(flow, error, network_id, client_id)
      when is_atom(flow) and is_integer(network_id) and
             (is_binary(client_id) or is_nil(client_id)) do
    :telemetry.execute(
      [:grappa, :admission, :capacity, :reject],
      %{},
      %{flow: flow, error: error, network_id: network_id, client_id: client_id}
    )
  end
end
