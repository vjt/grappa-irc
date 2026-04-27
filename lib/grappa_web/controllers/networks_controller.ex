defmodule GrappaWeb.NetworksController do
  @moduledoc """
  `GET /networks` — lists the authenticated user's bound networks.

  Cicchetto (Phase 3 PWA) calls this on app boot to render the
  network → channel tree. Per-user iso is the load-bearing semantic:
  a user only sees networks they have a credential on. Operators
  sharing a deployment do NOT see each other's networks (mirrors the
  scrollback `user_id` partition + the session-key shape).

  Wire shape lives in `Grappa.Networks.Wire.network_to_json/1` —
  single source of truth across REST + future Phoenix Channels +
  IRCv3 listener facade. The view layer (`NetworksJSON`) is a
  one-liner that maps the list through it.
  """
  use GrappaWeb, :controller

  alias Grappa.Networks.Credentials

  @doc "`GET /networks` — list of network metadata for the bearer's user."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    networks =
      conn.assigns.current_user
      |> Credentials.list_credentials_for_user()
      |> Enum.map(& &1.network)

    render(conn, :index, networks: networks)
  end
end
