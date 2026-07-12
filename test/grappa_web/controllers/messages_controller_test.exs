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

  test "GET ?before=<id>&limit=2 paginates correctly (id-cursor semantics post-CP29 R-2)",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    # CP29 R-2: ?before= is now an id cursor (was server_time). Pick the
    # row with body "m3" — strictly less than its id should yield m2, m1
    # in DESC order (cap 2).
    conn0 = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body0 = json_response(conn0, 200)
    m3 = Enum.find(body0, fn row -> row["body"] == "m3" end)

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=#{m3["id"]}&limit=2")
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

  # Message-replay-on-reconnect cluster — `?after=<id>` cursor for cic's
  # WS-reconnect backfill. ASC by `id`, exclusive of the cursor row.
  test "GET ?after=<id> returns rows with id > cursor in ASC id order",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    # Pick the second-oldest row's id; should yield m2, m3, m4 ascending.
    conn0 = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body0 = json_response(conn0, 200)
    # Body is DESC; the second-oldest is the second-from-last.
    second_oldest = Enum.at(body0, -2)

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?after=#{second_oldest["id"]}")
    body = json_response(conn, 200)
    assert Enum.map(body, & &1["body"]) == ["m2", "m3", "m4"]
  end

  test "GET ?after=<huge> returns []", %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?after=999999999")
    assert json_response(conn, 200) == []
  end

  test "GET ?after=banana returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?after=banana")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "GET ?before and ?after together returns 400 (mutually exclusive)",
       %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=10&after=5")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  # CP29 R-2: cursor mutex extended from {before, after} to {before,
  # after, around}. Any two together is a client bug.
  test "GET ?before and ?around together returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=10&around=5")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "GET ?after and ?around together returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?after=10&around=5")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "GET ?around=banana returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?around=banana")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  # CP29 R-2: HTTP boundary ceiling at 200. Underlying Scrollback cap
  # (500) stays as backstop; HTTP request asking 5000 is a client bug.
  test "GET ?limit=201 returns 400 (HTTP ceiling)", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=201")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "GET ?limit=200 is accepted (boundary)", %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=200")
    body = json_response(conn, 200)
    assert length(body) == 5
  end

  # CP29 R-2: ?around=<id> returns floor(limit/2) before + ceil(limit/2)
  # after, merged DESC. With 5 rows seeded (ids ascending) and limit=4,
  # asking around the middle row should yield 2 before + 2 after.
  test "GET ?around=<id>&limit=4 returns rows centered on the cursor",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn0 = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body0 = json_response(conn0, 200)
    m2 = Enum.find(body0, fn row -> row["body"] == "m2" end)

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?around=#{m2["id"]}&limit=4")
    body = json_response(conn, 200)
    # Returned DESC: 2 after (m4, m3) then floor(4/2) = 2 before-or-at (m2, m1).
    assert Enum.map(body, & &1["body"]) == ["m4", "m3", "m2", "m1"]
  end

  test "GET ?around=<id> with default limit returns up to 50 rows", %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn0 = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body0 = json_response(conn0, 200)
    m2 = Enum.find(body0, fn row -> row["body"] == "m2" end)

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?around=#{m2["id"]}")
    body = json_response(conn, 200)
    # All 5 fit in default limit=50. DESC ordering preserved.
    assert Enum.map(body, & &1["body"]) == ["m4", "m3", "m2", "m1", "m0"]
  end

  test "GET ?after=<id>&limit=2 caps the page size", %{conn: conn, user: user, network: network} do
    seed(user, network)
    # cursor BELOW the lowest id in the table — yields all five, capped to 2.
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?after=0&limit=2")
    body = json_response(conn, 200)
    assert length(body) == 2
    # ASC: lowest two of m0..m4 (which are inserted with server_time = 0..4).
    assert Enum.map(body, & &1["body"]) == ["m0", "m1"]
  end

  # After the C4/DM fix-up: the target validator accepts BOTH channel-sigil
  # names AND valid IRC nicks (DM targets). A plain nick like "notachan"
  # is a valid DM target — it returns 200+[] (no scrollback rows) not 400.
  # The shape-check only rejects targets that are neither a valid channel
  # NOR a valid nick, e.g. digit-leading strings.
  test "GET with nick-shaped target returns 200 (DM scrollback fetch)", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/notachan/messages")
    assert json_response(conn, 200) == []
  end

  test "GET with truly malformed target (digit-leading, neither nick nor channel) returns 400",
       %{conn: conn} do
    # "123bad" starts with a digit → rejected by valid_nick?; has no
    # channel sigil → rejected by valid_channel?.  This is the shape
    # check that still fires after the DM widening.
    conn = get(conn, "/networks/azzurra/channels/123bad/messages")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  # BUG 2c: $server is Grappa's synthetic pseudo-target for server-window
  # scrollback. validate_target_name/1 must accept it so REST
  # loadInitialScrollback succeeds for the Server window.
  test "GET with $server synthetic target returns 200 (server-window scrollback fetch)",
       %{conn: conn, user: user, network: network} do
    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: "$server",
        server_time: 1,
        kind: :notice,
        sender: "irc.azzurra.org",
        body: "Welcome to Azzurra"
      })

    conn = get(conn, "/networks/azzurra/channels/%24server/messages")
    body = json_response(conn, 200)
    assert length(body) == 1
    assert hd(body)["channel"] == "$server"
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

    # HIGH-19 (no-silent-drops B6.9a 2026-05-14): body byte cap. Pre-fix
    # an oversized body reached IRC.Client.transport_send and either
    # truncated silently at the 512-byte RFC framing limit or got the
    # upstream peer to disconnect — UI claimed `:ok` while the message
    # never arrived. Surfacing as 413 + body_too_large lets cic render
    # an actionable rejection.
    test "body over BodyLimit cap returns 413 body_too_large", %{conn: conn} do
      oversize = String.duplicate("x", GrappaWeb.BodyLimit.max_body_bytes() + 1)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => oversize})

      assert json_response(conn, 413)["error"] == "body_too_large"
      assert json_response(conn, 413)["limit"] == GrappaWeb.BodyLimit.max_body_bytes()
    end

    test "POST without Bearer returns 401" do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    # Codebase review 2026-05-08 W1: $server is a Grappa-internal
    # synthetic for the server-messages window. GET accepts it (so
    # `loadInitialScrollback` works) but POST must NOT, otherwise a
    # client could smuggle `PRIVMSG $server :body` upstream — server-
    # mask form per RFC 2812 §3.3.1 — pollute the synthetic Server-
    # window scrollback with single-source echo, and inadvertently
    # probe operator privileges. The shared `validate_target_name/1`
    # earned the `$server` clause for GET; POST should reject it.
    test "POST to $server target returns 400 — synthetic is read-only", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%24server/messages", %{"body" => "hello"})

      assert json_response(conn, 400)["error"] == "bad_request"
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

      {visitor, session} = visitor_and_session_with_credential(network_slug: slug)
      other_visitor = visitor_fixture(network_slug: slug)

      {:ok, _} =
        ScrollbackHelpers.insert(%{
          visitor_id: visitor.id,
          network_id: network.id,
          channel: "#sniffo",
          server_time: 1,
          kind: :privmsg,
          sender: "mine-sender",
          body: "mine"
        })

      {:ok, _} =
        ScrollbackHelpers.insert(%{
          visitor_id: other_visitor.id,
          network_id: network.id,
          channel: "#sniffo",
          server_time: 2,
          kind: :privmsg,
          sender: "other-sender",
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
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})
      {_, session} = visitor_and_session_with_credential(network_slug: slug)

      other_slug = "other-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: other_slug})

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> get("/networks/#{other_slug}/channels/%23sniffo/messages")

      assert json_response(conn, 404)["error"] == "not_found"
    end
  end
end
