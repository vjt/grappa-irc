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
  alias Grappa.Networks.Credentials
  alias Grappa.PubSub.Topic
  alias Grappa.Session.WindowState

  setup %{conn: conn} do
    # Pre-bind "vjt" + "azzurra" credential so Session.Server.init can
    # resolve the row at boot. The bearer-token session attaches the
    # same vjt to conn.assigns.current_user_id.
    vjt = user_fixture(name: "vjt-#{u()}")
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
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
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
               IRCServer.wait_for_line(server, &(&1 == "JOIN #sniffo\r\n"), 1_000)

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

    # UX-4 bucket F: +k channel-key support — body accepts optional
    # `"key": "<key>"` field. Threaded through to the upstream JOIN
    # frame as `JOIN <chan> <key>\r\n` when present.
    test "with active session + key sends JOIN with key upstream",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels", %{
          "name" => "#priv",
          "key" => "s3cret"
        })

      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "JOIN #priv s3cret\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #priv s3cret\r\n"), 1_000)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "key field with CRLF returns 400 (bucket F)",
         %{conn: conn, vjt: vjt} do
      _ = ensure_azzurra_credential(vjt)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{
          "name" => "#chan",
          "key" => "k\r\nQUIT"
        })

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "key field with embedded space returns 400 (bucket F)",
         %{conn: conn, vjt: vjt} do
      _ = ensure_azzurra_credential(vjt)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{
          "name" => "#chan",
          "key" => "key with space"
        })

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "empty-string key sends the no-key JOIN form (bucket F)",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port)
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels", %{
          "name" => "#sniffo",
          "key" => ""
        })

      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "JOIN #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #sniffo\r\n"), 1_000)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "key field as non-string type returns 400 (bucket F)",
         %{conn: conn, vjt: vjt} do
      _ = ensure_azzurra_credential(vjt)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels", %{
          "name" => "#chan",
          "key" => 42
        })

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
               IRCServer.wait_for_line(server, &(&1 == "PART #sniffo\r\n"), 1_000)

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

    # BUG5a: DELETE also removes the channel from autojoin_channels so that
    # GET /channels returns it as absent (not as joined: false). Without this
    # fix, cicchetto's channels_changed refetch would return the channel with
    # joined: false and the sidebar would keep showing it as a parted entry.
    test "removes channel from autojoin_channels after PART", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      {network, _} = network_with_server(port: port, slug: "az-bug5a-#{u()}")
      _ = credential_fixture(vjt, network, %{autojoin_channels: ["#grappa", "#other"]})
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      conn = delete(conn, "/networks/#{network.slug}/channels/%23grappa")
      assert json_response(conn, 202) == %{"ok" => true}

      # Reload credential from DB and assert #grappa is gone from autojoin.
      reloaded = Credentials.get_credential!(vjt, network)
      assert reloaded.autojoin_channels == ["#other"]
      refute "#grappa" in reloaded.autojoin_channels

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "channel not in autojoin_channels is a no-op on the autojoin list after PART",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      {network, _} = network_with_server(port: port, slug: "az-bug5a-noop-#{u()}")
      _ = credential_fixture(vjt, network, %{autojoin_channels: ["#other"]})
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # #grappa is NOT in autojoin_channels — DELETE should still succeed and
      # leave the list unchanged.
      conn = delete(conn, "/networks/#{network.slug}/channels/%23grappa")
      assert json_response(conn, 202) == %{"ok" => true}

      reloaded = Credentials.get_credential!(vjt, network)
      assert reloaded.autojoin_channels == ["#other"]

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    # M16 regression (REV-D 2026-05-22): pre-fix the controller logged a
    # warning + returned 202 even when `remove_autojoin_channel` failed.
    # Next reconnect re-joined the channel the user explicitly left,
    # invisibly. The fix propagates `{:error, _}` through `with` so
    # FallbackController surfaces 404 for `:not_found`. Synthesize the
    # error path by deleting the credential row between the PART send
    # (which succeeds against the live session) and the autojoin update
    # (which now misses the row). Lookup-then-update gap is the natural
    # race window where the M16 propagation matters most.
    test "autojoin removal failure propagates as 404 instead of silently 202 (M16)",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      {network, _} = network_with_server(port: port, slug: "az-m16-#{u()}")
      _ = credential_fixture(vjt, network, %{autojoin_channels: ["#grappa"]})
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # Race-synthesis: delete the credential row out from under the
      # request after the session is up. The controller's
      # `Session.send_part` routes via subject + network_id (live state,
      # not credential-table lookup), so the PART still goes out; then
      # `remove_autojoin_channel` returns `{:error, :not_found}`. Pre-M16
      # this was a silent 202 + log line. Post-M16 the 404 surface
      # tells cic the persistence side of "leave channel" failed.
      _ = Grappa.Repo.delete_all(Grappa.Networks.Credential)

      conn = delete(conn, "/networks/#{network.slug}/channels/%23grappa")

      assert json_response(conn, 404)["error"] == "not_found"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    # UX-4 bucket H — PART-fail still closes window. The cast handler
    # eagerly cleans up local state (members + topics + channel_modes +
    # channels_created + userhost_cache + window_state) regardless of
    # whether upstream eventually ACKs or rejects (442 ERR_NOTONCHANNEL /
    # 403 ERR_NOSUCHCHANNEL). The `channels_changed` broadcast fires
    # unconditionally so cic's channelsBySlug refetch triggers and the
    # sidebar entry disappears.
    test "eager PART of a never-joined channel drops window_state + emits channels_changed",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      {network, _} = network_with_server(port: port, slug: "az-h-eager-#{u()}")
      _ = credential_fixture(vjt, network, %{autojoin_channels: []})

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.user(vjt.name)
        )

      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # Seed window_state[#unjoined] = :failed (e.g. prior +i JOIN rejection)
      # so the eager wipe has something to clear. Without this seed the
      # idempotency arm fires and the test asserts a no-op.
      :sys.replace_state(pid, fn s ->
        %{
          s
          | window_state:
              WindowState.set_failed(
                s.window_state,
                "#unjoined",
                "+i (invite only)",
                473
              )
        }
      end)

      conn = delete(conn, "/networks/#{network.slug}/channels/%23unjoined")
      assert json_response(conn, 202) == %{"ok" => true}

      # Cast → eager cleanup runs → channels_changed broadcast fires.
      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: :channels_changed}
                     },
                     1_000

      # Window_state entry cleared even though no upstream PART echo
      # arrived (the PART line itself goes out per the wire assertion below,
      # but our fake IRC server is a passthrough — no 442/403 / PART echo).
      state = :sys.get_state(pid)
      assert WindowState.state_of(state.window_state, "#unjoined") == nil

      assert {:ok, "PART #unjoined\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "PART #unjoined\r\n"), 1_000)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "eager PART of a joined channel drops members + window_state immediately (don't wait for echo)",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      {network, _} = network_with_server(port: port, slug: "az-h-joined-#{u()}")
      _ = credential_fixture(vjt, network, %{autojoin_channels: []})

      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # Seed state.members[#chan] + window_state[#chan]=:joined to mirror a
      # post-JOIN session. The eager-wipe path must clean both even though
      # the upstream PART echo (handled by EventRouter's self-PART arm)
      # would also drop them — bucket H closes the gap when upstream rejects.
      :sys.replace_state(pid, fn s ->
        %{
          s
          | members: Map.put(s.members, "#joined", %{"vjt" => [], "alice" => []}),
            window_state: WindowState.set_joined(s.window_state, "#joined"),
            topics: Map.put(s.topics, "#joined", %{topic: "ciao", by: "x", at: 1})
        }
      end)

      conn = delete(conn, "/networks/#{network.slug}/channels/%23joined")
      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "PART #joined\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "PART #joined\r\n"), 1_000)

      state = :sys.get_state(pid)
      refute Map.has_key?(state.members, "#joined")
      refute Map.has_key?(state.topics, "#joined")
      assert WindowState.state_of(state.window_state, "#joined") == nil

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    # #87 root cause (2026-06-26): the `send_part` cast dropped the channel
    # from live `state.members` + broadcast `channels_changed`, but NEVER
    # persisted the post-PART snapshot to `last_joined_channels` — it called
    # `broadcast_channels_changed/1` directly, bypassing the only persister
    # call site (`maybe_broadcast_channels_changed/2`). On reconnect,
    # `merge_autojoin(autojoin_channels, last_joined_channels)` re-derived the
    # stale membership and rejoined a channel the operator explicitly left.
    # The fix routes the snapshot persist through the same per-subject
    # persister the organic membership-change path uses.
    test "PART persists last_joined_channels snapshot minus the parted channel (reconnect-rejoin fix)",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      {network, _} = network_with_server(port: port, slug: "az-lastjoined-#{u()}")
      _ = credential_fixture(vjt, network, %{autojoin_channels: []})
      pid = start_session_for(vjt, network)
      :ok = await_handshake(server)

      # Seed two live-joined channels synchronously; last_joined starts empty.
      :sys.replace_state(pid, fn s ->
        %{s | members: s.members |> Map.put("#a", %{"vjt" => []}) |> Map.put("#b", %{"vjt" => []})}
      end)

      conn = delete(conn, "/networks/#{network.slug}/channels/%23a")
      assert json_response(conn, 202) == %{"ok" => true}

      # PART line is emitted by the cast AFTER cleanup + snapshot persist, so
      # observing it proves the DB write already happened.
      assert {:ok, "PART #a\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "PART #a\r\n"), 1_000)

      reloaded = Credentials.get_credential!(vjt, network)
      assert reloaded.last_joined_channels == ["#b"]

      :ok = GenServer.stop(pid, :normal, 1_000)
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

      {:ok, line} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "TOPIC "), 1_000)
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

  # Task 30: visitor-subject branch. The Session API takes a subject
  # tuple already (LANDED in tasks 19/20); this test pins that the
  # controller actions read `:current_subject` from the conn assigns and
  # thread it through correctly. The autojoin source for visitors is
  # `Visitors.list_autojoin_channels/1` — `visitors.last_joined_channels`
  # JSON column — mirror of `Credential.last_joined_channels`
  # for users.
  describe "visitor subject — channel surface" do
    test "GET index returns visitor's autojoin channels (no session)",
         %{conn: _conn} do
      {visitor, network} = visitor_with_network(7301)
      _ = visitor_channel_fixture(visitor, network.slug, "#italia")
      _ = visitor_channel_fixture(visitor, network.slug, "#azzurra")
      session = visitor_session_fixture(visitor)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> get("/networks/#{network.slug}/channels")

      assert json_response(conn, 200) == [
               %{"name" => "#azzurra", "joined" => false, "source" => "autojoin"},
               %{"name" => "#italia", "joined" => false, "source" => "autojoin"}
             ]
    end

    test "POST JOIN sends upstream as the visitor session and returns 202",
         %{conn: _conn} do
      {server, port} = start_server()
      {visitor, network} = visitor_with_network(port)
      session = visitor_session_fixture(visitor)
      pid = start_visitor_session_for(visitor, network)
      :ok = await_handshake(server)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{network.slug}/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "JOIN #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #sniffo\r\n"), 1_000)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "DELETE PART sends upstream as the visitor session and returns 202",
         %{conn: _conn} do
      {server, port} = start_server()
      {visitor, network} = visitor_with_network(port)
      session = visitor_session_fixture(visitor)
      pid = start_visitor_session_for(visitor, network)
      :ok = await_handshake(server)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> delete("/networks/#{network.slug}/channels/%23sniffo")

      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "PART #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "PART #sniffo\r\n"), 1_000)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "POST against a network the visitor isn't pinned to returns 404 (oracle close)",
         %{conn: _conn} do
      {visitor, _} = visitor_with_network(7302)
      {other_network, _} = network_with_server(port: 7303, slug: "other-#{u()}")
      session = visitor_session_fixture(visitor)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/networks/#{other_network.slug}/channels", %{"name" => "#sniffo"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    # #87 regression (alk on #italia, 2026-06-26) — case (a): a visitor
    # live-joined to a channel parts it via the cic × (DELETE). The visitor's
    # autojoin source is `visitors.last_joined_channels` (NOT a credential
    # autojoin list), so unless the PART path rewrites that snapshot, the
    # `GET /channels` union keeps returning the channel as `source: autojoin,
    # joined: false` and the cic tab never dismisses (re-× → 442). The
    # session-level snapshot persist (subject-agnostic) closes this for
    # visitors exactly as it does for users.
    test "DELETE PART of a live-joined channel drops it from GET /channels + last_joined (case a)",
         %{conn: _conn} do
      {server, port} = start_server()
      {visitor, network} = visitor_with_network(port)
      _ = visitor_channel_fixture(visitor, network.slug, "#italia")
      session = visitor_session_fixture(visitor)
      pid = start_visitor_session_for(visitor, network)
      :ok = await_handshake(server)

      # Seed live membership synchronously (dodges the self-JOIN echo race).
      {:ok, cred} = Grappa.Networks.Credentials.get_visitor_credential(visitor.id, network.id)

      :sys.replace_state(pid, fn s ->
        %{s | members: Map.put(s.members, "#italia", %{cred.nick => []})}
      end)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> delete("/networks/#{network.slug}/channels/%23italia")

      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "PART #italia\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "PART #italia\r\n"), 1_000)

      # #211 phase 4c — the rejoin list is PER-NETWORK on the credential now.
      assert Grappa.Visitors.list_autojoin_channels(visitor, network.id) == []

      get_conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> get("/networks/#{network.slug}/channels")

      assert json_response(get_conn, 200) == []

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    # #87 parity — case (b): a stale autojoin entry that is NOT live-joined
    # (e.g. it 475'd on reconnect) — the cic greyed pseudo-row the visitor
    # dismisses with ×. There is no live membership change to snapshot away,
    # so the leave intent must remove the channel from the visitor's
    # `last_joined_channels` at the controller — the exact mirror of the user
    # branch's `Credentials.remove_autojoin_channel/3`. Pre-fix the visitor
    # branch of `remove_from_autojoin` was a no-op and the row never went away.
    test "DELETE PART of a stale not-live autojoin entry drops it from GET /channels + last_joined (case b)",
         %{conn: _conn} do
      {server, port} = start_server()
      {visitor, network} = visitor_with_network(port)
      _ = visitor_channel_fixture(visitor, network.slug, "#italia")
      session = visitor_session_fixture(visitor)
      pid = start_visitor_session_for(visitor, network)
      :ok = await_handshake(server)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> delete("/networks/#{network.slug}/channels/%23italia")

      assert json_response(conn, 202) == %{"ok" => true}

      assert {:ok, "PART #italia\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "PART #italia\r\n"), 1_000)

      # #211 phase 4c — the rejoin list is PER-NETWORK on the credential now.
      assert Grappa.Visitors.list_autojoin_channels(visitor, network.id) == []

      get_conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> get("/networks/#{network.slug}/channels")

      assert json_response(get_conn, 200) == []

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  defp u, do: System.unique_integer([:positive])
end
