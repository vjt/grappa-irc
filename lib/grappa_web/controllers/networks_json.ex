defmodule GrappaWeb.NetworksJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.NetworksController`. Delegates the
  network → JSON shape to `Grappa.Networks.Wire` so the serializer rules
  live in one module — see `Grappa.Networks.Wire` moduledoc.

  `GET /networks` returns two shapes depending on the caller's subject:
  - User: `network_with_nick_json` — includes the per-network IRC nick from
    the credential. Cicchetto needs this to subscribe to the correct DM
    topic (`channel:<nick>`) and to correctly skip own-nick in the
    query-windows loop. Without it, when `user.name` matches a query
    window's `targetNick`, the join was incorrectly skipped.
  - Visitor: `network_json` — no credential row, nick is absent.
  """
  alias Grappa.Networks.{Credential, Network, Wire}

  @doc """
  Renders the `:index` action — flat JSON array of network maps.

  Accepts a tagged tuple from the controller: `{:user, [{Network.t(), String.t()}]}`
  for user subjects (includes per-credential nick) or `{:visitor, [Network.t()]}` for
  visitor subjects (nick omitted — no credential row).
  """
  @spec index(%{networks: {:user, [{Network.t(), String.t()}]} | {:visitor, [Network.t()]}}) ::
          [Wire.network_with_nick_json()] | [Wire.network_json()]
  def index(%{networks: {:user, network_nicks}}) do
    Enum.map(network_nicks, fn {network, nick} -> Wire.network_with_nick_to_json(network, nick) end)
  end

  def index(%{networks: {:visitor, networks}}) do
    Enum.map(networks, &Wire.network_to_json/1)
  end

  @doc """
  Renders the `:update` action — the updated credential's public JSON
  shape including T32 connection_state fields. The `network` association
  on the credential MUST be preloaded (done by the controller before
  rendering).
  """
  @spec update(%{credential: Credential.t()}) :: Wire.credential_json()
  def update(%{credential: credential}), do: Wire.credential_to_json(credential)
end
