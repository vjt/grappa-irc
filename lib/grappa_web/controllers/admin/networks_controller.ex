defmodule GrappaWeb.Admin.NetworksController do
  @moduledoc """
  Admin verbs over the networks namespace (M-cluster M-5). Behind
  the `:admin_authn` pipeline; visitor + non-admin user collapse to
  403 upstream.

  ## GET /admin/networks — operator console list

  Combined DB intent (`Grappa.Networks.list_all/0`) + live circuit
  state (`Grappa.Admission.NetworkCircuit.entries/0`) + per-row live-
  session counts split by subject_kind
  (`Grappa.Admission.live_counts_for_network/1`) in one payload per
  MD2's combined-shape pattern. The composition lives here (not in
  `Networks`) to avoid a `Networks → Admission` boundary cycle
  (`Admission` already deps `Networks` for cap reads at
  `check_capacity/1`). `GrappaWeb` boundary deps both — this is the
  cycle-free site.

  Returns `200 OK` with `%{"networks" => [...]}`. Per-row shape
  pinned by `Grappa.Networks.AdminWire` +
  `Grappa.Admission.NetworkCircuit.AdminWire` nested under
  `circuit_state:` + the `t:Grappa.Admission.live_counts/0` type
  nested under `live_counts:`. `circuit_state: nil` when no ETS row
  exists (= no failures observed for this network); `live_counts:
  %{visitors: 0, users: 0}` for networks with no live sessions
  (always present, never `nil` — the Registry count is
  authoritative).

  ## PATCH /admin/networks/:slug — edit network settings

  Updates the operator-tunable admission caps
  (`max_concurrent_visitor_sessions`, `max_concurrent_user_sessions`,
  `max_per_ip`) AND the #211 phase-3 `visitor_enabled` allowlist flag.
  Three-valued contract per cap (`Networks.update_network_settings/2`):
  `nil` clears the cap (unlimited), `0` is degenerate lock-down, `N>0`
  is the cap itself; negative integers fail validation at the changeset
  boundary. `visitor_enabled` is a plain boolean — toggling it opts a
  network in/out of the runtime visitor allowlist WITHOUT a restart
  (login reads `networks.visitor_enabled` at request time). No new
  route + no nginx change: `/admin/networks` is already allowlisted and
  behind `:admin_authn`.

  Returns `200 OK` with the updated row in the same shape as a
  single GET row (including `visitor_enabled` + `live_counts`).
  `404 not_found` on unknown slug; `422 validation_failed` on a bad
  value; `400 bad_request` on an unknown body key.
  """
  use GrappaWeb, :controller

  alias Grappa.{AdminEvents, Networks}
  alias Grappa.AdminEvents.Wire, as: AdminEventsWire
  alias Grappa.Admission
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.Admission.NetworkCircuit.AdminWire, as: CircuitWire
  alias Grappa.Networks.AdminWire, as: NetworkWire
  alias GrappaWeb.Admin.AuthPlug
  alias GrappaWeb.Validation

  @doc """
  Enumerate every networks row + project its live circuit state +
  live-session counts split by subject_kind (U-3 UD4).

  Both projections (circuit + live counts) come from O(1)-per-result
  bulk reads — `NetworkCircuit.entries/0` returns one ETS list, and
  `Admission.live_counts_by_network/0` is a single Registry scan +
  `Enum.frequencies/1` (not 2N scans as the per-row variant would be).
  Per the controller's row-count growth: even at 100 networks the
  index call stays one ETS read + one Registry scan.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    now_ms = System.monotonic_time(:millisecond)
    circuit_index = circuit_entries_by_network_id()
    live_counts_index = Admission.live_counts_by_network()
    zero_counts = %{visitors: 0, users: 0}

    rows =
      for net <- Networks.list_all() do
        net
        |> NetworkWire.network_to_admin_json()
        |> Map.put(
          :circuit_state,
          CircuitWire.entry_to_admin_json(Map.get(circuit_index, net.id), now_ms)
        )
        |> Map.put(:live_counts, Map.get(live_counts_index, net.id, zero_counts))
      end

    json(conn, %{networks: rows})
  end

  @doc """
  Edit network settings — caps + the #211 phase-3 `visitor_enabled`
  allowlist flag. Body keys are optional; unsupplied fields keep their
  current value (per `Networks.update_network_settings/2`'s contract).
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request | Ecto.Changeset.t()}
  def update(conn, %{"slug" => slug} = params) when is_binary(slug) do
    with {:ok, network} <- Networks.get_network_by_slug(slug),
         {:ok, attrs} <- settings_attrs(params),
         {:ok, updated} <- Networks.update_network_settings(network, attrs) do
      now_ms = System.monotonic_time(:millisecond)
      circuit_entry = find_circuit_entry(updated.id)

      :ok = emit_network_settings_updated(updated, conn)

      body =
        updated
        |> NetworkWire.network_to_admin_json()
        |> Map.put(:circuit_state, CircuitWire.entry_to_admin_json(circuit_entry, now_ms))
        |> Map.put(:live_counts, Admission.live_counts_for_network(updated.id))

      json(conn, body)
    end
  end

  # M-11: emit `:network_caps_updated` admin event with operator
  # attribution after a successful settings update. Actor extraction
  # delegated to `GrappaWeb.Admin.AuthPlug.actor_from_conn/1` —
  # single source for the admin-attribution shape across every
  # `/admin/*` controller. #211 phase 3 folds the `visitor_enabled`
  # toggle into this same PATCH; the event reuses the existing
  # `network_caps_updated` shape (no new event kind — the operator
  # audit line already carries network id/slug + actor, and the toggle
  # is a network-settings edit like the caps).
  defp emit_network_settings_updated(network, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(
      AdminEventsWire.network_caps_updated(
        network.id,
        network.slug,
        network.max_concurrent_visitor_sessions,
        network.max_concurrent_user_sessions,
        network.max_per_ip,
        actor_id,
        actor_name
      )
    )
  end

  defp find_circuit_entry(network_id) do
    Enum.find(NetworkCircuit.entries(), fn {id, _, _, _, _} -> id == network_id end)
  end

  @doc """
  Admin-panel bucket 1 — strict-create network. Body whitelist mirrors
  the `Network.changeset/2` cast list (`slug` + the three caps).
  Returns `201 Created` with the new row in the same shape as the
  `index/2` projection (with `circuit_state: nil` and zero
  `live_counts` since there can't be any live sessions yet). Errors:
  `409 already_exists` (duplicate slug), `422 validation_failed` (bad
  slug / negative cap).
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :already_exists | :bad_request | Ecto.Changeset.t()}
  def create(conn, params) do
    with {:ok, attrs} <- create_attrs(params),
         {:ok, net} <- Networks.create_network(attrs) do
      :ok = emit_network_created(net, conn)

      conn
      |> put_status(:created)
      |> json(
        net
        |> NetworkWire.network_to_admin_json()
        |> Map.put(:circuit_state, nil)
        |> Map.put(:live_counts, %{visitors: 0, users: 0})
      )
    end
  end

  @doc """
  Admin-panel bucket 1 — delete network. Refuses via FallbackController
  on `{:credentials_present, N}` (409) or `:scrollback_present` (409);
  unknown id → 404. Returns `204 No Content` on success.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :not_found | :scrollback_present | {:credentials_present, non_neg_integer()}}
  def delete(conn, %{"id" => id}) do
    with {:ok, parsed} <- parse_id(id),
         {:ok, net} <- fetch_network(parsed),
         :ok <- Networks.delete_network(net) do
      :ok = emit_network_deleted(net, conn)
      conn |> put_status(:no_content) |> text("")
    end
  end

  defp emit_network_created(net, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(AdminEventsWire.network_created(net.id, net.slug, actor_id, actor_name))
  end

  defp emit_network_deleted(net, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(AdminEventsWire.network_deleted(net.id, net.slug, actor_id, actor_name))
  end

  # `Plug.Conn` URL params come in as strings; safely parse → `{:error,
  # :not_found}` on a non-integer string rather than letting
  # `String.to_integer/1` raise a 500.
  defp parse_id(id) when is_binary(id) do
    case Integer.parse(id) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :not_found}
    end
  end

  defp fetch_network(id) do
    case Networks.get_network(id) do
      %Grappa.Networks.Network{} = net -> {:ok, net}
      nil -> {:error, :not_found}
    end
  end

  defp create_attrs(params) do
    allowed = [
      "slug",
      "max_concurrent_visitor_sessions",
      "max_concurrent_user_sessions",
      "max_per_ip"
    ]

    extra = Map.keys(params) -- allowed

    if extra == [] do
      {:ok, Validation.take_atomized(params, allowed)}
    else
      {:error, :bad_request}
    end
  end

  defp circuit_entries_by_network_id do
    Map.new(NetworkCircuit.entries(), fn {network_id, _, _, _, _} = entry ->
      {network_id, entry}
    end)
  end

  # Whitelist the three caps; everything else collapses to bad_request.
  # `update_network_settings/2` cares only about
  # `:max_concurrent_visitor_sessions`, `:max_concurrent_user_sessions`,
  # and `:max_per_ip` keys; an empty map is a no-op update (valid).
  # Null is a meaningful "clear the cap" value; the changeset rejects
  # negative integers and non-integers, so the FallbackController
  # validation_failed clause carries the field error to the operator.
  # Whitelist the three caps + the #211 phase-3 `visitor_enabled`
  # toggle; everything else collapses to bad_request.
  # `update_network_settings/2` casts only those keys; an empty map is a
  # no-op update (valid). Null is a meaningful "clear the cap" value for
  # the caps; `visitor_enabled` is a plain boolean. The changeset rejects
  # negative integers / non-integers / non-booleans, so the
  # FallbackController validation_failed clause carries the field error to
  # the operator.
  defp settings_attrs(params) do
    allowed = [
      "visitor_enabled",
      "visitor_autoconnect",
      "max_concurrent_visitor_sessions",
      "max_concurrent_user_sessions",
      "max_per_ip"
    ]

    keys = Map.keys(params) -- ["slug"]
    extra = keys -- allowed

    if extra == [] do
      {:ok, Validation.take_atomized(params, allowed)}
    else
      {:error, :bad_request}
    end
  end
end
