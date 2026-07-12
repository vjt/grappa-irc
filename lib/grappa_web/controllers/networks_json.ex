defmodule GrappaWeb.NetworksJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.NetworksController`. Delegates the
  network → JSON shape to `Grappa.Networks.Wire` so the serializer rules
  live in one module — see `Grappa.Networks.Wire` moduledoc.

  `GET /networks` returns per-network rows for BOTH subjects (#211 phase
  6 — ruling A, "visitors as equal to users as possible"):
  - User: `network_with_nick_json` (`kind: :user`) — per-network IRC nick
    from the credential + T32 connection-state fields.
  - Visitor: `visitor_network_with_nick_json` (`kind: :visitor`) — the
    twin shape. A visitor is multi-network now (phase 4c accretion), so
    it returns one row per attached network with the per-network nick +
    the (now-real) `connection_state`. Cicchetto needs `:nick` to
    subscribe to the correct DM topic (`channel:<nick>`) and to skip
    own-nick in the query-windows loop — resolved per-network here, no
    longer from the retired singular `me.network_slug`.
  """
  alias Grappa.Networks.{Credential, Network, Wire}

  @doc """
  Renders the `:index` action — flat JSON array of network maps.

  Accepts a tagged tuple from the controller:
  `{:user, [{Network.t(), String.t(), Credential.t()}]}` for user
  subjects OR `{:visitor, [{Network.t(), String.t(), Credential.t()}]}`
  for visitor subjects — both are `{network, nick, credential}` triples
  carrying the per-credential live-nick + T32 connection-state fields;
  only the `:kind` discriminator differs on the wire.
  """
  @spec index(%{
          networks:
            {:user, [{Network.t(), String.t(), Credential.t()}]}
            | {:visitor, [{Network.t(), String.t(), Credential.t()}]}
        }) :: [Wire.network_with_nick_json()] | [Wire.visitor_network_with_nick_json()]
  def index(%{networks: {:user, network_triples}}) do
    Enum.map(network_triples, fn {network, nick, cred} ->
      Wire.network_with_nick_to_json(network, nick, cred)
    end)
  end

  def index(%{networks: {:visitor, network_triples}}) do
    Enum.map(network_triples, fn {network, nick, cred} ->
      Wire.visitor_network_to_json(network, nick, cred)
    end)
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
