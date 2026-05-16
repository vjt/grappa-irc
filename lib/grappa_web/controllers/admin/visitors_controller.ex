defmodule GrappaWeb.Admin.VisitorsController do
  @moduledoc """
  Admin verbs over the visitor namespace. Behind the `:admin_authn`
  pipeline; visitor + non-admin user collapse to 403 upstream.

  ## GET /admin/visitors (M-cluster M-4) — operator-console list

  Combined DB intent + live BEAM state per visitor row. Per MD2,
  `live_state: null` IS the U-0 honesty signal — surfaces visitors
  whose DB intent says "active" but whose `Session.Server` isn't
  registered (cluster U-0 swallow class).

  Returns `200 OK` with `%{"visitors" => [...]}`. Wire shape pinned
  by `Grappa.Visitors.AdminWire`.

  ## DELETE /admin/visitors/:id (M-cluster M-3) — the unblock verb

  Synchronous: terminates the visitor's `Session.Server` BEFORE
  deleting the DB row, freeing the `Grappa.SessionRegistry` cap slot
  in the same call. Same orchestration as `bin/grappa delete-visitor`
  (T-3 / CP34) — both routes call into `Grappa.Operator.delete_visitor/1`.
  One feature, one code path, every door.

  Returns `204 No Content` on success; `404 not_found` on unknown id
  (typed via `FallbackController`).
  """
  use GrappaWeb, :controller

  alias Grappa.{Operator, Visitors}
  alias Grappa.Visitors.AdminWire

  @doc """
  List every visitor row joined to its live `Session.Server`
  introspection. `live_state: nil` IS the U-0 honesty signal —
  rows whose DB intent says "active" but BEAM has no pid surface
  here as null so the operator sees the divergence.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    rows =
      for {v, live} <- Visitors.list_all_with_live_state(),
          do: AdminWire.visitor_to_admin_json(v, live)

    json(conn, %{visitors: rows})
  end

  @doc """
  Unblock verb — synchronously terminate the visitor's
  `Session.Server` (if any) then delete the DB row. Cap slot is
  free by the time `204 No Content` returns.
  """
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def delete(conn, %{"id" => id}) when is_binary(id) do
    with :ok <- Operator.delete_visitor(id) do
      send_resp(conn, :no_content, "")
    end
  end
end
