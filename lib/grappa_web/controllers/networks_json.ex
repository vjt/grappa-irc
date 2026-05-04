defmodule GrappaWeb.NetworksJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.NetworksController`. Delegates the
  network → JSON shape to `Grappa.Networks.Wire.network_to_json/1` (GET
  /networks) and `Grappa.Networks.Wire.credential_to_json/1` (PATCH
  /networks/:id) so the serializer rules live in one module — see
  `Grappa.Networks.Wire` moduledoc.
  """
  alias Grappa.Networks.{Credential, Network, Wire}

  @doc "Renders the `:index` action — flat JSON array of network maps."
  @spec index(%{networks: [Network.t()]}) :: [Wire.network_json()]
  def index(%{networks: networks}), do: Enum.map(networks, &Wire.network_to_json/1)

  @doc """
  Renders the `:update` action — the updated credential's public JSON
  shape including T32 connection_state fields. The `network` association
  on the credential MUST be preloaded (done by the controller before
  rendering).
  """
  @spec update(%{credential: Credential.t()}) :: Wire.credential_json()
  def update(%{credential: credential}), do: Wire.credential_to_json(credential)
end
