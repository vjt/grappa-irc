defmodule GrappaWeb.MessagesControllerOutboundTest do
  @moduledoc """
  Outbound write path: `POST /networks/:net/channels/:chan/messages`
  routes through the per-(user, network) `Grappa.Session.Server` to
  send a PRIVMSG upstream, persist locally with the session's nick as
  sender, broadcast on the per-channel topic, and return 201 with the
  serialized message.

  Sub-task 2g: the URL `:net` slug is resolved to its integer FK before
  the session lookup; the session is keyed by
  `(conn.assigns.current_user_id, network.id)`. The bearer-token
  session in `setup` MUST be for the same `vjt` user that the
  Session.Server was spawned for, otherwise the lookup misses.

  Tests use an in-process `Grappa.IRCServer` fake to assert the
  PRIVMSG bytes hit the wire.

  `async: false` because Session uses singleton supervisors + Registry;
  see `Grappa.Session.ServerTest` for the same rationale.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.{AuthFixtures, MessageEventAssertions}

  alias Grappa.{IRCServer, PubSub.Topic, Scrollback}
  alias Grappa.RateLimit.TokenBucket

  setup %{conn: conn} do
    # The bearer-token session must be for the SAME user the Session
    # is spawned for (post-2g routes via conn.assigns.current_user_id
    # end-to-end). Pre-2g this used a different user's session because
    # Session.send_privmsg routed via Session.placeholder_user — that
    # mismatch is now a contract violation that would 404 every POST.
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  defp setup_network(vjt, port, slug \\ "azzurra") do
    {network, _} = network_with_server(port: port, slug: slug)
    _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
    network
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    :ok
  end

  describe "POST with active session" do
    test "sends PRIVMSG upstream, persists row, broadcasts, returns 201",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel(vjt.name, network.slug, "#sniffo")
        )

      # Sub-task 2h regression: Phase 1 topic shape gets nothing now.
      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          "grappa:network:#{network.slug}/channel:#sniffo"
        )

      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{"body" => "ciao raga"})

      body = json_response(conn, 201)
      assert body["body"] == "ciao raga"
      assert body["channel"] == "#sniffo"
      assert body["network"] == network.slug
      assert body["kind"] == "privmsg"
      assert body["sender"] == "grappa-test"
      assert is_integer(body["server_time"])
      assert is_integer(body["id"])
      # Per decision G3 the wire MUST NOT carry user_id — it's a topic
      # discriminator, not a payload field.
      refute Map.has_key?(body, "user_id")

      msg =
        assert_message_event(
          [
            kind: :privmsg,
            body: "ciao raga",
            sender: "grappa-test",
            channel: "#sniffo",
            network: network.slug,
            meta: %{}
          ],
          1_000
        )

      assert is_integer(msg.server_time)
      assert is_integer(msg.id)
      refute Map.has_key?(msg, :user_id)

      # Phase 1 shape subscriber sees nothing — routing iso holds.
      refute_received {:event, _}

      assert {:ok, "PRIVMSG #sniffo :ciao raga\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PRIVMSG"), 1_000)

      [row] = Scrollback.fetch({:user, vjt.id}, network.id, "#sniffo", nil, 10, nil)
      assert row.body == "ciao raga"
      assert row.sender == "grappa-test"
      assert row.kind == :privmsg
      assert row.user_id == vjt.id

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "POST then GET roundtrip — vjt's POST visible via vjt's subsequent GET",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn1 =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{"body" => "persisted"})

      assert json_response(conn1, 201)

      # Per-user iso: GET as vjt — the conn already has vjt's bearer.
      conn2 =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session_fixture(vjt).id)
        |> get("/networks/#{network.slug}/channels/%23sniffo/messages")

      body = json_response(conn2, 200)
      assert length(body) == 1
      assert Enum.at(body, 0)["body"] == "persisted"
      assert Enum.at(body, 0)["sender"] == "grappa-test"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "PER-USER ISO: alice's GET on the same channel returns 404 not_found",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn1 =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{"body" => "vjt-secret"})

      assert json_response(conn1, 201)

      # Different user — auth as alice, fetch the same channel.
      # S14 oracle close: pre-fix this returned 200 [] because the
      # user_id partition silently filtered to empty rows — leaking
      # network existence. Now `Plugs.ResolveNetwork` rejects with the
      # same 404 not_found body as "wrong slug."
      alice = user_fixture(name: "alice-#{System.unique_integer([:positive])}")

      conn2 =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session_fixture(alice).id)
        |> get("/networks/#{network.slug}/channels/%23sniffo/messages")

      assert json_response(conn2, 404)["error"] == "not_found"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "broadcast scoped to (user, network, channel) — does not leak", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel(vjt.name, network.slug, "#other")
        )

      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{"body" => "wrong-receiver"})

      assert json_response(conn, 201)
      refute_receive %Phoenix.Socket.Broadcast{event: "event", payload: _}, 100

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "POST without session" do
    test "unknown network slug returns 404 not found", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/no-such-net/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    # S14 oracle close: known slug + credential but no session running
    # surfaces with the SAME body as "unknown slug" + "no credential."
    # Internal :no_session tag preserved for operator-log tracing; the
    # wire body is uniform `not_found` to prevent the probing oracle.
    test "known slug but no session returns 404 not_found (oracle close)",
         %{conn: conn, vjt: vjt} do
      _ = setup_network(vjt, 9999, "azzurra")

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    # S14 oracle close: a probing user posting against someone else's
    # network gets the SAME body as "unknown slug." Pre-fix this leaked
    # network existence via a distinct :no_session body.
    test "POST against another user's network returns 404 not_found", %{conn: conn} do
      alice = user_fixture(name: "alice-#{System.unique_integer([:positive])}")
      {network, _} = network_with_server(port: 7201, slug: "alice-only-#{System.unique_integer([:positive])}")
      _ = credential_fixture(alice, network)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "without Bearer returns 401" do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  describe "POST CRLF guard (S29 C1)" do
    # Body validation happens at the Session facade (and Client too),
    # surfacing as `{:error, :invalid_line}` → 400 invalid_line via
    # FallbackController. The session need not be running — the
    # validator runs BEFORE whereis/2, so the error wins over
    # :no_session and :not_found alike.
    test "body with embedded \\r\\n returns 400 invalid_line", %{conn: conn, vjt: vjt} do
      _ = setup_network(vjt, 9999, "azzurra")

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{
          "body" => "hi\r\nQUIT :pwn"
        })

      assert json_response(conn, 400)["error"] == "invalid_line"
    end

    test "body with NUL byte returns 400 invalid_line", %{conn: conn, vjt: vjt} do
      _ = setup_network(vjt, 9999, "azzurra")

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "hi\x00bye"})

      assert json_response(conn, 400)["error"] == "invalid_line"
    end

    test "URL-encoded CRLF in :channel_id returns 400 (channel-syntax check)",
         %{conn: conn, vjt: vjt} do
      _ = setup_network(vjt, 9999, "azzurra")

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23chan%0AQUIT/messages", %{"body" => "hello"})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    # C4/DM fix-up: digit-leading target is neither a valid nick NOR a
    # valid channel — validate_target_name rejects it with :bad_request.
    test "POST with digit-leading target (neither nick nor channel) returns 400",
         %{conn: conn, vjt: vjt} do
      _ = setup_network(vjt, 9999, "azzurra")

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/123bad/messages", %{"body" => "hello"})

      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  # C4/DM fix-up: POST to a nick-shaped target (DM) must succeed when a
  # session is running. The target validator was widened from channel-only
  # to channel-OR-nick; this test pins the happy path.
  describe "POST to nick target (DM)" do
    test "sends PRIVMSG upstream to nick target, persists row, returns 201",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/someuser/messages", %{
          "body" => "hey there"
        })

      body = json_response(conn, 201)
      assert body["body"] == "hey there"
      assert body["channel"] == "someuser"
      assert body["kind"] == "privmsg"

      assert {:ok, "PRIVMSG someuser :hey there\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PRIVMSG someuser"), 1_000)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  # #340 — inbound send-throttle: `POST .../messages` consumes one token
  # from a per-`(subject, network)` token bucket; an exhausted bucket
  # returns 429 `rate_limited` BEFORE the send reaches upstream, so cic
  # gets a "slow down" before bahamut k-lines the user for flooding. The
  # test config shrinks the burst to 3 (`config/test.exs :send_throttle`).
  # Refill-over-time is proven deterministically at the `TokenBucket` unit
  # level (its `now_ms` seam) — a wall-clock refill test here would be
  # flaky, so this describe covers the burst→429 + per-(subject,network)
  # keying, which is the wire contract the controller owns.
  describe "POST send throttle (#340)" do
    setup do
      # Hermetic: the token bucket is an application-wide ETS singleton.
      :ets.delete_all_objects(TokenBucket.table_name())
      :ok
    end

    defp post_body(conn, network, body) do
      conn
      |> put_req_header("content-type", "application/json")
      |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{"body" => body})
    end

    test "a full burst succeeds (201), the next POST is throttled (429)",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # capacity == 3 (test config): three sends ride the burst.
      for n <- 1..3 do
        assert json_response(post_body(conn, network, "line #{n}"), 201)
      end

      # Fourth send drains an empty bucket → 429 rate_limited, and it never
      # reaches send_privmsg (the throttle is the gate before it).
      assert %{"error" => "rate_limited"} = json_response(post_body(conn, network, "flood"), 429)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "the bucket is per-(subject, network): a second network is unaffected by the first's flood",
         %{conn: conn, vjt: vjt} do
      {server1, port1} = start_server()
      net1 = setup_network(vjt, port1, "azzurra")
      pid1 = start_session_for(vjt, net1)
      :ok = await_handshake(server1)

      {server2, port2} = start_server()
      net2 = setup_network(vjt, port2, "second-net")
      pid2 = start_session_for(vjt, net2)
      :ok = await_handshake(server2)

      # Drain net1's bucket entirely (capacity 3 + one throttled).
      for n <- 1..3, do: assert(json_response(post_body(conn, net1, "n1-#{n}"), 201))
      assert json_response(post_body(conn, net1, "n1-flood"), 429)

      # net2's bucket is a distinct key → first send still rides its burst.
      assert json_response(post_body(conn, net2, "n2-fresh"), 201)

      :ok = GenServer.stop(pid1, :normal, 1_000)
      :ok = GenServer.stop(pid2, :normal, 1_000)
    end
  end

  # UX-4 bucket G — POST to a *serv target (NickServ IDENTIFY etc.):
  # Session.send_privmsg returns `{:ok, :no_persist}` (wire-only path,
  # W12 credential leak avoidance). Pre-bucket-G the controller's
  # `with {:ok, message} <- ...` non-matched on the no-persist tag,
  # FallbackController had no clause, and Phoenix raised 500 on the
  # unsent conn. The controller now branches on the result kind and
  # returns 202 + `%{ok: true}` for the no-persist path; the wire
  # frame still ships upstream so NickServ receives the IDENTIFY.
  describe "POST to *serv target (UX-4 bucket G)" do
    test "POST to NickServ returns 202 ok=true, no scrollback row, line on wire",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel(vjt.name, network.slug, "NickServ")
        )

      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/NickServ/messages", %{
          "body" => "IDENTIFY s3cret"
        })

      assert json_response(conn, 202) == %{"ok" => true}

      # Wire frame still ships — operator's IDENTIFY reaches NickServ.
      assert {:ok, "PRIVMSG NickServ :IDENTIFY s3cret\r\n"} =
               IRCServer.wait_for_line(
                 server,
                 &String.starts_with?(&1, "PRIVMSG NickServ"),
                 1_000
               )

      # No scrollback row persisted (credential never lands in DB).
      assert [] = Scrollback.fetch({:user, vjt.id}, network.id, "NickServ", nil, 10, nil)

      # No PubSub broadcast on the NickServ topic (no row, no fanout).
      refute_received %Phoenix.Socket.Broadcast{event: "event", payload: _}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "POST to chanserv (lowercase) returns 202", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/chanserv/messages", %{
          "body" => "REGISTER #x pwd"
        })

      assert json_response(conn, 202) == %{"ok" => true}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end
end
