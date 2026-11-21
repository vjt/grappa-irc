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
  #
  # 5s patience (not the 1s the sibling tests use): session startup +
  # the PING round trip exceed 1s under a loaded sandbox, and a timed-out
  # wait fails the test without ever exercising the endpoint. A genuine
  # hang still fails loudly, just 4s later.
  defp flush(server) do
    token = "flush-#{System.unique_integer([:positive])}"
    IRCServer.feed(server, "PING :#{token}\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :#{token}\r\n"), 5_000)
  end

  defp seed_channel(server, channel, members_line) do
    IRCServer.feed(server, ":grappa-test!u@h JOIN :#{channel}\r\n")
    IRCServer.feed(server, ":irc 353 grappa-test = #{channel} :#{members_line}\r\n")
    IRCServer.feed(server, ":irc 366 grappa-test #{channel} :End\r\n")
  end

  # GET + decode in one step, so no test rebinds `conn` (credo flags a
  # variable declared more than once in one scope).
  defp get_common(conn, slug, nick) do
    conn
    |> get("/networks/#{slug}/common-channels?nick=#{nick}")
    |> json_response(200)
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

      :ok = IRCServer.await_handshake(server, 5_000)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 5_000)

      seed_channel(server, "#test", "@grappa-test +alice bob")
      seed_channel(server, "#other", "@grappa-test alice carol")
      flush(server)

      # alice is in both channels; bob only in #test; carol only in #other.
      assert get_common(conn, slug, "alice") == %{"channels" => ["#other", "#test"]}
      assert get_common(conn, slug, "bob") == %{"channels" => ["#test"]}
      assert get_common(conn, slug, "carol") == %{"channels" => ["#other"]}

      # dave is in neither — empty list, not an error.
      assert get_common(conn, slug, "dave") == %{"channels" => []}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "nick query is case-folded with the network casemapping", %{
      conn: conn,
      vjt: vjt
    } do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug)

      :ok = IRCServer.await_handshake(server, 5_000)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 5_000)

      seed_channel(server, "#test", "@grappa-test +alice")
      flush(server)

      assert get_common(conn, slug, "ALICE") == %{"channels" => ["#test"]}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "joined-but-unseeded channel is excluded, not reported as not-shared",
         %{conn: conn, vjt: vjt} do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug, ["#test", "#other"])

      :ok = IRCServer.await_handshake(server, 5_000)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 5_000)

      seed_channel(server, "#test", "@grappa-test +alice")
      # Self-JOIN echo for #other lands but NO 353/366 — the channel is
      # in state.members (own nick seeded) but never NAMES-completed,
      # so alice's presence there is unknowable and must not count.
      IRCServer.feed(server, ":grappa-test!u@h JOIN :#other\r\n")
      flush(server)

      assert get_common(conn, slug, "alice") == %{"channels" => ["#test"]}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "QUIT and NICK of the peer update the answer", %{conn: conn, vjt: vjt} do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug)

      :ok = IRCServer.await_handshake(server, 5_000)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 5_000)

      seed_channel(server, "#test", "@grappa-test +alice bob")
      flush(server)

      assert get_common(conn, slug, "alice") == %{"channels" => ["#test"]}

      # alice renames to alicia: the old nick answers empty, the new one
      # answers the channel.
      IRCServer.feed(server, ":alice!u@h NICK :alicia\r\n")
      flush(server)

      assert get_common(conn, slug, "alice") == %{"channels" => []}
      assert get_common(conn, slug, "alicia") == %{"channels" => ["#test"]}

      # alicia quits: gone from every channel.
      IRCServer.feed(server, ":alicia!u@h QUIT :bye\r\n")
      flush(server)

      assert get_common(conn, slug, "alicia") == %{"channels" => []}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "400 for missing or empty nick", %{conn: conn, vjt: vjt} do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug)

      :ok = IRCServer.await_handshake(server, 5_000)

      missing =
        conn |> get("/networks/#{slug}/common-channels") |> json_response(400)

      assert missing == %{"error" => "bad_request"}

      blank =
        conn
        |> get("/networks/#{slug}/common-channels?nick=%20%20")
        |> json_response(400)

      assert blank == %{"error" => "bad_request"}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "404 for cross-user network access (per-user iso)", %{conn: _conn, vjt: vjt} do
      {_, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {_, pid} = setup_session(vjt, port, slug)

      stranger = user_fixture(name: "stranger-#{System.unique_integer([:positive])}")
      stranger_session = session_fixture(stranger)
      stranger_conn = put_bearer(Phoenix.ConnTest.build_conn(), stranger_session.id)

      resp =
        stranger_conn
        |> get("/networks/#{slug}/common-channels?nick=alice")
        |> json_response(404)

      assert resp == %{"error" => "not_found"}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "404 when no session is registered for (user, network)",
         %{conn: conn, vjt: vjt} do
      {_, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
      slug = "az-#{System.unique_integer([:positive])}"
      {network, pid} = setup_session(vjt, port, slug)

      :ok = Session.stop_session({:user, vjt.id}, network.id)
      refute Process.alive?(pid)

      resp =
        conn
        |> get("/networks/#{slug}/common-channels?nick=alice")
        |> json_response(404)

      assert resp == %{"error" => "not_found"}
    end
  end
end
