defmodule GrappaWeb.FeaturedControllerTest do
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.FeaturedChannels

  setup %{conn: conn} do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    network = network_fixture(slug: "feat-#{System.unique_integer([:positive])}")
    _ = credential_fixture(user, network)
    {:ok, conn: put_bearer(conn, session_fixture(user).id), user: user, network: network}
  end

  test "GET returns enabled links ordered by position", %{conn: conn, network: network} do
    {:ok, _} = FeaturedChannels.add_channel(network, %{name: "#b", description: "B", position: 1})
    {:ok, _} = FeaturedChannels.add_channel(network, %{name: "#a", description: "A", position: 0})
    {:ok, off} = FeaturedChannels.add_channel(network, %{name: "#off", position: 2})
    {:ok, _} = FeaturedChannels.update_channel(off, %{enabled: false})

    body = conn |> get("/networks/#{network.slug}/featured") |> json_response(200)

    assert body["channels"] == [
             %{"name" => "#a", "description" => "A"},
             %{"name" => "#b", "description" => "B"}
           ]
  end

  test "GET returns empty channels when none configured", %{conn: conn, network: network} do
    body = conn |> get("/networks/#{network.slug}/featured") |> json_response(200)
    assert body["channels"] == []
  end

  test "GET on someone else's network 404s (resolve_network iso)", %{conn: conn} do
    other_user = user_fixture(name: "alice-#{System.unique_integer([:positive])}")
    other_net = network_fixture(slug: "alice-#{System.unique_integer([:positive])}")
    _ = credential_fixture(other_user, other_net)

    assert conn |> get("/networks/#{other_net.slug}/featured") |> response(404)
  end
end
