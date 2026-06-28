defmodule GrappaWeb.DirectoryController do
  @moduledoc """
  Channel-directory discovery surface for the per-(subject, network)
  session (#84).

  Two endpoints under the `:resolve_network` scope, so cross-user iso
  (missing credential / wrong slug → uniform 404) is enforced upstream
  by `GrappaWeb.Plugs.ResolveNetwork` before either action runs:

    * `GET /networks/:network_id/directory` — server-side
      sort/search/keyset-page over the last finalized `LIST` snapshot
      (`Grappa.ChannelDirectory.list/3`), rendered through
      `ChannelDirectory.Wire.index_payload/2` (each row carries a
      `featured` flag derived from the network's current
      `network_featured_channels` set). When there's no snapshot
      yet AND a live session exists, kicks off the first refresh so the
      next poll fills.
    * `POST /networks/:network_id/directory/refresh` — arms a fresh
      upstream `LIST` via `Grappa.Session.refresh_directory/2`. Both a
      started refresh (`:ok`) and an in-flight one
      (`{:error, :already_refreshing}`) answer `202 {}`; only a missing
      live session (`{:error, :not_connected}`) surfaces an error,
      mapped by `FallbackController` to 400.
  """
  use GrappaWeb, :controller

  alias Grappa.{ChannelDirectory, Session}
  alias Grappa.ChannelDirectory.Wire
  alias Grappa.Networks.FeaturedChannels
  alias GrappaWeb.Subject

  @doc """
  `GET /networks/:network_id/directory?sort=&q=&cursor=&limit=` —
  renders a keyset-paged page of the last finalized `LIST` snapshot.
  Auto-arms the first refresh when the snapshot is `:empty` and a live
  session exists (result discarded — no session / already running are
  both fine here).
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, params) do
    network = conn.assigns.network
    subject = Subject.to_session(conn.assigns.current_subject)

    opts = [
      ttl_ms: ChannelDirectory.ttl_ms(),
      sort: parse_sort(params["sort"]),
      q: string_param(params, "q"),
      cursor: string_param(params, "cursor"),
      limit: parse_limit(params["limit"])
    ]

    page = ChannelDirectory.list(subject, network.id, opts)

    if page.status == :empty, do: maybe_auto_refresh(subject, network.id)

    # #85 — re-derive the featured flag from CURRENT config on every
    # fetch (on-display freshness; operator edits show up next poll).
    featured_names = FeaturedChannels.featured_name_set(network)
    json(conn, Wire.index_payload(page, featured_names))
  end

  @doc """
  `POST /networks/:network_id/directory/refresh` — arms a fresh
  upstream `LIST`. `:ok` (started) and `{:error, :already_refreshing}`
  (in-flight) both answer `202 {}`; `{:error, :not_connected}` falls
  through to `FallbackController` (400).
  """
  @spec refresh(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_connected}
  def refresh(conn, _) do
    network = conn.assigns.network
    subject = Subject.to_session(conn.assigns.current_subject)

    case Session.refresh_directory(subject, network.id) do
      result when result in [:ok, {:error, :already_refreshing}] ->
        conn |> put_status(:accepted) |> json(%{})

      {:error, :not_connected} = err ->
        err
    end
  end

  # First-poll bootstrap: no snapshot + live session → arm the refresh
  # so the next GET fills. Result is intentionally discarded — no
  # session ({:error, :not_connected}) or already running
  # ({:error, :already_refreshing}) are both expected no-ops here.
  @spec maybe_auto_refresh(Session.subject(), integer()) :: :ok
  defp maybe_auto_refresh(subject, network_id) do
    _ = Session.refresh_directory(subject, network_id)
    :ok
  end

  @spec parse_sort(term()) :: :name | :users
  defp parse_sort("name"), do: :name
  defp parse_sort(_), do: :users

  # Plug can deliver list-valued params (?q[]=x); the context contract is
  # String.t() | nil, so collapse any non-binary to nil at the boundary.
  @spec string_param(map(), String.t()) :: String.t() | nil
  defp string_param(params, key) do
    case params[key] do
      v when is_binary(v) -> v
      _ -> nil
    end
  end

  @spec parse_limit(term()) :: 1..500
  defp parse_limit(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} when n > 0 and n <= 500 -> n
      _ -> 100
    end
  end

  defp parse_limit(_), do: 100
end
