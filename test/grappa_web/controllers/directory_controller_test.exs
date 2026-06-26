defmodule GrappaWeb.DirectoryControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.ChannelDirectory, as: Dir

  setup %{conn: conn} do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    network = network_fixture(slug: "dir-#{System.unique_integer([:positive])}")
    _ = credential_fixture(user, network)
    {:ok, conn: put_bearer(conn, session_fixture(user).id), user: user, network: network}
  end

  test "GET returns empty/refreshing with no snapshot + no live session", %{
    conn: conn,
    network: network
  } do
    resp = conn |> get("/networks/#{network.slug}/directory") |> json_response(200)
    assert resp["status"] in ["empty", "refreshing"]
    assert resp["entries"] == []
    assert resp["total"] == 0
  end

  test "GET serves a finalized snapshot sorted by users", %{
    conn: conn,
    user: user,
    network: network
  } do
    s = {:user, user.id}
    :ok = Dir.replace_start(s, network.id)

    :ok =
      Dir.ingest(s, network.id, [
        %{name: "#big", topic: "t", user_count: 99},
        %{name: "#small", topic: "", user_count: 1}
      ])

    :ok = Dir.finalize(s, network.id)

    resp = conn |> get("/networks/#{network.slug}/directory") |> json_response(200)
    assert resp["status"] == "fresh"
    assert Enum.map(resp["entries"], & &1["name"]) == ["#big", "#small"]
  end

  test "POST refresh without a live session returns a clean error (not 404-silent)", %{
    conn: conn,
    network: network
  } do
    conn = post(conn, "/networks/#{network.slug}/directory/refresh")
    assert conn.status == 400
  end

  test "GET with a list-valued q param does not crash (collapses to no filter)", %{
    conn: conn,
    network: network
  } do
    resp = conn |> get("/networks/#{network.slug}/directory?q[]=x") |> json_response(200)
    assert is_list(resp["entries"])
  end

  test "GET on someone else's network 404s", %{conn: conn} do
    other_user = user_fixture(name: "alice-#{System.unique_integer([:positive])}")
    other_net = network_fixture(slug: "alice-#{System.unique_integer([:positive])}")
    # owned by alice, NOT the test user
    _ = credential_fixture(other_user, other_net)
    assert conn |> get("/networks/#{other_net.slug}/directory") |> response(404)
  end
end
