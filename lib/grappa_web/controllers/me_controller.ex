defmodule GrappaWeb.MeController do
  @moduledoc """
  `GET /me` — returns the authenticated user's public profile
  (`{id, name, inserted_at}`). Lives behind `:authn`; missing /
  invalid / revoked / expired Bearer all collapse to a uniform 401
  via `GrappaWeb.Plugs.Authn`.

  Reads the loaded `%User{}` from `conn.assigns.current_user`
  (assigned by `Plugs.Authn`). The plug performs the load once per
  request so this controller does no DB work (S42).
  """
  use GrappaWeb, :controller

  @doc "`GET /me` — `{id, name, inserted_at}` for the bearer's user."
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    render(conn, :show, user: conn.assigns.current_user)
  end
end
