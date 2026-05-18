defmodule GrappaWeb.MeController do
  @moduledoc """
  `GET /me` — returns the authenticated subject's public profile as a
  discriminated union mirroring `GrappaWeb.AuthJSON.subject_wire`:

    * user    → `{kind: "user", id, name, inserted_at, home_data}`
    * visitor → `{kind: "visitor", id, nick, network_slug, expires_at,
      home_data: nil}`

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

  alias Grappa.Networks

  @doc """
  `GET /me` — discriminated profile for the bearer's subject + the
  per-(network, channel) read cursor envelope (CP29 R-3) + the
  `home_data` envelope (UX-4 bucket B).

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

  ## home_data envelope (UX-4 bucket B)

  The response carries `home_data: %{networks: [...]} | nil`. For
  user subjects it lists every credential's `(slug, nick,
  connection_state, ...)` so cic's HomePane can render the networks
  pane without a second REST round-trip; the per-row live nick is
  resolved via `Networks.resolve_network_nick/2` (same lookup
  `GET /networks` uses). For visitor subjects it is `nil` outright —
  visitor home is cic-only help text by design (no server roundtrip,
  per the no-localized-strings-server-side rule).

  Live updates land via the `home_network_state_changed` typed event
  on `Topic.user/1`, co-emitted with `connection_state_changed`
  from `Networks.broadcast_state_change/4`.
  """
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :unauthorized}
  def show(conn, _) do
    case conn.assigns[:current_subject] do
      {:user, user} ->
        cursors = Grappa.ReadCursor.bulk_for_subject({:user, user.id})
        home_data = Networks.home_data_for_user(user)
        render(conn, :show, user: user, read_cursors: cursors, home_data: home_data)

      {:visitor, visitor} ->
        cursors = Grappa.ReadCursor.bulk_for_subject({:visitor, visitor.id})
        render(conn, :show, visitor: visitor, read_cursors: cursors, home_data: nil)

      _ ->
        {:error, :unauthorized}
    end
  end
end
