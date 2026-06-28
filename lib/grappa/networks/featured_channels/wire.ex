defmodule Grappa.Networks.FeaturedChannels.Wire do
  @moduledoc """
  Public delivery wire for featured channels (GH #85) — the
  `GET /networks/:network_id/featured` read consumed by cic's HomePane.

  Codegen-visible (`mix grappa.gen_wire_types`): emits
  `NetworksFeaturedChannelsWireLink` + `NetworksFeaturedChannelsWireIndexPayload`
  into `cicchetto/src/lib/wireTypes.ts`. The cic hand-roll
  (`FeaturedChannelLink`/`FeaturedChannelsResponse` in `api.ts`) is
  pinned to these via `wireTypesAssert.ts`.
  """
  @type link :: %{name: String.t(), description: String.t() | nil}
  @type index_payload :: %{channels: [link()]}

  @doc "Wraps the context's `list_links/1` result as the read envelope."
  @spec index_payload([link()]) :: index_payload()
  def index_payload(links) when is_list(links), do: %{channels: links}
end
