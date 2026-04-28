defmodule GrappaWeb.ChannelsJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.ChannelsController`'s `:index`
  action. Renders the post-A5 channel list — entries are already shaped
  by `ChannelsController.merge_channel_sources/2` to
  `%{name, joined, source}`; this view is a pass-through delegating
  each entry to `Grappa.Networks.Wire.channel_to_json/3`.
  """
  alias Grappa.Networks.Wire

  @doc "Renders the `:index` action — flat JSON array of channel maps."
  @spec index(%{
          channels: [
            %{name: String.t(), joined: boolean(), source: :autojoin | :joined}
          ]
        }) :: [Wire.channel_json()]
  def index(%{channels: channels}) do
    Enum.map(channels, fn %{name: name, joined: joined, source: source} ->
      Wire.channel_to_json(name, joined, source)
    end)
  end
end
