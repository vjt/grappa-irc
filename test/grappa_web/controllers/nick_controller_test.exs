defmodule GrappaWeb.NickControllerTest do
  @moduledoc """
  REST surface for the `/nick <new>` slash command (P4-1, V9). Smoke-tests:
  happy path 202; iso boundary (cross-user 404); no-session 404;
  bad_request guards. V9 (visitor-parity cluster, 2026-05-15) lifts
  the visitor short-circuit — visitors now traverse the same path
  as users, with a per-(nick, network_slug) UNIQUE pre-check that
  surfaces as 409 nick_in_use when another visitor row already holds
  the target nick on the same network.

  `async: false` because Session uses singleton supervisors + Registry;
  see `Grappa.Session.ServerTest` for the same rationale.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Repo}
  alias Grappa.Visitors.Visitor

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
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
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

      {:ok, line} = IRCServer.wait_for_line(server, &(&1 == "NICK vjt-away\r\n"), 1_000)
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

    # V9 (visitor-parity cluster, 2026-05-15): visitor subjects can now
    # change nick. Q2(a) gate lifted — visitors traverse the same path
    # as users, gated by the same `(nick, network_slug)` UNIQUE that
    # backs anon-collision detection at login time.
    test "visitor subject — 202 + nick line upstream + DB nick rotated on echo", %{conn: _conn} do
      {server, port} = start_server()
      {visitor, network} = visitor_with_network(port, nick: "v9-#{System.unique_integer([:positive])}")
      session = visitor_session_fixture(visitor)
      pid = start_visitor_session_for(visitor, network)
      :ok = await_handshake(server)

      new_nick = "v9new-#{System.unique_integer([:positive])}"

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/nick", %{"nick" => new_nick})

      assert json_response(conn, 202) == %{"ok" => true}

      {:ok, line} = IRCServer.wait_for_line(server, &(&1 == "NICK #{new_nick}\r\n"), 1_000)
      assert line == "NICK #{new_nick}\r\n"

      # Simulate upstream NICK self-echo. The Session.Server's EventRouter
      # routes :nick on state.nick == old_nick, the visitor-side effect
      # rotates `visitors.nick` via the injected `visitor_nick_persister`
      # callback (mirror of `visitor_committer` for +r MODE).
      :ok = IRCServer.feed(server, ":#{visitor.nick}!u@h NICK #{new_nick}\r\n")

      # Wait for the EventRouter delegate path to land — the per-channel
      # broadcast + DB write happen synchronously inside the Server's
      # handle_info reduction. Polling keeps the test honest under
      # mailbox latency.
      assert_eventually(fn ->
        case Repo.get(Visitor, visitor.id) do
          %Visitor{nick: ^new_nick, id: id} when id == visitor.id -> true
          _ -> false
        end
      end)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "visitor subject — 409 nick_in_use when another visitor row holds the target nick on the same network",
         %{conn: _conn} do
      {server, port} = start_server()
      {visitor, network} = visitor_with_network(port, nick: "v9a-#{System.unique_integer([:positive])}")
      session = visitor_session_fixture(visitor)

      # Squat the target nick with ANOTHER visitor row on the same
      # network. The pre-check at the controller boundary surfaces 409
      # before the upstream NICK frame is sent.
      target_nick = "v9b-#{System.unique_integer([:positive])}"
      _ = visitor_fixture(nick: target_nick, network_slug: network.slug)

      pid = start_visitor_session_for(visitor, network)
      :ok = await_handshake(server)
      # Snapshot lines after handshake: NICK + USER are emitted at
      # connect-time. Asserting "no NEW NICK line" against a fresh
      # snapshot is the right granularity — `wait_for_line/3` matches
      # buffered lines too, so a follow-up wait would see the
      # handshake NICK and pass the 409 test by accident.
      pre_nick_count = nick_lines_count(server)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/nick", %{"nick" => target_nick})

      assert json_response(conn, 409) == %{"error" => "nick_in_use"}

      # Brief grace window for any in-flight send to land before counting.
      Process.sleep(50)
      assert nick_lines_count(server) == pre_nick_count

      # DB unchanged.
      assert %Visitor{nick: nick} = Repo.get(Visitor, visitor.id)
      assert nick == visitor.nick

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "visitor subject — 400 malformed_nick rejected at the boundary", %{conn: _conn} do
      slug = "az-nick-vmalformed-#{System.unique_integer([:positive])}"
      {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: slug})
      {_, session} = visitor_and_session_with_credential(network_slug: slug)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{slug}/nick", %{"nick" => "9bad"})

      assert json_response(conn, 400) == %{"error" => "malformed_nick"}
    end
  end

  defp assert_eventually(fun, timeout \\ 1_000, interval \\ 25) do
    deadline = System.monotonic_time(:millisecond) + timeout
    assert_eventually_loop(fun, deadline, interval)
  end

  defp assert_eventually_loop(fun, deadline, interval) do
    if fun.() do
      :ok
    else
      now = System.monotonic_time(:millisecond)

      if now >= deadline do
        flunk("assert_eventually: predicate never became true within budget")
      else
        Process.sleep(interval)
        assert_eventually_loop(fun, deadline, interval)
      end
    end
  end

  defp nick_lines_count(server) do
    server
    |> IRCServer.sent_lines()
    |> Enum.count(&String.starts_with?(&1, "NICK "))
  end
end
