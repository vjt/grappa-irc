defmodule GrappaWeb.FeaturedController do
  @moduledoc """
  Public per-network featured-channels read (GH #85). One endpoint under
  the `:resolve_network` scope, so cross-user iso (missing credential /
  wrong slug → uniform 404) is enforced upstream by
  `GrappaWeb.Plugs.ResolveNetwork`:

    * `GET /networks/:network_id/featured` — enabled featured channels
      for the network, ordered by position, rendered through
      `FeaturedChannels.Wire.index_payload/1`.

  Delivery is on-display read (not a `/me` snapshot): operator config
  edits reach users on the next HomePane render without a login
  round-trip or PubSub push. Same shape for users and visitors — the
  data is network-level, resolved by the network the subject is on.
  """
  use GrappaWeb, :controller

  alias Grappa.Networks.FeaturedChannels
  alias Grappa.Networks.FeaturedChannels.Wire

  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _params) do
    network = conn.assigns.network
    json(conn, Wire.index_payload(FeaturedChannels.list_links(network)))
  end
end
