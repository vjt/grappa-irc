defmodule GrappaWeb.CommonChannelsJSON do
  @moduledoc """
  Wire shape: `%{channels: [String.t()]}` — the sorted channels the
  caller shares with the queried nick (issue 2449). Already sorted by
  `Grappa.Session.common_channels/3`; this view is pure pass-through.
  Channel names are the members-map keys, i.e. already network-folded
  at ingress.
  """

  @doc "Render the channels-in-common list."
  @spec index(%{channels: [String.t()]}) :: %{channels: [String.t()]}
  def index(%{channels: channels}), do: %{channels: channels}
end
