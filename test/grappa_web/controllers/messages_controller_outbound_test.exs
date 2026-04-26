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

  setup %{conn: conn} do
    # The bearer-token session must be for the SAME user the Session
    # is spawned for (post-2g routes via conn.assigns.current_user_id
    # end-to-end). Pre-2g this used a different user's session because
    # Session.send_privmsg routed via Session.placeholder_user — that
    # mismatch is now a contract violation that would 404 every POST.
    vjt = user_fixture(name: "vjt")
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
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
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
          Topic.channel("vjt", network.slug, "#sniffo")
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
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PRIVMSG"))

      [row] = Scrollback.fetch(vjt.id, network.id, "#sniffo", nil, 10)
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

    test "PER-USER ISO: alice's GET on the same channel does NOT see vjt's POSTed message",
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
      alice = user_fixture(name: "alice-#{System.unique_integer([:positive])}")

      conn2 =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session_fixture(alice).id)
        |> get("/networks/#{network.slug}/channels/%23sniffo/messages")

      assert json_response(conn2, 200) == []

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "broadcast scoped to (user, network, channel) — does not leak", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel("vjt", network.slug, "#other")
        )

      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{"body" => "wrong-receiver"})

      assert json_response(conn, 201)
      refute_receive {:event, _}, 100

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

    test "known slug but no session returns 404 no session", %{conn: conn, vjt: vjt} do
      _ = setup_network(vjt, 9999, "azzurra")

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 404)["error"] == "no_session"
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
  end
end
