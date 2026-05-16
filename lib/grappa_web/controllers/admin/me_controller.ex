defmodule GrappaWeb.Admin.MeController do
  @moduledoc """
  `GET /admin/me` — admin-gated echo of the authenticated user.

  Behind the `:admin_authn` pipeline (`GrappaWeb.Admin.AuthPlug`), so
  the request only reaches `index/2` when `current_subject` is
  `{:user, %User{is_admin: true}}` — visitor + non-admin user collapse
  to 403 upstream. The body is the standard `Grappa.Accounts.Wire.user_to_json/1`
  shape (`{id, name, is_admin: true, inserted_at}`) — same single
  source of truth as `GET /me`. No discriminated `kind` here because
  the only subject reaching this controller is a user-and-admin; the
  response shape is monomorphic.

  M-cluster M-2: first endpoint behind the admin pipeline. Every
  subsequent `/admin/*` route inherits the same gate.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts.Wire

  @doc """
  Echo the authenticated admin user. The plug pipeline guarantees
  the subject shape is `{:user, %User{is_admin: true}}`; the
  controller body unwraps and renders via the canonical
  `Grappa.Accounts.Wire.user_to_json/1` shape.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(%{assigns: %{current_subject: {:user, user}}} = conn, _) do
    json(conn, Wire.user_to_json(user))
  end
end
