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

  test "GET with no snapshot and no live session reports unknown", %{
    conn: conn,
    network: network
  } do
    resp = conn |> get("/networks/#{network.slug}/directory") |> json_response(200)
    assert resp["status"] == "unknown"
    assert resp["entries"] == []
    assert resp["total"] == 0
    assert resp["captured_at"] == nil
  end

  test "GET serves a snapshot sorted by users", %{
    conn: conn,
    user: user,
    network: network
  } do
    s = {:user, user.id}

    :ok =
      Dir.replace(s, network.id, [
        %{name: "#big", topic: "t", user_count: 99},
        %{name: "#small", topic: "", user_count: 1}
      ])

    resp = conn |> get("/networks/#{network.slug}/directory") |> json_response(200)
    assert resp["status"] == "fresh"
    assert Enum.map(resp["entries"], & &1["name"]) == ["#big", "#small"]
  end

  # Issue 2046 — the wire half of the state that used to read `empty`, and
  # the one the controller must NOT arm a re-capture on. `captured_at` comes
  # back non-null on purpose: the search ran against a real snapshot, and
  # rendering "never" over one is the same class of lie as the skew.
  test "GET with a search that matches nothing reports no_results, stamp included", %{
    conn: conn,
    user: user,
    network: network
  } do
    :ok = Dir.replace({:user, user.id}, network.id, [%{name: "#big", topic: "t", user_count: 9}])

    resp =
      conn |> get("/networks/#{network.slug}/directory?q=zzz-no-such-channel") |> json_response(200)

    assert resp["status"] == "no_results"
    assert resp["total"] == 0
    assert resp["entries"] == []
    assert resp["captured_at"] != nil
  end

  test "#85 — rows carry featured: true for channels in the network's featured set", %{
    conn: conn,
    user: user,
    network: network
  } do
    s = {:user, user.id}

    :ok =
      Dir.replace(s, network.id, [
        %{name: "#feat", topic: "t", user_count: 9},
        %{name: "#plain", topic: "", user_count: 1}
      ])

    # Operator curates "#Feat" (mixed case) — must match the "#feat" row.
    {:ok, _} = Grappa.Networks.FeaturedChannels.add_channel(network, %{name: "#Feat"})

    resp = conn |> get("/networks/#{network.slug}/directory") |> json_response(200)
    by_name = Map.new(resp["entries"], &{&1["name"], &1["featured"]})
    assert by_name["#feat"] == true
    assert by_name["#plain"] == false
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
