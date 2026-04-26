defmodule GrappaWeb.MeController do
  @moduledoc """
  `GET /me` — returns the authenticated user's public profile
  (`{id, name, inserted_at}`). Lives behind `:authn`; missing /
  invalid / revoked / expired Bearer all collapse to a uniform 401
  via `GrappaWeb.Plugs.Authn`.

  `Accounts.get_user!/1` raises on miss — the plug already proved the
  `current_user_id` belongs to a session row whose user_id FK is
  `ON DELETE CASCADE`, so a missing user here is an invariant
  violation worth crashing on.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts

  @doc "`GET /me` — `{id, name, inserted_at}` for the bearer's user."
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    user = Accounts.get_user!(conn.assigns.current_user_id)
    render(conn, :show, user: user)
  end
end
