defmodule GrappaWeb.MembersController do
  @moduledoc """
  Per-channel nick-list snapshot for cicchetto's right-pane Members
  sidebar (P4-1). Source-of-truth is `Grappa.Session.list_members/3`
  — the live `Session.Server.state.members` map, populated by
  `Grappa.Session.EventRouter` from upstream JOIN/353/PART/QUIT/etc.

  Snapshot endpoint, not subscription. Cicchetto refetches on
  channel-select; presence updates flow through the existing
  `MessagesChannel` PubSub events (cicchetto applies the delta to
  its local nick-list state).

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 BEFORE this action runs. The
  `:no_session` tag from `Session.list_members/3` collapses to the
  same 404 wire body via `FallbackController` (CP10 S14 oracle close).
  """
  use GrappaWeb, :controller

  alias Grappa.Session

  @doc """
  `GET /networks/:network_id/channels/:channel_id/members` —
  returns the per-channel member snapshot in mIRC sort order
  (`@` ops alphabetical → `+` voiced alphabetical → plain alphabetical).
  Wraps `Grappa.Session.list_members/3`. Snapshot, not subscription —
  presence updates flow through `MessagesChannel` PubSub.

  Unknown slug, no credential, or wrong-user network all collapse to
  404 `not_found` via `Plugs.ResolveNetwork`. `:no_session` (registered
  user but session not running) also collapses to 404 via
  `FallbackController`'s `:no_session` clause (S14 oracle close).
  """
  @spec index(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :no_session}
  def index(conn, %{"channel_id" => channel}) do
    user_id = conn.assigns.current_user_id
    network = conn.assigns.network

    case Session.list_members({:user, user_id}, network.id, channel) do
      {:ok, members} ->
        render(conn, :index, members: members)

      {:error, :no_session} = err ->
        err
    end
  end
end
