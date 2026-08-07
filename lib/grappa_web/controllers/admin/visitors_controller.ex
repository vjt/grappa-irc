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

  ## POST /admin/visitors/:id/share-token (#982) — the let-them-back-in verb

  A visitor has no password: the browser session IS the identity. Lose
  the device, wipe the profile, drop the cookie, and the account is
  unreachable — the only operator tool before this was `DELETE`, which
  throws the session away rather than returning it.

  This mints the SAME token `POST /me/share-token` mints, through the
  same `GrappaWeb.ShareToken`, redeemed by the same unchanged
  `POST /auth/share/consume`. The operator hands the resulting link to
  the person who lost access.

  **The capability is abusable by an admin and that was accepted
  deliberately** by the project owner, on the grounds that a
  passwordless identity has no other recovery path (issue #982; the
  reasoning is in `docs/DESIGN_NOTES.md`). What this code owes in
  return is making the abuse VISIBLE, not preventing it: every mint
  records a `:visitor_share_token_minted` admin event naming the
  acting admin, and emits telemetry distinct from the visitor-side
  mint so "did an operator do this?" stays answerable.

  Incognito visitors are refused 403, exactly as the visitor-side mint
  refuses them (#363). Returns `200` + `{token, expires_at}`;
  `403 forbidden` for incognito; `404 not_found` for an unknown id.
  """
  use GrappaWeb, :controller

  alias Grappa.{AdminEvents, Operator, Visitors}
  alias Grappa.AdminEvents.Wire, as: EventsWire
  alias Grappa.Networks.Credentials
  alias Grappa.Visitors.{AdminWire, Visitor}
  alias GrappaWeb.Admin.AuthPlug
  alias GrappaWeb.ShareToken

  @doc """
  List every visitor row joined to its live `Session.Server`
  introspection. `live_state: nil` IS the U-0 honesty signal —
  rows whose DB intent says "active" but BEAM has no pid surface
  here as null so the operator sees the divergence.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    rows =
      for {v, per_network} <- Visitors.list_all_with_live_state(),
          do: AdminWire.visitor_to_admin_json(v, per_network)

    json(conn, %{visitors: rows})
  end

  @doc """
  Unblock verb — synchronously terminate the visitor's
  `Session.Server` (if any) then delete the DB row. Cap slot is
  free by the time `204 No Content` returns.
  """
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def delete(conn, %{"id" => id}) when is_binary(id) do
    with :ok <- Operator.delete_visitor(id, AuthPlug.actor_from_conn(conn)) do
      send_resp(conn, :no_content, "")
    end
  end

  @doc """
  Mint a share link for a visitor who can no longer authenticate as
  themselves (#982). Returns `200` + `{token, expires_at}`; wrapping it
  into `https://<host>/#/share/<token>` stays the client's job, as on
  the visitor-side mint.

  Refuses an incognito visitor with 403 (#363) and an unknown id with
  404, the same 404 the `DELETE` verb returns.
  """
  @spec share_token(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :forbidden}
  def share_token(conn, %{"id" => id}) when is_binary(id) do
    with {:ok, visitor} <- fetch_visitor(id),
         :ok <- refuse_incognito(visitor) do
      {token, expires_at} = ShareToken.mint(visitor.id)
      {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

      # Distinct from the visitor-side `[:grappa, :visitor, :share_token,
      # :minted]` on purpose: folding both into one event would make
      # "was this grant operator-issued?" unanswerable from telemetry.
      :telemetry.execute(
        [:grappa, :admin, :visitor, :share_token, :minted],
        %{count: 1},
        %{visitor_id: visitor.id, actor_user_id: actor_id}
      )

      AdminEvents.record(
        EventsWire.visitor_share_token_minted(
          visitor.id,
          Credentials.representative_visitor_nick(visitor.id),
          actor_id,
          actor_name
        )
      )

      json(conn, %{token: token, expires_at: DateTime.to_iso8601(expires_at)})
    end
  end

  @spec fetch_visitor(Ecto.UUID.t()) :: {:ok, Visitor.t()} | {:error, :not_found}
  defp fetch_visitor(id) do
    case Visitors.get(id) do
      %Visitor{} = visitor -> {:ok, visitor}
      nil -> {:error, :not_found}
    end
  end

  # #363 — an incognito session is deliberately non-portable, and the
  # visitor-side mint closes this door already. Refusing in only ONE of
  # the two doors would undo a product decision through the back
  # entrance, so the gate is repeated per caller rather than assumed.
  @spec refuse_incognito(Visitor.t()) :: :ok | {:error, :forbidden}
  defp refuse_incognito(%Visitor{incognito: true}), do: {:error, :forbidden}
  defp refuse_incognito(%Visitor{}), do: :ok
end
