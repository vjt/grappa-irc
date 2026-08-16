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

  alias Grappa.{IRCServer, PresenceFilter, PubSub.Topic, Scrollback, ScrollbackHelpers}
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
    setup_network(vjt, port, slug, nil)
  end

  defp setup_network(vjt, port, slug, services_flavor) do
    {network, _} = network_with_server(port: port, slug: slug, services_flavor: services_flavor)
    _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
    network
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    :ok
  end

  describe "GET presence filter — #458 member-count (unset) branch" do
    test "unset pref on a LARGE channel (>= threshold members) hides presence via the size default",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # Seed the live Session with >= LARGE_CHANNEL_THRESHOLD members so the
      # controller reads the count and an UNSET pref resolves to HIDE. This is
      # the only branch that distinguishes "count read" from "count nil → show"
      # (both small-channel and no-session resolve to show).
      nicks = for i <- 1..(PresenceFilter.large_channel_threshold() + 1), do: "n#{i}"
      IRCServer.feed(server, ":grappa-test!u@h JOIN :#big\r\n")
      IRCServer.feed(server, ":irc 353 grappa-test = #big :grappa-test #{Enum.join(nicks, " ")}\r\n")
      IRCServer.feed(server, ":irc 366 grappa-test #big :End of /NAMES list.\r\n")
      IRCServer.feed(server, "PING :flush\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)

      {:ok, _} =
        ScrollbackHelpers.insert(%{
          user_id: vjt.id,
          network_id: network.id,
          channel: "#big",
          server_time: 0,
          kind: :privmsg,
          sender: "vjt",
          body: "hi"
        })

      {:ok, _} =
        ScrollbackHelpers.insert(%{
          user_id: vjt.id,
          network_id: network.id,
          channel: "#big",
          server_time: 1,
          kind: :join,
          sender: "n1",
          body: nil
        })

      body = json_response(get(conn, "/networks/#{network.slug}/channels/%23big/messages"), 200)
      kinds = body |> Enum.map(& &1["kind"]) |> Enum.uniq()

      assert kinds == ["privmsg"], "unset + large channel must hide presence via the member-count size default"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
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

      [row] = Scrollback.fetch({:user, vjt.id}, network.id, "#sniffo", nil, 10, nil, false)
      assert row.body == "ciao raga"
      assert row.sender == "grappa-test"
      assert row.kind == :privmsg
      assert row.user_id == vjt.id

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "#640: ctcp_target routes the echo to the SOURCE window, wire to the recipient, no query window",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # /ping carol typed in #sniffo: cic POSTs to the SOURCE window (the URL
      # channel_id, #sniffo) with ctcp_target=carol (the wire recipient). The
      # echo persists in #sniffo; carol never gets a phantom query window.
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{
          "body" => "\x01PING 1706743200000\x01",
          "ctcp_target" => "carol"
        })

      body = json_response(conn, 201)
      assert body["channel"] == "#sniffo"
      assert body["kind"] == "privmsg"
      assert body["meta"]["ctcp_verb"] == "PING"
      assert body["meta"]["ctcp_args"] == "1706743200000"
      assert body["meta"]["ctcp_target"] == "carol"

      # The frame reaches carol on the wire, NOT #sniffo.
      assert {:ok, "PRIVMSG carol :\x01PING 1706743200000\x01\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PRIVMSG carol"), 1_000)

      # The echo lives in the SOURCE window's scrollback.
      rows = Scrollback.fetch({:user, vjt.id}, network.id, "#sniffo", nil, 10, nil, false)
      assert Enum.any?(rows, &(&1.body == "\x01PING 1706743200000\x01"))

      # No phantom query window for the recipient — the whole point of #640.
      refute Grappa.QueryWindows.open?({:user, vjt.id}, network.id, "carol")

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "#640: ctcp_target = $server is rejected (read-only) as bad_request",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # The wire recipient is validated with validate_post_target_name, which
      # rejects the read-only $server synthetic (a CTCP frame can't target it).
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{
          "body" => "\x01VERSION\x01",
          "ctcp_target" => "$server"
        })

      assert json_response(conn, 400)["error"] == "bad_request"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "#1225: notice_target ships a NOTICE, echoes to the SOURCE window, opens no window",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # `/notice carol heads up` typed in #sniffo: cic POSTs to the SOURCE window
      # (the URL channel_id) with notice_target=carol. Mirror of the #640
      # ctcp_target door — same source-keyed echo, different wire verb.
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{
          "body" => "heads up",
          "notice_target" => "carol"
        })

      body = json_response(conn, 201)
      assert body["channel"] == "#sniffo"
      assert body["kind"] == "notice"
      assert body["meta"]["notice_target"] == "carol"

      assert {:ok, "NOTICE carol :heads up\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "NOTICE carol"), 1_000)

      rows = Scrollback.fetch({:user, vjt.id}, network.id, "#sniffo", nil, 10, nil, false)
      assert Enum.any?(rows, &(&1.body == "heads up" and &1.kind == :notice))

      refute Grappa.QueryWindows.open?({:user, vjt.id}, network.id, "carol")

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "#1225: notice_target = $server is rejected (read-only) as bad_request",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{
          "body" => "heads up",
          "notice_target" => "$server"
        })

      assert json_response(conn, 400)["error"] == "bad_request"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "#1301: notice_target = @#chan reaches the wire VERBATIM and echoes to the source window",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # `/notice @#sniffo heads up` — the form operators use most, refused as
      # malformed before #1301 because the raw `@#sniffo` matched neither the
      # channel regex nor the nick regex at the POST boundary.
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{
          "body" => "heads up",
          "notice_target" => "@#sniffo"
        })

      body = json_response(conn, 201)
      assert body["channel"] == "#sniffo"
      assert body["meta"]["notice_target"] == "@#sniffo"

      # VERBATIM on the wire: the sigil is peeled to VALIDATE, never to
      # rewrite. What `@#sniffo` means is the ircd's ruling, not ours, so a
      # canonicalised target would be us answering a question we were not
      # asked — and a refusal would be us inventing one.
      assert {:ok, "NOTICE @#sniffo :heads up\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "NOTICE @"), 1_000)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "#1301: a sigil is still refused on the URL channel_id — that one IS a window key",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # The control for the test above. On the plain arm the URL channel is
      # BOTH the wire target and the persist key, so admitting a sigil here
      # would key scrollback to `@#sniffo` — a window nobody is in, the
      # outbound twin of #1303 case B. The two arms take deliberately
      # different validators.
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%40%23sniffo/messages", %{
          "body" => "heads up"
        })

      assert json_response(conn, 400)["error"] == "bad_request"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "#1225: a /notice to NickServ does not archive a mistyped identify password",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # The W12 carve-out at the DOOR, not just in the session: a fat-fingered
      # `/notice nickserv identify <pass>` must reach the wire and leave nothing
      # on disk. Asserted here as well as in server_test because a refactor that
      # merely mirrors the PRIVMSG path is one clause away from losing it, and
      # the cost of losing it is a password written to the scrollback DB.
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{
          "body" => "identify hunter2",
          "notice_target" => "NickServ"
        })

      # 202 + {ok: true}: wire-only, no persisted row to render.
      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "NOTICE NickServ"), 1_000)

      rows = Scrollback.fetch({:user, vjt.id}, network.id, "#sniffo", nil, 10, nil, false)
      refute Enum.any?(rows, &(&1.body =~ "hunter2"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "#1225: a POST carrying BOTH ctcp_target and notice_target is bad_request",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # Two relay verbs in one POST is not a shape the client can mean. Refusing
      # it out loud beats letting clause ORDER silently pick a winner.
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{
          "body" => "heads up",
          "ctcp_target" => "carol",
          "notice_target" => "carol"
        })

      assert json_response(conn, 400)["error"] == "bad_request"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "#357: the send-path span [:grappa, :session, :send_privmsg] closes with outcome: :ok",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      handler_id = {__MODULE__, System.unique_integer([:positive])}
      test_pid = self()

      :telemetry.attach(
        handler_id,
        [:grappa, :session, :send_privmsg, :stop],
        fn event, measurements, metadata, _ ->
          send(test_pid, {:telemetry, event, measurements, metadata})
        end,
        nil
      )

      on_exit(fn -> :telemetry.detach(handler_id) end)

      conn
      |> put_req_header("content-type", "application/json")
      |> post("/networks/#{network.slug}/channels/%23sniffo/messages", %{"body" => "measured"})
      |> json_response(201)

      assert_receive {:telemetry, [:grappa, :session, :send_privmsg, :stop], measurements, metadata}

      assert metadata.target == "#sniffo"
      assert metadata.network_id == network.id
      assert metadata.subject == :user
      assert metadata.outcome == :ok
      # Total round-trip INCLUDING mailbox queue time (mechanism 1) — the
      # "pure insert" scrollback span is the other half; the gap is queue-wait.
      assert is_integer(measurements.duration) and measurements.duration >= 0

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

    # #666 — the send-door 429 MUST carry a `retry-after` header so cic can
    # pace the remaining lines of a multi-line paste against THIS bucket's
    # refill instead of firing them back-to-back (and re-429ing). The value is
    # the send throttle's OWN refill interval — NOT the coarse #630 budget's
    # (RequestBudget.retry_after_ms/0), which refills far faster and would
    # mis-pace cic. Derived from config here so the assertion tracks the wire
    # contract, not a magic constant.
    test "a throttled POST (429) carries a retry-after header = the send-throttle refill interval",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # Drain the burst (capacity 3 in test config), then trip the empty bucket.
      for n <- 1..3, do: assert(json_response(post_body(conn, network, "line #{n}"), 201))
      throttled = post_body(conn, network, "flood")
      assert %{"error" => "rate_limited"} = json_response(throttled, 429)

      # seconds until one token refills = ceil(1 / refill_per_sec), floored at 1.
      refill = Application.get_env(:grappa, :send_throttle)[:refill_per_sec]
      expected = Integer.to_string(max(1, ceil(1.0 / refill)))
      assert [^expected] = get_resp_header(throttled, "retry-after")

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

  # #480 — the throttle mirrors the UPSTREAM allowance, so the numbers it
  # applies depend on what the ircd published about THIS connection, never
  # on a grappa-side identity tier. Test config: ordinary burst 3, oper
  # burst 6, oper refill 0.25/s (`config/test.exs`). The classification
  # itself is `Grappa.Session.FloodAllowance`'s unit contract; what these
  # prove is that the send door reaches for a different pair of numbers.
  describe "POST send throttle — the upstream allowance decides the pair (#480)" do
    setup do
      :ets.delete_all_objects(TokenBucket.table_name())
      :ok
    end

    # The session must have FOLDED the umode set before the first POST, or
    # the test races its own fixture: a PING answered is proof the session
    # processed everything fed before it.
    defp feed_umodes(server, modes) do
      IRCServer.feed(server, ":irc.test.org 221 grappa-test #{modes}\r\n")
      IRCServer.feed(server, "PING :umodes\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :umodes\r\n"), 1_000)
      :ok
    end

    test "an oper'd session rides the WIDER burst, and still lands on a 429 at its own ceiling",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)
      :ok = feed_umodes(server, "+io")

      # Sends 4, 5 and 6 are the discriminating ones: under the ordinary
      # pair the bucket was empty after 3.
      for n <- 1..6 do
        assert json_response(post_body(conn, network, "oper line #{n}"), 201)
      end

      # Still a bucket, not an open door — the oper allowance is wider,
      # not absent.
      assert %{"error" => "rate_limited"} =
               json_response(post_body(conn, network, "oper flood"), 429)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "the oper 429 carries the OPER refill interval, not the ordinary one",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)
      :ok = feed_umodes(server, "+io")

      for n <- 1..6, do: assert(json_response(post_body(conn, network, "oper #{n}"), 201))
      throttled = post_body(conn, network, "oper flood")
      assert %{"error" => "rate_limited"} = json_response(throttled, 429)

      # Derived from config, like the #666 ordinary assertion, so the test
      # tracks the wire contract rather than a magic constant — and the two
      # intervals are distinct on purpose (4 vs 2).
      throttle = Application.get_env(:grappa, :send_throttle)
      expected = Integer.to_string(max(1, ceil(1.0 / throttle[:oper_refill_per_sec])))
      ordinary = Integer.to_string(max(1, ceil(1.0 / throttle[:refill_per_sec])))
      refute expected == ordinary
      assert [^expected] = get_resp_header(throttled, "retry-after")

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "an oper carrying the network's no-throttle umode is not metered at all",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      # The exempt letter is per-flavour; bahamut's is the one that was read
      # at source, so the network has to say it is one.
      network = setup_network(vjt, port, "azzurra", :azzurra)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)
      :ok = feed_umodes(server, "+Fio")

      # Well past BOTH ceilings (3 ordinary, 6 oper): there is no upstream
      # throttle to mirror, so grappa mirrors none.
      for n <- 1..10 do
        assert json_response(post_body(conn, network, "exempt line #{n}"), 201)
      end

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "the same +F on an unclassified network is metered on the oper pair",
         %{conn: conn, vjt: vjt} do
      # No services_flavor: grappa has not been told which ircd this is, so
      # `F` carries no verified meaning and the exemption is withheld. The
      # oper tier still applies — the degradation is graceful.
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)
      :ok = feed_umodes(server, "+Fio")

      for n <- 1..6, do: assert(json_response(post_body(conn, network, "unclassified #{n}"), 201))

      assert %{"error" => "rate_limited"} =
               json_response(post_body(conn, network, "unclassified flood"), 429)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "a plain user is metered on today's numbers, unchanged", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)
      :ok = feed_umodes(server, "+iw")

      for n <- 1..3, do: assert(json_response(post_body(conn, network, "plain #{n}"), 201))

      assert %{"error" => "rate_limited"} =
               json_response(post_body(conn, network, "plain flood"), 429)

      :ok = GenServer.stop(pid, :normal, 1_000)
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
      assert [] = Scrollback.fetch({:user, vjt.id}, network.id, "NickServ", nil, 10, nil, false)

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
