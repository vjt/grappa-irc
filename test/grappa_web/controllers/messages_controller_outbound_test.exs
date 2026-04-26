defmodule GrappaWeb.MessagesControllerOutboundTest do
  @moduledoc """
  Outbound write path: `POST /networks/:net/channels/:chan/messages`
  routes through the per-(user, network) `Grappa.Session.Server` to
  send a PRIVMSG upstream, persist locally with the session's nick as
  sender, broadcast on the per-channel topic, and return 201 with the
  serialized message.

  Tests use an in-process `Grappa.IRCServer` fake to assert the
  PRIVMSG bytes hit the wire.

  `async: false` because Session uses singleton supervisors + Registry;
  see `Grappa.Session.ServerTest` for the same rationale.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.{AuthFixtures, MessageEventAssertions}

  alias Grappa.{IRCServer, PubSub.Topic, Scrollback, Session}

  setup %{conn: conn} do
    # Phase 2 (sub-task 2e): Session.Server writes scrollback rows
    # using user_id as the per-user iso FK. The send-PRIVMSG path
    # routes via Session.placeholder_user ("vjt") — that user MUST
    # exist in DB for Session.Server.init to find it.
    vjt = user_fixture(name: "vjt")
    {_, session} = user_and_session()
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  defp start_session(port, vjt, overrides \\ %{}) do
    base = %{
      user_id: vjt.id,
      user_name: "vjt",
      network_id: "azzurra",
      host: "127.0.0.1",
      port: port,
      tls: false,
      nick: "grappa-test",
      autojoin: []
    }

    {:ok, pid} = Session.start_session(Map.merge(base, overrides))
    pid
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
    :ok
  end

  describe "POST with active session" do
    test "sends PRIVMSG upstream, persists row, broadcasts, returns 201",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel("vjt", "azzurra", "#sniffo")
        )

      # Sub-task 2h regression: Phase 1 topic shape gets nothing now.
      :ok =
        Phoenix.PubSub.subscribe(Grappa.PubSub, "grappa:network:azzurra/channel:#sniffo")

      pid = start_session(port, vjt)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "ciao raga"})

      body = json_response(conn, 201)
      assert body["body"] == "ciao raga"
      assert body["channel"] == "#sniffo"
      assert body["network"] == "azzurra"
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
            network: "azzurra",
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

      {:ok, network} = Grappa.Networks.get_network_by_slug("azzurra")
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
      pid = start_session(port, vjt)
      :ok = await_handshake(server)

      conn1 =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "persisted"})

      assert json_response(conn1, 201)

      # Per-user iso: the GET must be authenticated AS the user that
      # the row was written for (vjt). A different user's GET would
      # see [] — that's a separate test below.
      vjt_session = session_fixture(vjt)

      conn2 =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(vjt_session.id)
        |> get("/networks/azzurra/channels/%23sniffo/messages")

      body = json_response(conn2, 200)
      assert length(body) == 1
      assert Enum.at(body, 0)["body"] == "persisted"
      assert Enum.at(body, 0)["sender"] == "grappa-test"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "PER-USER ISO: alice's GET on the same channel does NOT see vjt's POSTed message",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      pid = start_session(port, vjt)
      :ok = await_handshake(server)

      conn1 =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "vjt-secret"})

      assert json_response(conn1, 201)

      # Different user — auth as alice, fetch the same channel.
      alice = user_fixture(name: "alice-#{System.unique_integer([:positive])}")
      alice_session = session_fixture(alice)

      conn2 =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(alice_session.id)
        |> get("/networks/azzurra/channels/%23sniffo/messages")

      assert json_response(conn2, 200) == []

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "broadcast scoped to (user, network, channel) — does not leak", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel("vjt", "azzurra", "#other")
        )

      pid = start_session(port, vjt)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "wrong-receiver"})

      assert json_response(conn, 201)
      refute_receive {:event, _}, 100

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "POST without session" do
    test "returns 404", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/no-such-net/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 404)["error"] == "no session"
    end

    test "without Bearer returns 401" do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end
end
