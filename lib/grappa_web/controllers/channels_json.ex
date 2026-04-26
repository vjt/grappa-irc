defmodule GrappaWeb.ChannelsJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.ChannelsController`'s `:index`
  action. Delegates the channel-name → JSON shape to
  `Grappa.Networks.Wire.channel_to_json/1` so the serializer rules
  live in one module.
  """
  alias Grappa.Networks.Wire

  @doc "Renders the `:index` action — flat JSON array of channel maps."
  @spec index(%{channels: [String.t()]}) :: [Wire.channel_json()]
  def index(%{channels: channels}), do: Enum.map(channels, &Wire.channel_to_json/1)
end
