defmodule GrappaWeb.CommonChannelsJSON do
  @moduledoc """
  Wire shape: `%{channels: [String.t()]}` — the sorted list of channels
  the caller shares with the queried nick (issue 2449). Pure
  pass-through of `Grappa.Session.common_channels/3`.
  """

  @doc "Render the channels-in-common list."
  @spec index(%{channels: [String.t()]}) :: %{channels: [String.t()]}
  def index(%{channels: channels}), do: %{channels: channels}
end
