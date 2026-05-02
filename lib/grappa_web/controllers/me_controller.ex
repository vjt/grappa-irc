defmodule GrappaWeb.MeController do
  @moduledoc """
  `GET /me` — returns the authenticated subject's public profile as a
  discriminated union mirroring `GrappaWeb.AuthJSON.subject_wire`:

    * user    → `{kind: "user", id, name, inserted_at}`
    * visitor → `{kind: "visitor", id, nick, network_slug, expires_at}`

  Lives behind `:authn`; missing / invalid / revoked / expired Bearer
  all collapse to a uniform 401 via `GrappaWeb.Plugs.Authn`.

  Reads `:current_subject` (assigned by `Plugs.Authn` for both kinds)
  and dispatches to the matching `MeJSON.show/1` clause. The plug
  performs the subject load once per request so this controller does
  no DB work (S42).
  """
  use GrappaWeb, :controller

  @doc "`GET /me` — discriminated profile for the bearer's subject."
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    case conn.assigns.current_subject do
      {:user, _} -> render(conn, :show, user: conn.assigns.current_user)
      {:visitor, _} -> render(conn, :show, visitor: conn.assigns.current_visitor)
    end
  end
end
