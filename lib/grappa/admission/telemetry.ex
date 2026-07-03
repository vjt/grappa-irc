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
      metadata: `%{network_id: integer(), reason: :success | :cooldown_expired | :operator_reset}`
      Emitted once per open→closed transition in `NetworkCircuit`.
      `:success` — cleared by `record_success/1`.
      `:cooldown_expired` — detected by `check/1` and routed as a
      `{:cooldown_expire, network_id, observed_cooled_at_ms}` cast for
      exactly-once delivery. The trailing `cooled_at_ms` rides as an
      observation token: the handler match-pins it against the current
      ETS row, so a re-open between observation and cast handling
      cleanly no-ops without emitting a bogus :close (H6).
      `:operator_reset` — emitted by `reset/1` regardless of prior
      state (open, sub-threshold :closed, or no entry). M-cluster M-5
      operator-driven clear: intent is "I asked, you did it" so every
      reset fires telemetry for operator audit (vs. record_success/1
      which suppresses on a non-transition).

    * `[:grappa, :admission, :capacity, :reject]`
      measurements: `%{}`
      metadata: `%{flow: atom(), error: atom() | tuple(), network_id: integer(), source_ip: String.t() | nil}`
      Emitted from `Admission.check_capacity/1` on every rejection.
      Distinct concern from `:circuit, :open` — fires on every rejected
      candidate during an open window, not just on the transition.
      `source_ip` is the per-(source-IP, network) cap key (#171), so a
      rejection dashboard can attribute clone floods to an origin IP.

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

  @spec circuit_close(integer(), :success | :cooldown_expired | :operator_reset) :: :ok
  @doc """
  Emits `[:grappa, :admission, :circuit, :close]` on the open→closed
  circuit-breaker transition. `reason` is `:success` (cleared by a
  successful session handshake), `:cooldown_expired` (the
  observation-token cooldown passed without a new open), or
  `:operator_reset` (M-5 operator-driven clear via `reset/1`).
  """
  def circuit_close(network_id, reason)
      when is_integer(network_id) and reason in [:success, :cooldown_expired, :operator_reset] do
    :telemetry.execute(
      [:grappa, :admission, :circuit, :close],
      %{},
      %{network_id: network_id, reason: reason}
    )
  end

  @spec capacity_reject(atom(), term(), integer(), String.t() | nil) :: :ok
  @doc """
  Emits `[:grappa, :admission, :capacity, :reject]` on every
  capacity-check rejection. `flow` is the admission flow atom (e.g.
  `:user`, `:visitor`), `error` is the rejection reason atom or tuple,
  `network_id` is the target network FK, and `source_ip` is the
  originating client IP (nil for cold-start system flows). Fires
  per-rejection, not just on circuit open — enables per-network +
  per-IP rejection-rate dashboards.
  """
  def capacity_reject(flow, error, network_id, source_ip)
      when is_atom(flow) and is_integer(network_id) and
             (is_binary(source_ip) or is_nil(source_ip)) do
    :telemetry.execute(
      [:grappa, :admission, :capacity, :reject],
      %{},
      %{flow: flow, error: error, network_id: network_id, source_ip: source_ip}
    )
  end
end
