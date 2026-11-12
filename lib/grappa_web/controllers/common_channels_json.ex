defmodule GrappaWeb.CommonChannelsJSON do
  @moduledoc """
  Wire shape: `%{channels: [String.t()]}` — the sorted list of channels
  the caller shares with the queried nick (issue 2449). Delegates to
  `Grappa.Session.Wire.common_channels_index/1` so the envelope is a
  generated wire shape, like `MembersJSON` delegates to
  `Wire.members_index/1`.
  """

  alias Grappa.Session.Wire

  @doc "Render the channels-in-common list."
  @spec index(%{channels: [String.t()]}) :: Wire.common_channels_index_payload()
  def index(%{channels: channels}), do: Wire.common_channels_index(channels)
end
