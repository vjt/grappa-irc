defmodule GrappaWeb.Admin.VhostsController do
  @moduledoc """
  #228 — admin REST for the vhost (source-bind) inventory + per-subject
  grants. Behind the `:admin_authn` pipeline; visitor + non-admin user
  collapse to 403 upstream.

  Endpoints:

    * `GET    /admin/vhosts`                      inventory + grants + host candidates
    * `POST   /admin/vhosts`                      create a vhost
    * `PATCH  /admin/vhosts/:id`                  update availability flags / address
    * `DELETE /admin/vhosts/:id`                  delete (grants cascade)
    * `POST   /admin/vhosts/:id/grants`           grant / pin to a subject
    * `DELETE /admin/vhosts/grants/:grant_id`     revoke a grant

  A grant body carries `subject_type` (`"user"` | `"visitor"`),
  `subject_id`, and optional `pinned`. `pinned: true` routes through
  `Vhosts.pin_vhost/2` (enforces the one-pin-per-subject rule); otherwise
  `grant_vhost/3` adds a curated-availability grant.

  No audit events (mirror of `FeaturedChannelsController` — a
  curated-inventory resource, not a security-state transition).

  ## DB-driven pool re-sync

  After a create/update/delete that could change the `in_pool` set, the
  effective `OutboundV6Pool` is re-applied so a hot inventory edit takes
  effect on the next connect without a restart.
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, OutboundV6Pool, Vhosts, Visitors}
  alias Grappa.Vhosts.AdminWire
  alias GrappaWeb.Validation

  @doc """
  Lists the vhost inventory (each with its grants) plus the host's
  candidate addresses (`:inet.getifaddrs/0`) the operator can curate
  from. `200 OK`.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _params) do
    vhosts = Enum.map(Vhosts.list_vhosts(), &AdminWire.vhost_to_admin_json/1)
    grants = Enum.map(Vhosts.list_grants(), &AdminWire.grant_to_admin_json/1)

    json(conn, %{
      vhosts: vhosts,
      grants: grants,
      host_candidates: Grappa.Net.HostAddresses.list()
    })
  end

  @doc "Create a vhost. Body: `address` (required), `in_pool?`, `generally_available?`."
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :already_exists | :bad_request | Ecto.Changeset.t()}
  def create(conn, params) do
    with {:ok, attrs} <- vhost_attrs(params),
         {:ok, vhost} <- Vhosts.create_vhost(attrs) do
      :ok = resync_pool()

      conn
      |> put_status(:created)
      |> json(AdminWire.vhost_to_admin_json(vhost))
    end
  end

  @doc "Update a vhost's address / availability flags."
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :not_found | :already_exists | :bad_request | Ecto.Changeset.t()}
  def update(conn, %{"id" => id} = params) do
    with {:ok, parsed_id} <- parse_id(id),
         {:ok, vhost} <- Vhosts.get_vhost(parsed_id),
         {:ok, attrs} <- vhost_attrs(Map.delete(params, "id")),
         {:ok, updated} <- Vhosts.update_vhost(vhost, attrs) do
      :ok = resync_pool()
      json(conn, AdminWire.vhost_to_admin_json(updated))
    end
  end

  @doc "Delete a vhost. Grants cascade; pool re-synced."
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def delete(conn, %{"id" => id}) do
    with {:ok, parsed_id} <- parse_id(id),
         {:ok, vhost} <- Vhosts.get_vhost(parsed_id),
         :ok <- Vhosts.delete_vhost(vhost) do
      :ok = resync_pool()

      conn
      |> put_status(:no_content)
      |> text("")
    end
  end

  @doc """
  Grant / pin a vhost to a subject. Body: `subject_type`, `subject_id`,
  `pinned?`. `201 Created` + the grant JSON.
  """
  @spec grant(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :not_found | :already_exists | :bad_request | Ecto.Changeset.t()}
  def grant(conn, %{"id" => id} = params) do
    with {:ok, parsed_id} <- parse_id(id),
         {:ok, vhost} <- Vhosts.get_vhost(parsed_id),
         {:ok, subject} <- resolve_subject(params),
         pinned = params["pinned"] == true,
         {:ok, grant} <- do_grant(vhost, subject, pinned) do
      json(conn |> put_status(:created), AdminWire.grant_to_admin_json(grant))
    end
  end

  @doc "Revoke a grant by id. `204 No Content` (idempotent)."
  @spec revoke(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def revoke(conn, %{"grant_id" => id}) do
    with {:ok, parsed_id} <- parse_id(id),
         {:ok, grant} <- Vhosts.get_grant_by_id(parsed_id),
         :ok <- Vhosts.revoke_grant(grant) do
      conn
      |> put_status(:no_content)
      |> text("")
    end
  end

  # `pin_vhost/2` enforces one-pin-per-subject; `grant_vhost/3` adds a
  # curated-availability grant. pin returns {:ok, grant} | {:error, cs}.
  defp do_grant(vhost, subject, true), do: Vhosts.pin_vhost(vhost, subject)
  defp do_grant(vhost, subject, false), do: Vhosts.grant_vhost(vhost, subject, pinned: false)

  # Resolve + existence-check the (subject_type, subject_id) grant body.
  defp resolve_subject(%{"subject_type" => "user", "subject_id" => id}) when is_binary(id) do
    case Accounts.get_user(id) do
      %Accounts.User{} -> {:ok, {:user, id}}
      nil -> {:error, :not_found}
    end
  end

  defp resolve_subject(%{"subject_type" => "visitor", "subject_id" => id}) when is_binary(id) do
    case Visitors.get(id) do
      %Visitors.Visitor{} -> {:ok, {:visitor, id}}
      nil -> {:error, :not_found}
    end
  end

  defp resolve_subject(_), do: {:error, :bad_request}

  # Whitelist; reject unknown keys with :bad_request (a typo like
  # `in_pooll: true` must not silently no-op).
  defp vhost_attrs(params) do
    allowed = ["address", "in_pool", "generally_available"]
    extra = Map.keys(params) -- allowed

    if extra == [] do
      {:ok, Validation.take_atomized(params, allowed)}
    else
      {:error, :bad_request}
    end
  end

  defp parse_id(v) when is_binary(v) do
    case Integer.parse(v) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :not_found}
    end
  end

  # Re-apply the effective pool (in_pool vhosts minus per-server fixed
  # sources) after an inventory change so a hot edit takes effect on the
  # next connect. Mirror of Bootstrap.apply_outbound_pool/0's subtraction.
  defp resync_pool do
    fixed = MapSet.new(Grappa.Networks.Servers.list_source_addresses())

    Vhosts.pool_addresses()
    |> Enum.reject(&MapSet.member?(fixed, &1))
    |> OutboundV6Pool.apply_pool()
  end
end
