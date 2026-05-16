defmodule GrappaWeb.Admin.CircuitController do
  @moduledoc """
  Admin verb to clear a per-network admission circuit-breaker ETS
  entry (M-cluster M-5). Behind the `:admin_authn` pipeline;
  visitor + non-admin user collapse to 403 upstream.

  Operator-driven recovery from a stuck circuit (e.g. upstream IRC
  net came back online but the cooldown hasn't elapsed). Goes
  through `Grappa.Operator.reset_circuit/1` which verifies the
  network row exists first so an unknown id surfaces as `404
  not_found` instead of a silent ETS no-op on a stale FK.

  Distinct from `NetworkCircuit.record_success/1`: the
  `:operator_reset` telemetry reason fires on every invocation
  regardless of prior state (open, sub-threshold :closed, or no
  entry) so the operator dashboard reflects the explicit verb.

  ## POST /admin/circuit/:network_id/reset

  Path param `:network_id` is an integer FK (per `NetworkCircuit`'s
  ETS key shape). Non-integer collapses to `400 bad_request`.

  Returns `200 OK` + `%{"network_id" => id, "circuit_state" => nil}`
  on success (the reset leaves no ETS row); `404 not_found` on
  unknown id.

  ## Three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix`: operator-facing
  endpoint, admin-gated.
  """
  use GrappaWeb, :controller

  alias Grappa.Admission.NetworkCircuit.AdminWire, as: CircuitWire
  alias Grappa.Operator
  alias GrappaWeb.Admin.AuthPlug

  @doc """
  Reset the circuit for `network_id`. Synchronous: the reset cast
  is drained through the NetworkCircuit GenServer before the
  response is rendered, so the operator sees the post-reset state.
  """
  @spec reset(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request}
  def reset(conn, %{"network_id" => raw}) when is_binary(raw) do
    with {:ok, network_id} <- parse_int(raw),
         {:ok, entry} <- Operator.reset_circuit(network_id, AuthPlug.actor_from_conn(conn)) do
      now_ms = System.monotonic_time(:millisecond)
      json(conn, %{network_id: network_id, circuit_state: CircuitWire.entry_to_admin_json(entry, now_ms)})
    end
  end

  defp parse_int(raw) do
    case Integer.parse(raw) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end
end
