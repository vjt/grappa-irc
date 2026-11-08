defmodule GrappaWeb.ArchiveControllerTest do
  @moduledoc """
  REST surface for the per-network Archive section (CP15 B4 + UX-1).

  `GET /networks/:network_id/archive` returns targets with scrollback
  rows that are NOT currently active (joined channels + open query
  windows). Powers cicchetto's per-network collapsible Archive section.

  `DELETE /networks/:network_id/archive/:target` drops the scrollback
  for one target (channel-shaped via `delete_for_channel/3`, query-
  shaped via `delete_for_dm/3`) and broadcasts `archive_purged` on
  the user-rooted topic so connected cic tabs refresh AND invalidate
  the in-memory scrollback cache for the deleted target.

  Scope of these tests: controller wiring (auth, iso boundary, JSON
  shape, active_keyset assembly, sigil dispatch on DELETE, broadcast
  shape). The list_archive + delete_* query semantics are exhaustively
  covered in `Grappa.ScrollbackTest`; here we only assert the
  controller threads the args correctly and renders/broadcasts the
  wire shape.

  `async: false` for the same singleton-Session reason as
  `MembersControllerTest`.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, MuteSession, QueryWindows, Scrollback}
  alias Grappa.PubSub.Topic

  # #1404 — read the SAME config keys `GrappaWeb.ArchiveController` reads,
  # rather than an accessor on the controller: an accessor returning a
  # compile-time constant cannot carry an honest `@spec` under Dialyzer's
  # `:underspecs`, and a literal here would pin the test to a number the
  # operator is meant to retune.
  @archive_capacity Application.compile_env(:grappa, [:archive_read, :capacity])
  @archive_refill_per_sec Application.compile_env(:grappa, [:archive_read, :refill_per_sec])
  @archive_retry_after max(1, ceil(1.0 / @archive_refill_per_sec))

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  defp seed_archive_rows(user, net) do
    # Two channels (#a, #b) + one DM target (vjt-peer) + $server.
    # No live session in MOST tests → active_keyset is empty per
    # Session.list_channels/2 returning {:error, :no_session}, so all four
    # targets land in the query result and only $server is filtered out by
    # list_archive. The one exception is the live-session control added for
    # issue 1985, which spawns a session against a fake ircd on purpose.
    {:ok, _} =
      Scrollback.persist_event(%{
        user_id: user.id,
        network_id: net.id,
        channel: "#a",
        server_time: 100,
        kind: :privmsg,
        sender: "vjt",
        body: "channel a",
        meta: %{},
        dm_with: nil
      })

    {:ok, _} =
      Scrollback.persist_event(%{
        user_id: user.id,
        network_id: net.id,
        channel: "#b",
        server_time: 200,
        kind: :privmsg,
        sender: "vjt",
        body: "channel b",
        meta: %{},
        dm_with: nil
      })

    {:ok, _} =
      Scrollback.persist_event(%{
        user_id: user.id,
        network_id: net.id,
        channel: "vjt-grappa",
        server_time: 300,
        kind: :privmsg,
        sender: "vjt-peer",
        body: "dm",
        meta: %{},
        dm_with: "vjt-peer"
      })

    {:ok, _} =
      Scrollback.persist_event(%{
        user_id: user.id,
        network_id: net.id,
        channel: "$server",
        server_time: 50,
        kind: :notice,
        sender: "irc.example",
        body: "MOTD",
        meta: %{},
        dm_with: nil
      })

    :ok
  end

  defp net_with_credential(vjt) do
    net = network_fixture(slug: "az-#{System.unique_integer([:positive])}")
    _ = credential_fixture(vjt, net, %{nick: "grappa-test"})
    net
  end

  describe "GET /networks/:network_id/archive" do
    test "returns archived targets sorted last_activity desc, $server excluded",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      conn = get(conn, "/networks/#{net.slug}/archive")

      assert json_response(conn, 200) == %{
               "archive" => [
                 %{"target" => "vjt-peer", "kind" => "query", "last_activity" => 300},
                 %{"target" => "#b", "kind" => "channel", "last_activity" => 200},
                 %{"target" => "#a", "kind" => "channel", "last_activity" => 100}
               ]
             }
    end

    # issue 1985 — an OPEN query window must NOT keep its DM out of the
    # archive when there is no live session.
    #
    # The keyset composed the live session's channels with a DB read of the
    # open query windows, and only the channel half went quiet without a
    # session. So a parked network's DM was excluded from the archive while
    # cic's sidebar (which drops a parked network entirely, issue 1985) drew
    # no row for it either: one window, ZERO surfaces, and no client-side
    # filter can restore a row the server never sent.
    #
    # The promise this restores is the controller's own, in its moduledoc:
    # "an absent session simply means an empty `active_keyset`, which is the
    # correct semantic (everything with rows qualifies for the archive when
    # no session is live)". The channel arm honoured it; the query arm did
    # not. The exclusion is right while a session IS live — that is the
    # sibling test below.
    test "an open query window does NOT hide its DM when no session is live",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      {:ok, _} = QueryWindows.open({:user, vjt.id}, net.id, "vjt-peer", vjt.name)

      conn = get(conn, "/networks/#{net.slug}/archive")

      targets = Enum.map(json_response(conn, 200)["archive"], & &1["target"])
      assert "vjt-peer" in targets
    end

    # The control for the test above, and the one that keeps the fix from
    # becoming "the archive never subtracts queries". With a LIVE session an
    # open query window is a window the operator can already be in, so it
    # must still be excluded — this is the only test in the file that runs a
    # session, which is why it pays for the fake ircd.
    test "an open query window DOES hide its DM while a session is live",
         %{conn: conn, vjt: vjt} do
      # The fake ircd stays SILENT (`passthrough_handler`, no 001) on purpose.
      # All this test needs is a session PROCESS — `Session.list_channels/2`
      # answers from its state, registration or not. Send a welcome and the
      # session registers, then autojoins the fixture's `#sniffo` on a socket
      # this test is about to tear down: an intermittent `:tcp_closed` crash
      # in the log, green run and all. A silent ircd absorbs the connect and
      # nothing else happens.
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      slug = "az-#{System.unique_integer([:positive])}"
      {net, _} = network_with_server(port: port, slug: slug)
      _ = credential_fixture(vjt, net, %{nick: "grappa-test"})
      :ok = seed_archive_rows(vjt, net)

      {:ok, _} = QueryWindows.open({:user, vjt.id}, net.id, "vjt-peer", vjt.name)

      _ = start_session_for(vjt, net)
      # Handshake awaited so the socket is up before the read — the session is
      # live either way, but a half-open connect is not a state worth racing.
      :ok = IRCServer.await_handshake(server, 1_000)

      conn = get(conn, "/networks/#{slug}/archive")

      targets = Enum.map(json_response(conn, 200)["archive"], & &1["target"])
      refute "vjt-peer" in targets
      # The channels are still archived — the session joined nothing, so the
      # exclusion above is the query window's doing and not a live channel's.
      assert "#a" in targets
      assert "#b" in targets
    end

    # issue 2239 — the sibling of the two tests above on the third axis:
    # a session that is registered but does not ANSWER. `build_active_keyset/3`
    # matched only `{:ok, _}` and `{:error, :no_session}` — the two shapes
    # `Session.list_channels/2`'s `@spec` declared — while `call_session/4`
    # also returns `{:error, :timeout}` once its 5s budget expires. The page
    # then 500'd on a `CaseClauseError`, which is the worst of the three
    # possible answers: the archive is a read-only view whose whole point is
    # to still be there when the live side is sick.
    #
    # Ruled (2239): PROPAGATE, do not degrade to `[]`. An empty active keyset
    # asserts "nothing is active", so `list_archive/3` hands back everything
    # with rows and the page shows the user the conversations they are sitting
    # in RIGHT NOW as archived — on this page `[]` does not blur the answer, it
    # inverts it. The 504 clause it lands on already existed in
    # `FallbackController`; nothing was invented for this.
    #
    # The seeded rows are what makes the assertion bite: with an archive this
    # request WOULD have had a 200 body to render, so a green here cannot come
    # from there being nothing to say.
    @tag timeout: 30_000
    test "a session that does not answer in time answers 504 session_timeout",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      _ = MuteSession.register!({:user, vjt.id}, net.id)

      conn = get(conn, "/networks/#{net.slug}/archive")

      assert json_response(conn, 504) == %{"error" => "session_timeout"}
      # The retry hint is the actionable half — a stuck mailbox drains.
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["10"]
    end

    test "returns empty archive when network has no scrollback rows",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)

      conn = get(conn, "/networks/#{net.slug}/archive")

      assert json_response(conn, 200) == %{"archive" => []}
    end

    test "401 without bearer token", %{vjt: vjt} do
      net = net_with_credential(vjt)

      conn = get(Phoenix.ConnTest.build_conn(), "/networks/#{net.slug}/archive")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "404 for cross-user network access (per-user iso)", %{vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      stranger = user_fixture(name: "stranger-#{System.unique_integer([:positive])}")
      stranger_session = session_fixture(stranger)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(stranger_session.id)
        |> get("/networks/#{net.slug}/archive")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  describe "GET /networks/:network_id/archive is metered" do
    test "the listing is refused once the subject's archive bucket is spent",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)

      # Pre-state: the door is open before the bucket is spent. Without
      # this the 429 below could just as well mean the route is broken.
      assert conn |> get("/networks/#{net.slug}/archive") |> Map.fetch!(:status) == 200

      answers = for _ <- 1..@archive_capacity, do: get(conn, "/networks/#{net.slug}/archive")
      refused = Enum.find(answers, &(&1.status != 200))

      assert refused,
             "the archive listing spent no token: #{@archive_capacity + 1} calls all passed"

      assert refused.status == 429
      assert json_response(refused, 429) == %{"error" => "rate_limited"}

      # The hint must come from THIS bucket's refill, not from the coarse
      # budget's much faster one — pacing a client against the wrong
      # bucket re-429s it on the very next call.
      assert Plug.Conn.get_resp_header(refused, "retry-after") == [
               Integer.to_string(@archive_retry_after)
             ]
    end

    test "the bucket keys on (subject, network) — a spent network does not refuse another",
         %{conn: conn, vjt: vjt} do
      spent = net_with_credential(vjt)
      other = net_with_credential(vjt)

      for _ <- 1..(@archive_capacity + 1), do: get(conn, "/networks/#{spent.slug}/archive")

      assert conn |> get("/networks/#{spent.slug}/archive") |> Map.fetch!(:status) == 429,
             "the first network's bucket was expected to be empty by now"

      assert conn |> get("/networks/#{other.slug}/archive") |> Map.fetch!(:status) == 200,
             "a second network shared the first one's bucket"
    end

    test "the DELETE takes no archive token — it is a write, already metered upstream",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      for _ <- 1..(@archive_capacity + 1), do: get(conn, "/networks/#{net.slug}/archive")

      assert conn |> get("/networks/#{net.slug}/archive") |> Map.fetch!(:status) == 429,
             "the listing bucket was expected to be empty by now"

      target = URI.encode_www_form("#a")

      assert conn |> delete("/networks/#{net.slug}/archive/#{target}") |> Map.fetch!(:status) ==
               204
    end
  end

  describe "DELETE /networks/:network_slug/archive/:target (UX-1)" do
    test "channel-shaped target → 204 + drops channel rows + broadcasts archive_purged",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(vjt.name))

      conn = delete(conn, "/networks/#{net.slug}/archive/#{URI.encode_www_form("#a")}")

      assert response(conn, 204) == ""

      # Channel rows for #a gone; other archive entries untouched.
      remaining =
        Scrollback.list_archive({:user, vjt.id}, net.id, MapSet.new())

      assert not Enum.any?(remaining, &(&1.target == "#a"))
      assert Enum.any?(remaining, &(&1.target == "#b"))
      assert Enum.any?(remaining, &(&1.target == "vjt-peer"))

      assert_received %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{kind: :archive_purged, network_slug: slug, target: "#a"}
      }

      assert slug == net.slug
    end

    # #1374 P-S8 — the two archive purges were the last web-reachable
    # scrollback writes with no retry: a transient SQLITE_BUSY raised out of
    # `Repo.delete_all` and left the operator with a 500 where #518 promises
    # a typed 503, on a door #523 B1's own stated scope already covered.
    test "sustained DB busy on a purge is a typed 503, and the rows survive",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(vjt.name))

      Grappa.Repo.BusyRetry.inject_transient_faults(10_000)

      degraded = delete(conn, "/networks/#{net.slug}/archive/#{URI.encode_www_form("#a")}")

      assert json_response(degraded, 503) == %{"error" => "db_unavailable"}

      # Refused, not half-done: the rows are still there, and NO purge was
      # announced — a broadcast here would tell every cic tab to drop a
      # cache the server still holds.
      remaining = Scrollback.list_archive({:user, vjt.id}, net.id, MapSet.new())
      assert Enum.any?(remaining, &(&1.target == "#a"))

      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :archive_purged}}
    end

    test "query-shaped target → 204 + drops DM rows + broadcasts archive_purged",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(vjt.name))

      conn = delete(conn, "/networks/#{net.slug}/archive/vjt-peer")

      assert response(conn, 204) == ""

      remaining = Scrollback.list_archive({:user, vjt.id}, net.id, MapSet.new())
      assert not Enum.any?(remaining, &(&1.target == "vjt-peer"))
      # Channel entries untouched.
      assert Enum.any?(remaining, &(&1.target == "#a"))

      assert_received %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{kind: :archive_purged, network_slug: slug, target: "vjt-peer"}
      }

      assert slug == net.slug
    end

    test "204 even when target has no rows (idempotent + still broadcasts)",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)
      Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(vjt.name))

      conn = delete(conn, "/networks/#{net.slug}/archive/#{URI.encode_www_form("#ghost")}")
      assert response(conn, 204) == ""

      assert_received %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{kind: :archive_purged, target: "#ghost"}
      }
    end

    test "400 on bare invalid target name (not channel-shaped, not nick-shaped)",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)
      # NUL byte fails both Identifier.valid_channel? + wire_nick?.
      conn = delete(conn, "/networks/#{net.slug}/archive/" <> URI.encode_www_form("bad\0name"))

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "401 without bearer token", %{vjt: vjt} do
      net = net_with_credential(vjt)

      conn =
        delete(
          Phoenix.ConnTest.build_conn(),
          "/networks/#{net.slug}/archive/#{URI.encode_www_form("#a")}"
        )

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "404 for cross-user network access — stranger cannot delete vjt's archive",
         %{vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      stranger = user_fixture(name: "stranger-#{System.unique_integer([:positive])}")
      stranger_session = session_fixture(stranger)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(stranger_session.id)
        |> delete("/networks/#{net.slug}/archive/#{URI.encode_www_form("#a")}")

      assert json_response(conn, 404) == %{"error" => "not_found"}

      # vjt's rows must survive.
      remaining = Scrollback.list_archive({:user, vjt.id}, net.id, MapSet.new())
      assert Enum.any?(remaining, &(&1.target == "#a"))
    end
  end
end
