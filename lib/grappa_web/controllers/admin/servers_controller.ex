defmodule GrappaWeb.Admin.ServersController do
  @moduledoc """
  Admin-panel bucket 1 — REST CRUD for `Grappa.Networks.Server` rows
  scoped under their parent network (`/admin/networks/:network_id/servers[/:id]`).
  Behind the `:admin_authn` pipeline (M-2); visitor + non-admin user
  collapse to 403 upstream.

  Endpoints:

    * `POST   /admin/networks/:network_id/servers`         create
    * `PUT    /admin/networks/:network_id/servers/:id`     update
    * `DELETE /admin/networks/:network_id/servers/:id`     delete

  No GET surface: the network's servers list is composed into the
  `GET /admin/networks` payload via `network_with_servers_to_admin_json/1`
  in the parent controller — single source for the operator's "show me
  the networks tree" view, no separate roundtrip per network.

  ## Session lifecycle on delete (A-6)

  `DELETE` leaves any live `Session.Server` alone — `Servers.pick_server!/1`
  is only consulted on (re)connect. Live sockets stay open against
  their current host:port regardless of the DB row. Response body
  surfaces `network_session_count: N` (total live sessions on the
  network) so the operator sees "you removed an endpoint that N
  sessions on this network MIGHT have to fall back from on their next
  reconnect." Per-host count would need a Registry-side probe that
  doesn't exist today; the network-total is honest and bounded.
  """
  use GrappaWeb, :controller

  alias Grappa.{AdminEvents, Admission, Networks}
  alias Grappa.AdminEvents.Wire, as: AdminEventsWire
  alias Grappa.Networks.Servers
  alias Grappa.Networks.Servers.AdminWire, as: ServerWire
  alias GrappaWeb.Admin.AuthPlug

  @doc """
  Create a server endpoint under `network_id`. Body fields: `host`
  (required), `port` (required), `tls?`, `priority?`, `enabled?`.
  Returns `201 Created` + the server JSON shape.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :not_found | :already_exists | :bad_request | Ecto.Changeset.t()}
  def create(conn, %{"network_id" => nid} = params) do
    with {:ok, parsed_nid} <- parse_id(nid),
         {:ok, net} <- fetch_network(parsed_nid),
         {:ok, attrs} <- server_attrs(params, ["host", "port", "tls", "priority", "enabled"]),
         {:ok, server} <- Servers.add_server(net, attrs) do
      :ok = emit_server_event(:added, net, server, conn)

      conn
      |> put_status(:created)
      |> json(ServerWire.server_to_admin_json(server))
    end
  end

  @doc """
  Update a server endpoint. URL parameters scope the row by
  `(network_id, id)` so a server id from another network 404s.
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :not_found | :already_exists | :bad_request | Ecto.Changeset.t()}
  def update(conn, %{"network_id" => nid, "id" => sid} = params) do
    with {:ok, parsed_nid} <- parse_id(nid),
         {:ok, parsed_sid} <- parse_id(sid),
         {:ok, net} <- fetch_network(parsed_nid),
         {:ok, server} <- Servers.get_server(net, parsed_sid),
         {:ok, attrs} <- server_attrs(params, ["host", "port", "tls", "priority", "enabled"]),
         {:ok, updated} <- Servers.update_server(server, attrs) do
      :ok = emit_server_event(:updated, net, updated, conn)
      json(conn, ServerWire.server_to_admin_json(updated))
    end
  end

  @doc """
  Delete a server endpoint. Live sessions on the parent network are
  unaffected (see moduledoc A-6). Response carries
  `network_session_count: N` for operator awareness.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found}
  def delete(conn, %{"network_id" => nid, "id" => sid}) do
    with {:ok, parsed_nid} <- parse_id(nid),
         {:ok, parsed_sid} <- parse_id(sid),
         {:ok, net} <- fetch_network(parsed_nid),
         {:ok, server} <- Servers.get_server(net, parsed_sid),
         :ok <- Servers.delete_server(server) do
      :ok = emit_server_removed(net, server, conn)
      counts = Admission.live_counts_for_network(parsed_nid)
      json(conn, %{network_session_count: counts.visitors + counts.users})
    end
  end

  # Shared add/update emitter — both events carry identical fields
  # (host/port/tls + ids); discriminator is the `op` atom.
  defp emit_server_event(op, net, server, conn) when op in [:added, :updated] do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    event =
      case op do
        :added ->
          AdminEventsWire.server_added(
            net.id,
            net.slug,
            server.id,
            server.host,
            server.port,
            server.tls,
            actor_id,
            actor_name
          )

        :updated ->
          AdminEventsWire.server_updated(
            net.id,
            net.slug,
            server.id,
            server.host,
            server.port,
            server.tls,
            actor_id,
            actor_name
          )
      end

    AdminEvents.record(event)
  end

  defp emit_server_removed(net, server, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(
      AdminEventsWire.server_removed(
        net.id,
        net.slug,
        server.id,
        server.host,
        server.port,
        actor_id,
        actor_name
      )
    )
  end

  defp parse_id(v) when is_binary(v) do
    case Integer.parse(v) do
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

  # Whitelist; ignore the URL-derived keys (network_id, id). Reject any
  # other keys with `:bad_request` so a typo (`tlss: true`) doesn't
  # silently no-op the field the operator meant to set.
  defp server_attrs(params, allowed) do
    extra = Map.keys(params) -- ["network_id" | ["id" | allowed]]

    if extra == [] do
      {:ok, take_atomized(params, allowed)}
    else
      {:error, :bad_request}
    end
  end

  defp take_atomized(params, keys) do
    Enum.reduce(keys, %{}, fn key, acc -> put_if_present(acc, params, key) end)
  end

  defp put_if_present(acc, params, key) do
    case Map.fetch(params, key) do
      {:ok, v} -> Map.put(acc, String.to_existing_atom(key), v)
      :error -> acc
    end
  end
end
