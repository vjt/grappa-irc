defmodule GrappaWeb.MembersControllerTest do
  @moduledoc """
  REST surface for the per-channel nick list (E1 task 20). Smoke-tests:
  happy path with mIRC-sorted snapshot, iso boundary (cross-user 404),
  and no-session 404.

  `async: false` because Session uses singleton supervisors + Registry;
  see `Grappa.Session.ServerTest` for the same rationale.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Session}

  defp welcome_handler do
    fn state, line ->
      if String.starts_with?(line, "USER ") do
        {:reply, ":irc 001 grappa-test :Welcome\r\n", state}
      else
        {:reply, nil, state}
      end
    end
  end

  defp start_server do
    {:ok, server} = IRCServer.start_link(welcome_handler())
    {server, IRCServer.port(server)}
  end

  defp setup_session_with_members(vjt, port, slug) do
    {network, _} = network_with_server(port: port, slug: slug)

    _ =
      credential_fixture(vjt, network, %{
        nick: "grappa-test",
        autojoin_channels: ["#test"]
      })

    pid = start_session_for(vjt, network)
    {network, pid}
  end

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  describe "GET /networks/:network_id/channels/:channel_id/members" do
    test "returns members in mIRC sort order", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session_with_members(vjt, port, slug)

      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#test\r\n")
      IRCServer.feed(server, ":irc 353 grappa-test = #test :@grappa-test +alice bob\r\n")
      IRCServer.feed(server, ":irc 366 grappa-test #test :End\r\n")

      # PING/PONG flush — same trick as session tests.
      IRCServer.feed(server, "PING :flush\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"))

      conn = get(conn, "/networks/#{slug}/channels/%23test/members")

      assert json_response(conn, 200) == %{
               "members" => [
                 %{"nick" => "grappa-test", "modes" => ["@"]},
                 %{"nick" => "alice", "modes" => ["+"]},
                 %{"nick" => "bob", "modes" => []}
               ]
             }

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "404 for cross-user network access (per-user iso)", %{conn: _conn, vjt: vjt} do
      {_, port} = start_server()
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session_with_members(vjt, port, slug)

      stranger = user_fixture(name: "stranger-#{System.unique_integer([:positive])}")
      stranger_session = session_fixture(stranger)
      stranger_conn = put_bearer(Phoenix.ConnTest.build_conn(), stranger_session.id)

      conn = get(stranger_conn, "/networks/#{slug}/channels/%23test/members")

      assert json_response(conn, 404) == %{"error" => "not_found"}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "404 when no session is registered for (user, network)",
         %{conn: conn, vjt: vjt} do
      {_, port} = start_server()
      slug = "az-#{System.unique_integer([:positive])}"
      {network, pid} = setup_session_with_members(vjt, port, slug)

      :ok = Session.stop_session({:user, vjt.id}, network.id)
      refute Process.alive?(pid)

      conn = get(conn, "/networks/#{slug}/channels/%23test/members")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    # Task 30: visitor session reads members through the same Session API
    # via :current_subject dispatch. Pin the controller threads
    # {:visitor, _} correctly — handshake + session interaction is the
    # same Session.list_members boundary user-side already exercises.
    test "visitor subject — returns members for visitor's network", %{conn: _conn} do
      {server, port} = start_server()
      {visitor, network} = visitor_with_network(port)
      session = visitor_session_fixture(visitor)
      pid = start_visitor_session_for(visitor, network)

      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))

      IRCServer.feed(server, ":#{visitor.nick}!u@h JOIN :#test\r\n")
      IRCServer.feed(server, ":irc 353 #{visitor.nick} = #test :@#{visitor.nick} +alice\r\n")
      IRCServer.feed(server, ":irc 366 #{visitor.nick} #test :End\r\n")
      IRCServer.feed(server, "PING :flush\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"))

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> get("/networks/#{network.slug}/channels/%23test/members")

      body = json_response(conn, 200)
      nicks = Enum.map(body["members"], & &1["nick"])
      assert visitor.nick in nicks
      assert "alice" in nicks

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end
end
