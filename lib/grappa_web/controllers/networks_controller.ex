defmodule GrappaWeb.NetworksController do
  @moduledoc """
  `GET /networks` — lists the authenticated subject's bound networks.

  Cicchetto (Phase 3 PWA) calls this on app boot to render the
  network → channel tree. Two subject branches:

    * **user** — `Credentials.list_credentials_for_user/1` returns
      every credential row the user has bound. Per-user iso is
      load-bearing: a user only sees networks they have a credential
      on.
    * **visitor** — visitors are pinned to one network at row
      creation (`visitor.network_slug`). Returns the single matching
      network row. The slug invariant is enforced by `Bootstrap` at
      boot (a `GRAPPA_VISITOR_NETWORK` rotation hard-errors with
      operator instructions to reap orphans), so the lookup never
      returns `:not_found` in production — but the controller
      collapses to the empty list rather than crashing the request
      to keep the wire shape uniform under the pathological
      orphan-row case.

  Wire shape lives in `Grappa.Networks.Wire.network_to_json/1` —
  single source of truth across REST + future Phoenix Channels +
  IRCv3 listener facade. The view layer (`NetworksJSON`) is a
  one-liner that maps the list through it.
  """
  use GrappaWeb, :controller

  alias Grappa.Networks
  alias Grappa.Networks.Credentials

  @doc "`GET /networks` — list of network metadata for the bearer's subject."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    networks =
      case conn.assigns.current_subject do
        {:user, user} ->
          user
          |> Credentials.list_credentials_for_user()
          |> Enum.map(& &1.network)

        {:visitor, visitor} ->
          case Networks.get_network_by_slug(visitor.network_slug) do
            {:ok, network} -> [network]
            {:error, :not_found} -> []
          end
      end

    render(conn, :index, networks: networks)
  end
end
