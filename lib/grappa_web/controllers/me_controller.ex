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
  no DB work (S42). M-web-1: the loaded struct lives inside the
  `:current_subject` tagged tuple — no parallel `:current_user` /
  `:current_visitor` assigns to drift.
  """
  use GrappaWeb, :controller

  @doc """
  `GET /me` — discriminated profile for the bearer's subject + the
  per-(network, channel) read cursor envelope (CP29 R-3).

  W8: defensive fall-through clause guards against a regressed pipeline
  (`/me` mounted outside `:authn`, or a future subject kind added without
  updating this controller). With the fall-through the failure mode is a
  uniform 401 via `FallbackController`, not a `KeyError` 500.

  ## Read cursor envelope

  The response carries `read_cursors: %{network_slug => %{channel =>
  id}}` (per plan O1: nested by network) so cic doesn't need a
  per-window REST round-trip on login. Built from
  `Grappa.ReadCursor.bulk_for_subject/1` — single query bounded by
  ~600 rows in the worst case.

  Empty `%{}` for a fresh subject with no cursors yet — cic treats
  missing keys as "no cursor for this window" and falls back to
  unread-everything semantics until the first POST advances one.
  """
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :unauthorized}
  def show(conn, _) do
    case conn.assigns[:current_subject] do
      {:user, user} ->
        cursors = Grappa.ReadCursor.bulk_for_subject({:user, user.id})
        render(conn, :show, user: user, read_cursors: cursors)

      {:visitor, visitor} ->
        cursors = Grappa.ReadCursor.bulk_for_subject({:visitor, visitor.id})
        render(conn, :show, visitor: visitor, read_cursors: cursors)

      _ ->
        {:error, :unauthorized}
    end
  end
end
