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
  alias GrappaWeb.Subject

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

  CP24 bucket E web/S8: `{:ok, :uninitialized}` (joined but pre-NAMES
  burst, OR not joined at all) collapses to HTTP 204 No Content. cic
  shows "loading…". `{:ok, [member()]}` (possibly empty) returns
  HTTP 200 with the JSON envelope. Pre-bucket-E both states
  collapsed to `{members: []}` and cic couldn't tell whether to
  show a spinner or "no members" empty state.
  """
  @spec index(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :no_session}
  def index(conn, %{"channel_id" => channel}) do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    case Session.list_members(subject, network.id, channel) do
      {:ok, :uninitialized} -> send_resp(conn, :no_content, "")
      {:ok, members} -> render(conn, :index, members: members)
      {:error, _} = err -> err
    end
  end
end
