defmodule GrappaWeb.Admin.NetworksController do
  @moduledoc """
  Admin verbs over the networks namespace (M-cluster M-5). Behind
  the `:admin_authn` pipeline; visitor + non-admin user collapse to
  403 upstream.

  ## GET /admin/networks — operator console list

  Combined DB intent (`Grappa.Networks.list_all/0`) + live circuit
  state (`Grappa.Admission.NetworkCircuit.entries/0`) in one
  payload per MD2's combined-shape pattern. The composition lives
  here (not in `Networks`) to avoid a `Networks → Admission`
  boundary cycle (`Admission` already deps `Networks` for cap
  reads at `check_capacity/1`). `GrappaWeb` boundary deps both —
  this is the cycle-free site.

  Returns `200 OK` with `%{"networks" => [...]}`. Per-row shape
  pinned by `Grappa.Networks.AdminWire` +
  `Grappa.Admission.NetworkCircuit.AdminWire` nested under
  `circuit_state:`. `circuit_state: nil` when no ETS row exists
  (= no failures observed for this network).

  ## PATCH /admin/networks/:slug — edit caps

  Updates the operator-tunable admission caps
  (`max_concurrent_visitor_sessions`, `max_concurrent_user_sessions`,
  `max_per_client`). Three-valued contract per
  `Networks.update_network_caps/2`: `nil` clears the cap (unlimited),
  `0` is degenerate lock-down, `N>0` is the cap itself. Negative
  integers fail validation at the changeset boundary.

  Returns `200 OK` with the updated row in the same shape as a
  single GET row. `404 not_found` on unknown slug;
  `422 validation_failed` on a bad cap value.
  """
  use GrappaWeb, :controller

  alias Grappa.{AdminEvents, Networks}
  alias Grappa.AdminEvents.Wire, as: AdminEventsWire
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.Admission.NetworkCircuit.AdminWire, as: CircuitWire
  alias Grappa.Networks.AdminWire, as: NetworkWire
  alias GrappaWeb.Admin.AuthPlug

  @doc """
  Enumerate every networks row + project its live circuit state.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    now_ms = System.monotonic_time(:millisecond)
    circuit_index = circuit_entries_by_network_id()

    rows =
      for net <- Networks.list_all() do
        net
        |> NetworkWire.network_to_admin_json()
        |> Map.put(
          :circuit_state,
          CircuitWire.entry_to_admin_json(Map.get(circuit_index, net.id), now_ms)
        )
      end

    json(conn, %{networks: rows})
  end

  @doc """
  Edit caps. Body keys are optional; unsupplied fields keep their
  current value (per `Networks.update_network_caps/2`'s contract).
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request | Ecto.Changeset.t()}
  def update(conn, %{"slug" => slug} = params) when is_binary(slug) do
    with {:ok, network} <- Networks.get_network_by_slug(slug),
         {:ok, attrs} <- caps_attrs(params),
         {:ok, updated} <- Networks.update_network_caps(network, attrs) do
      now_ms = System.monotonic_time(:millisecond)
      circuit_entry = find_circuit_entry(updated.id)

      :ok = emit_network_caps_updated(updated, conn)

      body =
        updated
        |> NetworkWire.network_to_admin_json()
        |> Map.put(:circuit_state, CircuitWire.entry_to_admin_json(circuit_entry, now_ms))

      json(conn, body)
    end
  end

  # M-11: emit `:network_caps_updated` admin event with operator
  # attribution after a successful caps update. Actor extraction
  # delegated to `GrappaWeb.Admin.AuthPlug.actor_from_conn/1` —
  # single source for the admin-attribution shape across every
  # `/admin/*` controller.
  defp emit_network_caps_updated(network, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(
      AdminEventsWire.network_caps_updated(
        network.id,
        network.slug,
        network.max_concurrent_visitor_sessions,
        network.max_concurrent_user_sessions,
        network.max_per_client,
        actor_id,
        actor_name
      )
    )
  end

  defp find_circuit_entry(network_id) do
    Enum.find(NetworkCircuit.entries(), fn {id, _, _, _, _} -> id == network_id end)
  end

  defp circuit_entries_by_network_id do
    Map.new(NetworkCircuit.entries(), fn {network_id, _, _, _, _} = entry ->
      {network_id, entry}
    end)
  end

  # Whitelist the three caps; everything else collapses to bad_request.
  # `update_network_caps/2` cares only about
  # `:max_concurrent_visitor_sessions`, `:max_concurrent_user_sessions`,
  # and `:max_per_client` keys; an empty map is a no-op update (valid).
  # Null is a meaningful "clear the cap" value; the changeset rejects
  # negative integers and non-integers, so the FallbackController
  # validation_failed clause carries the field error to the operator.
  defp caps_attrs(params) do
    allowed = [
      "max_concurrent_visitor_sessions",
      "max_concurrent_user_sessions",
      "max_per_client"
    ]

    keys = Map.keys(params) -- ["slug"]
    extra = keys -- allowed

    if extra == [] do
      {:ok, atomize_caps(params, allowed)}
    else
      {:error, :bad_request}
    end
  end

  defp atomize_caps(params, allowed) do
    Enum.reduce(allowed, %{}, fn key, acc ->
      case Map.fetch(params, key) do
        {:ok, v} -> Map.put(acc, String.to_existing_atom(key), v)
        :error -> acc
      end
    end)
  end
end
