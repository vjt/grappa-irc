defmodule GrappaWeb.Admin.VisitorsController do
  @moduledoc """
  Admin verbs over the visitor namespace. Behind the `:admin_authn`
  pipeline; visitor + non-admin user collapse to 403 upstream.

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

  alias Grappa.Operator

  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def delete(conn, %{"id" => id}) when is_binary(id) do
    with :ok <- Operator.delete_visitor(id) do
      send_resp(conn, :no_content, "")
    end
  end
end
