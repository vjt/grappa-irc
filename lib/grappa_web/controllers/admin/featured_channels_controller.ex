defmodule GrappaWeb.Admin.FeaturedChannelsController do
  @moduledoc """
  Admin REST CRUD for `Grappa.Networks.FeaturedChannel` rows scoped
  under their parent network
  (`/admin/networks/:network_id/featured_channels[/:id]`). Behind the
  `:admin_authn` pipeline; visitor + non-admin collapse to 403 upstream.

  Endpoints:

    * `GET    /admin/networks/:network_id/featured_channels`      index
    * `POST   /admin/networks/:network_id/featured_channels`      create
    * `PUT    /admin/networks/:network_id/featured_channels/:id`  update
    * `DELETE /admin/networks/:network_id/featured_channels/:id`  delete

  Mirrors `GrappaWeb.Admin.ServersController`'s parse/fetch/attrs
  helpers, MINUS the live-session awareness + PubSub admin events that
  controller carries: featured config never touches a live
  `Session.Server`, so there is no session count to surface on delete
  and no operator-console state for another admin to miss live. The
  cic admin panel refetches on its own action.
  """
  use GrappaWeb, :controller

  alias Grappa.Networks
  alias Grappa.Networks.FeaturedChannels
  alias Grappa.Networks.FeaturedChannels.AdminWire

  @attrs ["name", "description", "position", "enabled"]

  @doc "Lists a network's featured channels (admin), position-then-id asc."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def index(conn, %{"network_id" => nid}) do
    with {:ok, parsed_nid} <- parse_id(nid),
         {:ok, net} <- fetch_network(parsed_nid) do
      rows =
        net
        |> FeaturedChannels.list_channels()
        |> Enum.map(&AdminWire.featured_channel_to_admin_json/1)

      json(conn, %{featured_channels: rows})
    end
  end

  @doc "Creates a featured channel under `network_id`. Returns `201` + the row."
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :not_found | :already_exists | :bad_request | Ecto.Changeset.t()}
  def create(conn, %{"network_id" => nid} = params) do
    with {:ok, parsed_nid} <- parse_id(nid),
         {:ok, net} <- fetch_network(parsed_nid),
         {:ok, attrs} <- channel_attrs(params),
         {:ok, fc} <- FeaturedChannels.add_channel(net, attrs) do
      conn
      |> put_status(:created)
      |> json(AdminWire.featured_channel_to_admin_json(fc))
    end
  end

  @doc "Updates a featured channel scoped by `(network_id, id)`."
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :not_found | :already_exists | :bad_request | Ecto.Changeset.t()}
  def update(conn, %{"network_id" => nid, "id" => fid} = params) do
    with {:ok, parsed_nid} <- parse_id(nid),
         {:ok, parsed_fid} <- parse_id(fid),
         {:ok, net} <- fetch_network(parsed_nid),
         {:ok, fc} <- FeaturedChannels.get_channel(net, parsed_fid),
         {:ok, attrs} <- channel_attrs(params),
         {:ok, updated} <- FeaturedChannels.update_channel(fc, attrs) do
      json(conn, AdminWire.featured_channel_to_admin_json(updated))
    end
  end

  @doc "Deletes a featured channel scoped by `(network_id, id)`. Returns `200 {}`."
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def delete(conn, %{"network_id" => nid, "id" => fid}) do
    with {:ok, parsed_nid} <- parse_id(nid),
         {:ok, parsed_fid} <- parse_id(fid),
         {:ok, net} <- fetch_network(parsed_nid),
         {:ok, fc} <- FeaturedChannels.get_channel(net, parsed_fid),
         :ok <- FeaturedChannels.delete_channel(fc) do
      json(conn, %{})
    end
  end

  defp parse_id(v) when is_binary(v) do
    case Integer.parse(v) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :not_found}
    end
  end

  defp fetch_network(id) do
    case Networks.get_network(id) do
      %Networks.Network{} = net -> {:ok, net}
      nil -> {:error, :not_found}
    end
  end

  # Whitelist; ignore the URL-derived keys (network_id, id). Reject any
  # other key with `:bad_request` so a typo doesn't silently no-op the
  # field the operator meant to set. Mirrors ServersController.server_attrs/2.
  defp channel_attrs(params) do
    extra = Map.keys(params) -- ["network_id" | ["id" | @attrs]]

    if extra == [] do
      {:ok, take_atomized(params, @attrs)}
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
