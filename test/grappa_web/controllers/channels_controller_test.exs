defmodule GrappaWeb.ChannelsControllerTest do
  @moduledoc """
  POST /networks/:network_id/channels (JOIN) and
  DELETE /networks/:network_id/channels/:channel_id (PART) route through
  the per-(user, network) `Grappa.Session.Server` to send IRC commands
  upstream.

  Sub-task 2g: the URL `:network_id` slug is resolved to its integer FK
  before the session lookup. Unknown slug → 404 `:not_found`; known
  slug but no session → 404 `:no_session`. Both via `FallbackController`.

  `async: false` because `Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor`, and `Grappa.PubSub` are singletons —
  concurrent tests would collide.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.IRCServer

  setup %{conn: conn} do
    # Pre-bind "vjt" + "azzurra" credential so Session.Server.init can
    # resolve the row at boot. The bearer-token session attaches the
    # same vjt to conn.assigns.current_user_id.
    vjt = user_fixture(name: "vjt")
    {:ok, conn: put_bearer(conn, session_fixture(vjt).id), vjt: vjt}
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

  describe "POST /networks/:network_id/channels" do
    test "with active session sends JOIN upstream and returns 202", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "JOIN #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #sniffo\r\n"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "unknown network slug returns 404 not found", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/no-such-net/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "known slug but no session returns 404 no session", %{conn: conn, vjt: vjt} do
      _ = setup_network(vjt, 9999, "azzurra")
      # No session started — Session.send_join returns :no_session.

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 404)["error"] == "no_session"
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

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "non-string name returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => 42})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "empty name returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => ""})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    # S29 C1: a channel name carrying an embedded \r or \n would smuggle a
    # second IRC command onto the wire if it reached Client.send_join.
    # Reject at the controller via Identifier.valid_channel?/1 — the
    # regex already excludes whitespace + control bytes — so the body
    # never reaches the Session.
    test "channel name with embedded CRLF returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => "#chan\r\nQUIT :pwn"})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "channel name failing IRC syntax (missing prefix) returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => "no-prefix"})

      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  describe "DELETE /networks/:network_id/channels/:channel_id" do
    test "with active session sends PART upstream and returns 202", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn = delete(conn, "/networks/#{network.slug}/channels/%23sniffo")

      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "PART #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "PART #sniffo\r\n"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "unknown network slug returns 404 not found", %{conn: conn} do
      conn = delete(conn, "/networks/no-such-net/channels/%23sniffo")
      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "known slug but no session returns 404 no session", %{conn: conn, vjt: vjt} do
      _ = setup_network(vjt, 9999, "azzurra")
      conn = delete(conn, "/networks/azzurra/channels/%23sniffo")
      assert json_response(conn, 404)["error"] == "no_session"
    end

    test "without Bearer returns 401" do
      conn = delete(Phoenix.ConnTest.build_conn(), "/networks/azzurra/channels/%23sniffo")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    # S29 C1: URL-encoded CRLF in :channel_id smuggles a second IRC
    # command into PART. Same controller-level rejection.
    test "channel_id with URL-encoded CRLF returns 400", %{conn: conn} do
      # %0A = LF, %0D = CR. "#chan%0AQUIT" decodes to "#chan\nQUIT".
      conn = delete(conn, "/networks/azzurra/channels/%23chan%0AQUIT")
      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end
end
