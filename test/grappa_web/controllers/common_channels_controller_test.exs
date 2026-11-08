defmodule GrappaWeb.CommonChannelsControllerTest do
  @moduledoc """
  REST surface for channels in common with a peer (issue 2449).
  Smoke-tests: happy path with sorted seeded-only channels, the
  unseeded-channel exclusion, the missing-nick 400, iso boundary
  (cross-user 404), and no-session 404.

  `async: false` because Session uses singleton supervisors + Registry;
  see `Grappa.Session.ServerTest` for the same rationale.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Session}

  defp setup_session_with_members(vjt, port, slug) do
    {network, _} = network_with_server(port: port, slug: slug)

    _ =
      credential_fixture(vjt, network, %{
        nick: "grappa-test",
        autojoin_channels: ["#one", "#two", "#three"]
      })

    pid = start_session_for(vjt, network)
    {network, pid}
  end

  # Seeds #one (alice, bob) and #two (alice) via 353/366, and #three
  # (alice, carol) via 353 WITHOUT 366 — joined but unseeded, so it
  # must never appear in a common-channels answer.
  defp seed_channels(server) do
    :ok = IRCServer.await_handshake(server, 1_000)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)

    IRCServer.feed(server, ":grappa-test!u@h JOIN :#one\r\n")
    IRCServer.feed(server, ":irc 353 grappa-test = #one :grappa-test alice bob\r\n")
    IRCServer.feed(server, ":irc 366 grappa-test #one :End\r\n")
    IRCServer.feed(server, ":grappa-test!u@h JOIN :#two\r\n")
    IRCServer.feed(server, ":irc 353 grappa-test = #two :grappa-test alice\r\n")
    IRCServer.feed(server, ":irc 366 grappa-test #two :End\r\n")
    IRCServer.feed(server, ":grappa-test!u@h JOIN :#three\r\n")
    IRCServer.feed(server, ":irc 353 grappa-test = #three :grappa-test alice carol\r\n")

    # PING/PONG flush — same trick as session tests.
    IRCServer.feed(server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)
  end

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  describe "GET /networks/:network_id/common-channels?nick=<nick>" do
    test "returns the sorted seeded channels shared with the nick", %{
      conn: conn,
      vjt: vjt
    } do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session_with_members(vjt, port, slug)

      seed_channels(server)

      conn = get(conn, "/networks/#{slug}/common-channels?nick=alice")

      assert json_response(conn, 200) == %{"channels" => ["#one", "#two"]}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "unseeded channels are excluded, unknown nicks answer empty", %{
      conn: conn,
      vjt: vjt
    } do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session_with_members(vjt, port, slug)

      seed_channels(server)

      # carol is ONLY on #three, which never saw 366 — excluded, so
      # the answer is empty, not ["#three"].
      assert json_response(get(conn, "/networks/#{slug}/common-channels?nick=carol"), 200) ==
               %{"channels" => []}

      # A nick nobody holds shares nothing — same shape, not an error.
      assert json_response(get(conn, "/networks/#{slug}/common-channels?nick=nobody"), 200) ==
               %{"channels" => []}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "400 without the nick query param", %{conn: conn, vjt: vjt} do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session_with_members(vjt, port, slug)

      seed_channels(server)

      assert json_response(get(conn, "/networks/#{slug}/common-channels"), 400) ==
               %{"error" => "bad_request"}

      assert json_response(get(conn, "/networks/#{slug}/common-channels?nick=%20%20"), 400) ==
               %{"error" => "bad_request"}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "404 for cross-user network access (per-user iso)", %{conn: _conn, vjt: vjt} do
      {_, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session_with_members(vjt, port, slug)

      stranger = user_fixture(name: "stranger-#{System.unique_integer([:positive])}")
      stranger_session = session_fixture(stranger)
      stranger_conn = put_bearer(Phoenix.ConnTest.build_conn(), stranger_session.id)

      conn = get(stranger_conn, "/networks/#{slug}/common-channels?nick=alice")

      assert json_response(conn, 404) == %{"error" => "not_found"}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "404 when no session is registered for (user, network)",
         %{conn: conn, vjt: vjt} do
      {_, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {network, pid} = setup_session_with_members(vjt, port, slug)

      :ok = Session.stop_session({:user, vjt.id}, network.id)
      refute Process.alive?(pid)

      conn = get(conn, "/networks/#{slug}/common-channels?nick=alice")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end
end
