defmodule GrappaWeb.MessagesControllerTest do
  @moduledoc """
  GET (read) + POST input-validation paths. The POST success path
  needs an active `Grappa.Session.Server` so it lives in
  `messages_controller_outbound_test.exs` (`async: false`).

  `async: false` because the per-test setup writes `users` +
  `networks` rows; with the slug "azzurra" reused across tests, the
  unique-index race under sandbox txs would flake under
  `max_cases: 2`. Cheaper to serialize than to bump busy_timeout
  (already 30s) further.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Networks, ScrollbackHelpers}

  setup %{conn: conn} do
    {user, session} = user_and_session()
    # S14: every `/networks/:slug/...` route now passes through the
    # `ResolveNetwork` plug which requires a credential for
    # (current_user, network). Test setup binds the user to the network
    # so the index/create paths reach the controller action.
    {network, _} = network_with_server(port: 7301, slug: "azzurra")
    _ = credential_fixture(user, network)
    {:ok, conn: put_bearer(conn, session.id), user: user, network: network}
  end

  defp seed(user, network, channel \\ "#sniffo") do
    for i <- 0..4 do
      {:ok, _} =
        ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: channel,
          server_time: i,
          kind: :privmsg,
          sender: "vjt",
          body: "m#{i}"
        })
    end
  end

  test "GET ?limit=3 returns latest page descending with kind round-trip",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=3")
    body = json_response(conn, 200)
    assert length(body) == 3
    assert Enum.at(body, 0)["body"] == "m4"
    assert Enum.at(body, 0)["kind"] == "privmsg"
    assert Enum.at(body, 0)["channel"] == "#sniffo"
    assert Enum.at(body, 0)["network"] == "azzurra"
    refute Map.has_key?(Enum.at(body, 0), "user_id")
    assert Enum.at(body, 2)["body"] == "m2"
  end

  test "GET ?before=3&limit=2 paginates correctly",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=3&limit=2")
    body = json_response(conn, 200)
    assert length(body) == 2
    assert Enum.at(body, 0)["body"] == "m2"
    assert Enum.at(body, 1)["body"] == "m1"
  end

  test "limit defaults to 50 when omitted",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body = json_response(conn, 200)
    assert length(body) == 5
  end

  test "filters by (user_id, network_id, channel) — no leakage across channels, networks, or users",
       %{conn: conn, user: user, network: network} do
    {:ok, other_net} = Networks.find_or_create_network(%{slug: "freenode"})
    other_user = user_fixture(name: "alice-#{System.unique_integer([:positive])}")

    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: "#sniffo",
        server_time: 1,
        kind: :privmsg,
        sender: "vjt",
        body: "target"
      })

    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: "#other",
        server_time: 2,
        kind: :privmsg,
        sender: "vjt",
        body: "wrong-channel"
      })

    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: other_net.id,
        channel: "#sniffo",
        server_time: 3,
        kind: :privmsg,
        sender: "vjt",
        body: "wrong-network"
      })

    # Per-user iso check: same channel + network, different user.
    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: other_user.id,
        network_id: network.id,
        channel: "#sniffo",
        server_time: 4,
        kind: :privmsg,
        sender: "alice",
        body: "wrong-user"
      })

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body = json_response(conn, 200)
    assert length(body) == 1
    assert Enum.at(body, 0)["body"] == "target"
  end

  test "GET on unknown network slug returns 404", %{conn: conn} do
    conn = get(conn, "/networks/no-such-net/channels/%23sniffo/messages")
    assert json_response(conn, 404)["error"] == "not_found"
  end

  # S14 oracle close: a probing user querying scrollback for someone
  # else's network gets the SAME body as querying an unknown slug.
  # Pre-fix this would have returned 200 [] (empty list — also a leak,
  # since the user_id partition silently filtered to no rows).
  test "GET against another user's network returns 404 not_found", %{conn: conn} do
    alice = user_fixture(name: "alice-#{System.unique_integer([:positive])}")
    {alice_network, _} = network_with_server(port: 7302, slug: "alice-only-#{System.unique_integer([:positive])}")
    _ = credential_fixture(alice, alice_network)

    conn = get(conn, "/networks/#{alice_network.slug}/channels/%23sniffo/messages")
    assert json_response(conn, 404)["error"] == "not_found"
  end

  test "?limit=banana returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=banana")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "?limit=0 returns 400 (must be positive)", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=0")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "?before=banana returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=banana")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "GET with malformed channel_id (no sigil) returns 400 (S40)", %{conn: conn} do
    # S40 lifted the channel-name shape check from the POST surface
    # into the GET surface so an invalid channel_id segment doesn't
    # silently fall through to `Scrollback.fetch/5` and return
    # 200 + empty list, hiding a client typo. Mirror of the POST
    # validation tests below.
    conn = get(conn, "/networks/azzurra/channels/notachan/messages")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "GET without Bearer returns 401" do
    conn = get(Phoenix.ConnTest.build_conn(), "/networks/azzurra/channels/%23sniffo/messages")
    assert json_response(conn, 401) == %{"error" => "unauthorized"}
  end

  describe "POST /networks/:network_id/channels/:channel_id/messages — input validation" do
    test "unknown network slug returns 404 not found", %{conn: conn} do
      # Sub-task 2g: slug → integer FK resolution short-circuits with
      # "not_found" before reaching the Session lookup. A known slug
      # without a session is the separate :no_session path tested in
      # `MessagesControllerOutboundTest`.
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/no-such-net/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "empty body returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => ""})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "missing body field returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "non-string body returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => 42})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "POST without Bearer returns 401" do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  # Task 30: visitor scrollback partition. `Scrollback.fetch/5` was
  # widened to take a `subject :: {:user, id} | {:visitor, id}` tuple;
  # the controller threads `:current_subject` (plumbed by Plugs.Authn
  # S18 C2) so visitor sessions read their visitor-id-partitioned rows.
  describe "visitor subject — read partition" do
    test "GET returns visitor's own rows; never another visitor's", %{conn: _conn} do
      slug = "azzurra-vis-msg-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})

      {visitor, session} = visitor_and_session(network_slug: slug)
      other_visitor = visitor_fixture(network_slug: slug)

      {:ok, _} =
        ScrollbackHelpers.insert(%{
          visitor_id: visitor.id,
          network_id: network.id,
          channel: "#sniffo",
          server_time: 1,
          kind: :privmsg,
          sender: visitor.nick,
          body: "mine"
        })

      {:ok, _} =
        ScrollbackHelpers.insert(%{
          visitor_id: other_visitor.id,
          network_id: network.id,
          channel: "#sniffo",
          server_time: 2,
          kind: :privmsg,
          sender: other_visitor.nick,
          body: "not-mine"
        })

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> get("/networks/#{slug}/channels/%23sniffo/messages")

      body = json_response(conn, 200)
      assert length(body) == 1
      assert hd(body)["body"] == "mine"
    end

    test "GET against a network the visitor isn't pinned to returns 404 (oracle close)",
         %{conn: _conn} do
      slug = "azzurra-iso-#{System.unique_integer([:positive])}"
      {:ok, _own} = Networks.find_or_create_network(%{slug: slug})
      {_visitor, session} = visitor_and_session(network_slug: slug)

      other_slug = "other-#{System.unique_integer([:positive])}"
      {:ok, _other} = Networks.find_or_create_network(%{slug: other_slug})

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> get("/networks/#{other_slug}/channels/%23sniffo/messages")

      assert json_response(conn, 404)["error"] == "not_found"
    end
  end
end
