defmodule GrappaWeb.CommonChannelsControllerTest do
  @moduledoc """
  REST surface for channels in common with a nick (issue 2449).
  Smoke-tests: happy path across two channels, case-folded query,
  unseeded-channel exclusion, QUIT/NICK tracking, iso boundary
  (cross-user 404), no-session 404, missing-nick 400.

  `async: false` because Session uses singleton supervisors + Registry;
  see `Grappa.Session.ServerTest` for the same rationale.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Session}

  defp setup_session(vjt, port, slug, autojoin_channels \\ ["#test"]) do
    {network, _} = network_with_server(port: port, slug: slug)

    _ =
      credential_fixture(vjt, network, %{
        nick: "grappa-test",
        autojoin_channels: autojoin_channels
      })

    pid = start_session_for(vjt, network)
    {network, pid}
  end

  # PING/PONG flush — same trick as the session tests, but with a UNIQUE
  # token per call: `IRCServer.wait_for_line/3` answers from its buffered
  # lines WITHOUT consuming them, so a repeated `PING :flush` matches the
  # FIRST flush's stale PONG and returns before the session has processed
  # the lines fed since. A unique token forces a real round trip.
  defp flush(server) do
    token = "flush-#{System.unique_integer([:positive])}"
    IRCServer.feed(server, "PING :#{token}\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :#{token}\r\n"), 1_000)
  end

  defp seed_channel(server, channel, members_line) do
    IRCServer.feed(server, ":grappa-test!u@h JOIN :#{channel}\r\n")
    IRCServer.feed(server, ":irc 353 grappa-test = #{channel} :#{members_line}\r\n")
    IRCServer.feed(server, ":irc 366 grappa-test #{channel} :End\r\n")
  end

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  describe "GET /networks/:network_id/common-channels?nick=<nick>" do
    test "returns sorted channels shared with the nick", %{conn: conn, vjt: vjt} do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug, ["#test", "#other"])

      :ok = IRCServer.await_handshake(server, 1_000)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)

      seed_channel(server, "#test", "@grappa-test +alice bob")
      seed_channel(server, "#other", "@grappa-test alice carol")
      flush(server)

      # alice is in both channels; bob only in #test; carol only in #other.
      conn = get(conn, "/networks/#{slug}/common-channels?nick=alice")
      assert json_response(conn, 200) == %{"channels" => ["#other", "#test"]}

      conn = get(conn, "/networks/#{slug}/common-channels?nick=bob")
      assert json_response(conn, 200) == %{"channels" => ["#test"]}

      conn = get(conn, "/networks/#{slug}/common-channels?nick=carol")
      assert json_response(conn, 200) == %{"channels" => ["#other"]}

      # dave is in neither — empty list, not an error.
      conn = get(conn, "/networks/#{slug}/common-channels?nick=dave")
      assert json_response(conn, 200) == %{"channels" => []}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "nick query is case-folded with the network casemapping", %{
      conn: conn,
      vjt: vjt
    } do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug)

      :ok = IRCServer.await_handshake(server, 1_000)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)

      seed_channel(server, "#test", "@grappa-test +alice")
      flush(server)

      conn = get(conn, "/networks/#{slug}/common-channels?nick=ALICE")
      assert json_response(conn, 200) == %{"channels" => ["#test"]}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "joined-but-unseeded channel is excluded, not reported as not-shared",
         %{conn: conn, vjt: vjt} do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug, ["#test", "#other"])

      :ok = IRCServer.await_handshake(server, 1_000)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)

      seed_channel(server, "#test", "@grappa-test +alice")
      # Self-JOIN echo for #other lands but NO 353/366 — the channel is
      # in state.members (own nick seeded) but never NAMES-completed,
      # so alice's presence there is unknowable and must not count.
      IRCServer.feed(server, ":grappa-test!u@h JOIN :#other\r\n")
      flush(server)

      conn = get(conn, "/networks/#{slug}/common-channels?nick=alice")
      assert json_response(conn, 200) == %{"channels" => ["#test"]}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "QUIT and NICK of the peer update the answer", %{conn: conn, vjt: vjt} do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug)

      :ok = IRCServer.await_handshake(server, 1_000)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)

      seed_channel(server, "#test", "@grappa-test +alice bob")
      flush(server)

      conn = get(conn, "/networks/#{slug}/common-channels?nick=alice")
      assert json_response(conn, 200) == %{"channels" => ["#test"]}

      # alice renames to alicia: the old nick answers empty, the new one
      # answers the channel.
      IRCServer.feed(server, ":alice!u@h NICK :alicia\r\n")
      flush(server)

      conn = get(conn, "/networks/#{slug}/common-channels?nick=alice")
      assert json_response(conn, 200) == %{"channels" => []}

      conn = get(conn, "/networks/#{slug}/common-channels?nick=alicia")
      assert json_response(conn, 200) == %{"channels" => ["#test"]}

      # alicia quits: gone from every channel.
      IRCServer.feed(server, ":alicia!u@h QUIT :bye\r\n")
      flush(server)

      conn = get(conn, "/networks/#{slug}/common-channels?nick=alicia")
      assert json_response(conn, 200) == %{"channels" => []}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "400 for missing or empty nick", %{conn: conn, vjt: vjt} do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug)

      :ok = IRCServer.await_handshake(server, 1_000)

      conn = get(conn, "/networks/#{slug}/common-channels")
      assert json_response(conn, 400) == %{"error" => "bad_request"}

      conn = get(conn, "/networks/#{slug}/common-channels?nick=%20%20")
      assert json_response(conn, 400) == %{"error" => "bad_request"}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "404 for cross-user network access (per-user iso)", %{conn: _conn, vjt: vjt} do
      {_, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug)

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
      {network, pid} = setup_session(vjt, port, slug)

      :ok = Session.stop_session({:user, vjt.id}, network.id)
      refute Process.alive?(pid)

      conn = get(conn, "/networks/#{slug}/common-channels?nick=alice")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end
end
