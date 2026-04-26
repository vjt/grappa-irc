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

  alias Grappa.{IRCServer, Scrollback, Session}

  setup %{conn: conn} do
    {_, session} = user_and_session()
    {:ok, conn: put_bearer(conn, session.id)}
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  defp start_session(port, overrides \\ %{}) do
    base = %{
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
    test "sends PRIVMSG upstream, persists row, broadcasts, returns 201", %{conn: conn} do
      {server, port} = start_server()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, "grappa:network:azzurra/channel:#sniffo")
      pid = start_session(port)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "ciao raga"})

      body = json_response(conn, 201)
      assert body["body"] == "ciao raga"
      assert body["channel"] == "#sniffo"
      assert body["network_id"] == "azzurra"
      assert body["kind"] == "privmsg"
      assert body["sender"] == "grappa-test"
      assert is_integer(body["server_time"])
      assert is_integer(body["id"])

      msg =
        assert_message_event(
          [
            kind: :privmsg,
            body: "ciao raga",
            sender: "grappa-test",
            channel: "#sniffo",
            network_id: "azzurra",
            meta: %{}
          ],
          1_000
        )

      assert is_integer(msg.server_time)
      assert is_integer(msg.id)

      assert {:ok, "PRIVMSG #sniffo :ciao raga\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PRIVMSG"))

      [row] = Scrollback.fetch("azzurra", "#sniffo", nil, 10)
      assert row.body == "ciao raga"
      assert row.sender == "grappa-test"
      assert row.kind == :privmsg

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "POST then GET roundtrip — message visible via subsequent fetch", %{conn: conn} do
      {server, port} = start_server()
      pid = start_session(port)
      :ok = await_handshake(server)

      conn1 =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "persisted"})

      assert json_response(conn1, 201)

      {_, s2} = user_and_session()

      conn2 =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(s2.id)
        |> get("/networks/azzurra/channels/%23sniffo/messages")

      body = json_response(conn2, 200)
      assert length(body) == 1
      assert Enum.at(body, 0)["body"] == "persisted"
      assert Enum.at(body, 0)["sender"] == "grappa-test"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "broadcast scoped to (network, channel) — does not leak", %{conn: conn} do
      {server, port} = start_server()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, "grappa:network:azzurra/channel:#other")
      pid = start_session(port)
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
