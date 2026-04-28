defmodule GrappaWeb.NickControllerTest do
  @moduledoc """
  REST surface for the `/nick <new>` slash command (P4-1). Smoke-tests:
  happy path 202; iso boundary (cross-user 404); no-session 404;
  bad_request guards.

  `async: false` because Session uses singleton supervisors + Registry;
  see `Grappa.Session.ServerTest` for the same rationale.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.IRCServer

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  defp setup_network(vjt, port, slug) do
    {network, _} = network_with_server(port: port, slug: slug)
    _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
    network
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
    :ok
  end

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  describe "POST /networks/:network_id/nick" do
    test "202 + ok body when nick line goes upstream", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      slug = "az-nick-#{System.unique_integer([:positive])}"
      network = setup_network(vjt, port, slug)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{slug}/nick", %{"nick" => "vjt-away"})

      assert json_response(conn, 202) == %{"ok" => true}

      {:ok, line} = IRCServer.wait_for_line(server, &(&1 == "NICK vjt-away\r\n"))
      assert line == "NICK vjt-away\r\n"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "400 on missing nick", %{conn: conn, vjt: vjt} do
      slug = "az-nick-mb-#{System.unique_integer([:positive])}"
      _ = setup_network(vjt, 9999, slug)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{slug}/nick", %{})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "400 on empty nick", %{conn: conn, vjt: vjt} do
      slug = "az-nick-eb-#{System.unique_integer([:positive])}"
      _ = setup_network(vjt, 9999, slug)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{slug}/nick", %{"nick" => ""})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "404 when no session is registered for (user, network)", %{conn: conn, vjt: vjt} do
      slug = "az-nick-ns-#{System.unique_integer([:positive])}"
      _ = setup_network(vjt, 9999, slug)
      # No start_session_for — Bootstrap not running here.

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{slug}/nick", %{"nick" => "newnick"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "without Bearer returns 401" do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/nick", %{"nick" => "newnick"})

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end
end
