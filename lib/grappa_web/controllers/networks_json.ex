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
  alias Grappa.Session

  @typedoc "Wire shape for `GET`/`PUT /networks/:network_id/perform` — see `perform/1`."
  @type perform_response :: %{perform_list: String.t() | nil, oper_pass_set: boolean()}

  @typedoc "Wire shape for the server `PASS` set-ness (GH #1044) — see `server_pass/1`."
  @type server_pass_response :: %{server_pass_set: boolean()}

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
            {:user, [{Network.t(), String.t(), Credential.t(), Session.connection_info() | nil}]}
            | {:visitor, [{Network.t(), String.t(), Credential.t(), Session.connection_info() | nil}]}
        }) :: [Wire.network_with_nick_json()] | [Wire.visitor_network_with_nick_json()]
  def index(%{networks: {:user, network_rows}}) do
    Enum.map(network_rows, fn {network, nick, cred, connection} ->
      Wire.network_with_nick_to_json(network, nick, cred, connection)
    end)
  end

  def index(%{networks: {:visitor, network_rows}}) do
    Enum.map(network_rows, fn {network, nick, cred, connection} ->
      Wire.visitor_network_to_json(network, nick, cred, connection)
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

  @doc """
  Renders the `:perform` action (#189) — the on-connect perform list wire
  shape: the raw list text (nil when unset) + a boolean for whether the
  write-only `$oper_pass` secret is set. Passed straight through from the
  controller's `perform_wire/1`; the secret never reaches here.

  #124 dropped the `nickserv_pass_set` sibling. `$oper_pass` keeps its flag
  because it remains a perform-owned secret; the NickServ one moved to the
  credential password, whose set-ness this surface deliberately does not
  report (see `NetworksController.update_password/2` — the response says
  nothing about the stored secret, not even whether there is one).
  """
  @spec perform(%{perform: %{perform_list: String.t() | nil, oper_pass_set: boolean()}}) ::
          perform_response()
  def perform(%{perform: %{perform_list: perform_list, oper_pass_set: oper_pass_set}}) do
    %{perform_list: perform_list, oper_pass_set: oper_pass_set}
  end

  @doc """
  GH #1044 — the server `PASS` wire shape: set-ness and nothing else. Passed
  straight through from the controller's `server_pass_wire/1`; the secret
  never reaches here, the same write-only posture `oper_pass_set` has above.
  """
  @spec server_pass(%{server_pass: %{server_pass_set: boolean()}}) ::
          server_pass_response()
  def server_pass(%{server_pass: %{server_pass_set: server_pass_set}}) do
    %{server_pass_set: server_pass_set}
  end
end
