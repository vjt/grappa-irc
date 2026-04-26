defmodule GrappaWeb.ChannelsControllerTest do
  @moduledoc """
  POST /networks/:network_id/channels (JOIN) and
  DELETE /networks/:network_id/channels/:channel_id (PART) route through
  the per-(user, network) `Grappa.Session.Server` to send IRC commands
  upstream. Without an active session for the hardcoded "vjt" user the
  endpoints return 404 (operator must wire the session).

  `async: false` because `Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor`, and `Grappa.PubSub` are singletons —
  concurrent tests would collide.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Session}

  setup %{conn: conn} do
    {_, session} = user_and_session()
    {:ok, conn: put_bearer(conn, session.id), session: session}
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

  describe "POST /networks/:network_id/channels" do
    test "with active session sends JOIN upstream and returns 202", %{conn: conn} do
      {server, port} = start_server()
      pid = start_session(port)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "JOIN #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #sniffo\r\n"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "without session returns 404", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/no-such-net/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 404)["error"] == "no session"
    end

    test "without Bearer returns 401" do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "missing name returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{})

      assert json_response(conn, 400)["error"] == "bad request"
    end

    test "non-string name returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => 42})

      assert json_response(conn, 400)["error"] == "bad request"
    end

    test "empty name returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => ""})

      assert json_response(conn, 400)["error"] == "bad request"
    end
  end

  describe "DELETE /networks/:network_id/channels/:channel_id" do
    test "with active session sends PART upstream and returns 202", %{conn: conn} do
      {server, port} = start_server()
      pid = start_session(port)
      :ok = await_handshake(server)

      conn = delete(conn, "/networks/azzurra/channels/%23sniffo")

      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "PART #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "PART #sniffo\r\n"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "without session returns 404", %{conn: conn} do
      conn = delete(conn, "/networks/no-such-net/channels/%23sniffo")

      assert json_response(conn, 404)["error"] == "no session"
    end

    test "without Bearer returns 401" do
      conn = delete(Phoenix.ConnTest.build_conn(), "/networks/azzurra/channels/%23sniffo")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end
end
