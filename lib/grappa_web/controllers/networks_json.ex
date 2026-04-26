defmodule GrappaWeb.NetworksJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.NetworksController`. Delegates the
  network → JSON shape to `Grappa.Networks.Wire.network_to_json/1` so
  the serializer rules live in one module — see `Grappa.Networks.Wire`
  moduledoc.
  """
  alias Grappa.Networks.{Network, Wire}

  @doc "Renders the `:index` action — flat JSON array of network maps."
  @spec index(%{networks: [Network.t()]}) :: [Wire.network_json()]
  def index(%{networks: networks}), do: Enum.map(networks, &Wire.network_to_json/1)
end
