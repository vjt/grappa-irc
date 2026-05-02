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

  # S14: body-validation tests target /networks/azzurra/... without
  # building a per-test IRCServer; `Plugs.ResolveNetwork` requires a
  # credential first, so provision the binding without a real server.
  # `System.unique_integer/1` is monotonic across the whole BEAM run, so
  # under a full-suite run the counter blows past 65535 and the
  # `Networks.Server` port validation rejects the row. Clamp into the
  # ephemeral range with an offset that keeps unique-per-test behavior.
  defp ensure_azzurra_credential(vjt) do
    setup_network(vjt, 1024 + rem(System.unique_integer([:positive]), 60_000), "azzurra")
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

    # S14 oracle close: known slug + credential but no session running
    # surfaces with the SAME body as "unknown slug" + "no credential" so
    # a probing user cannot distinguish the three states. Internal tag
    # remains `:no_session` for operator-log tracing.
    test "known slug but no session returns 404 not_found (oracle close)",
         %{conn: conn, vjt: vjt} do
      _ = setup_network(vjt, 9999, "azzurra")
      # No session started — Session.send_join returns :no_session.

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    # S14 oracle close: a probing user posting JOIN against someone
    # else's network gets the SAME body as posting against an unknown
    # slug. Pre-fix this surfaced as :no_session (different body),
    # leaking network existence.
    test "POST against another user's network returns 404 not_found", %{conn: conn} do
      alice = user_fixture(name: "alice-#{u()}")
      {network, _} = network_with_server(port: 7101, slug: "alice-only-#{u()}")
      _ = credential_fixture(alice, network)
      # `conn` is bound to vjt (setup); vjt has no credential here.

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "without Bearer returns 401" do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "missing name returns 400", %{conn: conn, vjt: vjt} do
      _ = ensure_azzurra_credential(vjt)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "non-string name returns 400", %{conn: conn, vjt: vjt} do
      _ = ensure_azzurra_credential(vjt)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => 42})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "empty name returns 400", %{conn: conn, vjt: vjt} do
      _ = ensure_azzurra_credential(vjt)

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
    test "channel name with embedded CRLF returns 400", %{conn: conn, vjt: vjt} do
      _ = ensure_azzurra_credential(vjt)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{"name" => "#chan\r\nQUIT :pwn"})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "channel name failing IRC syntax (missing prefix) returns 400",
         %{conn: conn, vjt: vjt} do
      _ = ensure_azzurra_credential(vjt)

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

    # S14 oracle close: same as POST counterpart. :no_session collapses
    # to :not_found at the wire body so credential-without-session is
    # indistinguishable from no-credential and unknown-slug.
    test "known slug but no session returns 404 not_found (oracle close)",
         %{conn: conn, vjt: vjt} do
      _ = setup_network(vjt, 9999, "azzurra")
      conn = delete(conn, "/networks/azzurra/channels/%23sniffo")
      assert json_response(conn, 404)["error"] == "not_found"
    end

    # S14 oracle close: DELETE against another user's network.
    test "DELETE against another user's network returns 404 not_found", %{conn: conn} do
      alice = user_fixture(name: "alice-#{u()}")
      {network, _} = network_with_server(port: 7102, slug: "alice-only-#{u()}")
      _ = credential_fixture(alice, network)

      conn = delete(conn, "/networks/#{network.slug}/channels/%23sniffo")
      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "without Bearer returns 401" do
      conn = delete(Phoenix.ConnTest.build_conn(), "/networks/azzurra/channels/%23sniffo")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    # S29 C1: URL-encoded CRLF in :channel_id smuggles a second IRC
    # command into PART. Same controller-level rejection.
    test "channel_id with URL-encoded CRLF returns 400", %{conn: conn, vjt: vjt} do
      _ = ensure_azzurra_credential(vjt)
      # %0A = LF, %0D = CR. "#chan%0AQUIT" decodes to "#chan\nQUIT".
      conn = delete(conn, "/networks/azzurra/channels/%23chan%0AQUIT")
      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  # A5 close (P4-1): GET /networks/:net/channels composes the
  # credential autojoin list with `Grappa.Session.list_channels/2`
  # (session-tracked currently-joined set) into the wire shape
  # `[%{name, joined, source}]`. `:autojoin` wins on overlap (Q3).
  describe "GET /networks/:network_id/channels (A5 close)" do
    defp inject_members(pid, members) do
      :sys.replace_state(pid, fn state -> %{state | members: members} end)
    end

    test "channel in BOTH autojoin AND session: source: autojoin, joined: true",
         %{conn: conn, vjt: vjt} do
      {_, port} = start_server()
      slug = "az-bot-#{u()}"
      {network, _} = network_with_server(port: port, slug: slug)
      _ = credential_fixture(vjt, network, %{autojoin_channels: ["#italia"]})
      pid = start_session_for(vjt, network)

      inject_members(pid, %{"#italia" => %{"vjt" => []}})

      conn = get(conn, "/networks/#{slug}/channels")

      assert json_response(conn, 200) == [
               %{"name" => "#italia", "joined" => true, "source" => "autojoin"}
             ]

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "channel ONLY in autojoin (no session yet): source: autojoin, joined: false",
         %{conn: conn, vjt: vjt} do
      slug = "az-auto-#{u()}"
      {network, _} = network_with_server(port: 9999, slug: slug)
      _ = credential_fixture(vjt, network, %{autojoin_channels: ["#italia", "#azzurra"]})
      # No session started — Bootstrap not running here.

      conn = get(conn, "/networks/#{slug}/channels")

      assert json_response(conn, 200) == [
               %{"name" => "#azzurra", "joined" => false, "source" => "autojoin"},
               %{"name" => "#italia", "joined" => false, "source" => "autojoin"}
             ]
    end

    test "channel ONLY in session (joined post-boot, not in autojoin): source: joined, joined: true",
         %{conn: conn, vjt: vjt} do
      {_, port} = start_server()
      slug = "az-sess-#{u()}"
      {network, _} = network_with_server(port: port, slug: slug)
      _ = credential_fixture(vjt, network, %{autojoin_channels: []})
      pid = start_session_for(vjt, network)

      inject_members(pid, %{"#bnc" => %{"vjt" => []}})

      conn = get(conn, "/networks/#{slug}/channels")

      assert json_response(conn, 200) == [
               %{"name" => "#bnc", "joined" => true, "source" => "joined"}
             ]

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "merges autojoin + session: union sorted alphabetically",
         %{conn: conn, vjt: vjt} do
      {_, port} = start_server()
      slug = "az-merge-#{u()}"
      {network, _} = network_with_server(port: port, slug: slug)
      _ = credential_fixture(vjt, network, %{autojoin_channels: ["#italia", "#azzurra"]})
      pid = start_session_for(vjt, network)

      # #azzurra: in autojoin AND session (autojoin wins, joined: true).
      # #bnc: session only (source :joined).
      # #italia: autojoin only (joined: false).
      inject_members(pid, %{
        "#azzurra" => %{"vjt" => []},
        "#bnc" => %{"vjt" => []}
      })

      conn = get(conn, "/networks/#{slug}/channels")

      assert json_response(conn, 200) == [
               %{"name" => "#azzurra", "joined" => true, "source" => "autojoin"},
               %{"name" => "#bnc", "joined" => true, "source" => "joined"},
               %{"name" => "#italia", "joined" => false, "source" => "autojoin"}
             ]

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "returns empty list when credential has no autojoin and no session",
         %{conn: conn, vjt: vjt} do
      slug = "az-empty-#{u()}"
      {network, _} = network_with_server(port: 7001, slug: slug)
      _ = credential_fixture(vjt, network, %{autojoin_channels: []})

      conn = get(conn, "/networks/#{slug}/channels")
      assert json_response(conn, 200) == []
    end

    test "unknown network slug returns 404", %{conn: conn} do
      conn = get(conn, "/networks/no-such-net/channels")
      assert json_response(conn, 404)["error"] == "not_found"
    end

    # Per-user iso: known network exists but the authenticated user has
    # no credential on it → 404. Same wire shape as "unknown slug" so
    # we don't leak network existence to a probing user.
    test "known slug but user has no credential returns 404", %{conn: conn} do
      alice = user_fixture(name: "alice-#{u()}")
      {network, _} = network_with_server(port: 7002, slug: "alice-only-#{u()}")
      _ = credential_fixture(alice, network)
      # `conn` is bound to vjt (setup); vjt has no credential here.

      conn = get(conn, "/networks/#{network.slug}/channels")
      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "without Bearer returns 401" do
      conn = get(Phoenix.ConnTest.build_conn(), "/networks/azzurra/channels")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  describe "POST /networks/:network_id/channels/:channel_id/topic" do
    test "202 + ok body when session accepts the topic", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      slug = "az-topic-#{u()}"
      network = setup_network(vjt, port, slug)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{slug}/channels/%23italia/topic", %{"body" => "new topic"})

      assert json_response(conn, 202) == %{"ok" => true}

      {:ok, line} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "TOPIC "))
      assert line == "TOPIC #italia :new topic\r\n"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "400 on missing body", %{conn: conn, vjt: vjt} do
      slug = "az-topic-mb-#{u()}"
      _ = setup_network(vjt, 9999, slug)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{slug}/channels/%23italia/topic", %{})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "400 on empty body", %{conn: conn, vjt: vjt} do
      slug = "az-topic-eb-#{u()}"
      _ = setup_network(vjt, 9999, slug)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{slug}/channels/%23italia/topic", %{"body" => ""})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "404 no session", %{conn: conn, vjt: vjt} do
      slug = "az-topic-ns-#{u()}"
      _ = setup_network(vjt, 9999, slug)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{slug}/channels/%23italia/topic", %{"body" => "topic"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "400 on malformed channel", %{conn: conn, vjt: vjt} do
      slug = "az-topic-mc-#{u()}"
      _ = setup_network(vjt, 9999, slug)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{slug}/channels/no-prefix/topic", %{"body" => "topic"})

      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  defp u, do: System.unique_integer([:positive])
end
