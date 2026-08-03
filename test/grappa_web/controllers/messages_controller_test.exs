defmodule GrappaWeb.MessagesControllerTest do
  @moduledoc """
  GET (read) + POST input-validation paths. The POST success path
  needs an active `Grappa.Session.Server` so it lives in
  `messages_controller_outbound_test.exs` (`async: false`).

  `async: false` because the per-test setup writes `users` +
  `networks` rows; with the slug "azzurra" reused across tests, the
  unique-index race under sandbox txs would flake under
  `max_cases: 2`. Cheaper to serialize than to bump busy_timeout
  (already 30s) further.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Networks, ScrollbackHelpers, UserSettings}

  setup %{conn: conn} do
    {user, session} = user_and_session()
    # S14: every `/networks/:slug/...` route now passes through the
    # `ResolveNetwork` plug which requires a credential for
    # (current_user, network). Test setup binds the user to the network
    # so the index/create paths reach the controller action.
    {network, _} = network_with_server(port: 7301, slug: "azzurra")
    _ = credential_fixture(user, network)
    {:ok, conn: put_bearer(conn, session.id), user: user, network: network}
  end

  defp seed(user, network, channel \\ "#sniffo") do
    for i <- 0..4 do
      {:ok, _} =
        ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: channel,
          server_time: i,
          kind: :privmsg,
          sender: "vjt",
          body: "m#{i}"
        })
    end
  end

  # #458 — the controller resolves the per-channel presence-hide decision from
  # the server-owned pref (#449) + live member count, and passes it to
  # Scrollback so `limit` counts VISIBLE rows. These tests exercise the
  # pref-driven branches; the member-count (unset+large) branch has no live
  # session here, so it resolves to SHOW (decision D) — the count-driven
  # branch is covered by Grappa.PresenceFilter unit tests + the e2e.
  defp seed_mixed(user, network, channel \\ "#sniffo") do
    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: channel,
        server_time: 0,
        kind: :privmsg,
        sender: "vjt",
        body: "hello"
      })

    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: channel,
        server_time: 1,
        kind: :join,
        sender: "alice",
        body: nil
      })

    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: channel,
        server_time: 2,
        kind: :quit,
        sender: "bob",
        body: "bye"
      })
  end

  defp kinds_in(body), do: body |> Enum.map(& &1["kind"]) |> Enum.uniq()

  test "GET omits join/part/quit when the channel pref is \"hide\" (#458)",
       %{conn: conn, user: user, network: network} do
    :ok = put_presence_pref(user, "azzurra #sniffo", "hide")
    seed_mixed(user, network)

    body = json_response(get(conn, "/networks/azzurra/channels/%23sniffo/messages"), 200)

    assert kinds_in(body) == ["privmsg"]
  end

  test "GET returns every kind when the channel pref is \"show\" (#458)",
       %{conn: conn, user: user, network: network} do
    :ok = put_presence_pref(user, "azzurra #sniffo", "show")
    seed_mixed(user, network)

    body = json_response(get(conn, "/networks/azzurra/channels/%23sniffo/messages"), 200)

    assert "join" in kinds_in(body)
    assert "quit" in kinds_in(body)
  end

  test "GET on an unset channel with no live session shows presence (decision D) (#458)",
       %{conn: conn, user: user, network: network} do
    seed_mixed(user, network)

    body = json_response(get(conn, "/networks/azzurra/channels/%23sniffo/messages"), 200)

    assert "join" in kinds_in(body)
  end

  test "the presence pref key is ASCII-canonicalised: a mixed-case channel still resolves \"hide\" (#458)",
       %{conn: conn, user: user, network: network} do
    # pref stored under the canonical key; a request for the SAME channel in a
    # different casing must fold to the same key (channel invariant #364).
    :ok = put_presence_pref(user, "azzurra #sniffo", "hide")
    seed_mixed(user, network)

    body = json_response(get(conn, "/networks/azzurra/channels/%23SNIFFO/messages"), 200)

    assert kinds_in(body) == ["privmsg"]
  end

  defp put_presence_pref(user, channel_key, state) do
    # put_display_prefs requires the full display-prefs shape (mirrors the #449
    # wire PUT); build it from production defaults with the one pin set.
    prefs = %{UserSettings.default_display_prefs() | presence_filter: %{channel_key => state}}
    {:ok, _} = UserSettings.put_display_prefs({:user, user.id}, prefs)
    :ok
  end

  test "GET ?limit=3 returns latest page descending with kind round-trip",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=3")
    body = json_response(conn, 200)
    assert length(body) == 3
    assert Enum.at(body, 0)["body"] == "m4"
    assert Enum.at(body, 0)["kind"] == "privmsg"
    assert Enum.at(body, 0)["channel"] == "#sniffo"
    assert Enum.at(body, 0)["network"] == "azzurra"
    refute Map.has_key?(Enum.at(body, 0), "user_id")
    assert Enum.at(body, 2)["body"] == "m2"
  end

  test "GET ?before=<id>&limit=2 paginates correctly (id-cursor semantics post-CP29 R-2)",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    # CP29 R-2: ?before= is now an id cursor (was server_time). Pick the
    # row with body "m3" — strictly less than its id should yield m2, m1
    # in DESC order (cap 2).
    conn0 = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body0 = json_response(conn0, 200)
    m3 = Enum.find(body0, fn row -> row["body"] == "m3" end)

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=#{m3["id"]}&limit=2")
    body = json_response(conn, 200)
    assert length(body) == 2
    assert Enum.at(body, 0)["body"] == "m2"
    assert Enum.at(body, 1)["body"] == "m1"
  end

  test "limit defaults to 50 when omitted",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body = json_response(conn, 200)
    assert length(body) == 5
  end

  test "filters by (user_id, network_id, channel) — no leakage across channels, networks, or users",
       %{conn: conn, user: user, network: network} do
    {:ok, other_net} = Networks.find_or_create_network(%{slug: "freenode"})
    other_user = user_fixture(name: "alice-#{System.unique_integer([:positive])}")

    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: "#sniffo",
        server_time: 1,
        kind: :privmsg,
        sender: "vjt",
        body: "target"
      })

    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: "#other",
        server_time: 2,
        kind: :privmsg,
        sender: "vjt",
        body: "wrong-channel"
      })

    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: other_net.id,
        channel: "#sniffo",
        server_time: 3,
        kind: :privmsg,
        sender: "vjt",
        body: "wrong-network"
      })

    # Per-user iso check: same channel + network, different user.
    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: other_user.id,
        network_id: network.id,
        channel: "#sniffo",
        server_time: 4,
        kind: :privmsg,
        sender: "alice",
        body: "wrong-user"
      })

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body = json_response(conn, 200)
    assert length(body) == 1
    assert Enum.at(body, 0)["body"] == "target"
  end

  test "GET on unknown network slug returns 404", %{conn: conn} do
    conn = get(conn, "/networks/no-such-net/channels/%23sniffo/messages")
    assert json_response(conn, 404)["error"] == "not_found"
  end

  # S14 oracle close: a probing user querying scrollback for someone
  # else's network gets the SAME body as querying an unknown slug.
  # Pre-fix this would have returned 200 [] (empty list — also a leak,
  # since the user_id partition silently filtered to no rows).
  test "GET against another user's network returns 404 not_found", %{conn: conn} do
    alice = user_fixture(name: "alice-#{System.unique_integer([:positive])}")
    {alice_network, _} = network_with_server(port: 7302, slug: "alice-only-#{System.unique_integer([:positive])}")
    _ = credential_fixture(alice, alice_network)

    conn = get(conn, "/networks/#{alice_network.slug}/channels/%23sniffo/messages")
    assert json_response(conn, 404)["error"] == "not_found"
  end

  test "?limit=banana returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=banana")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "?limit=0 returns 400 (must be positive)", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=0")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "?before=banana returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=banana")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  # Message-replay-on-reconnect cluster — `?after=<id>` cursor for cic's
  # WS-reconnect backfill. ASC by `id`, exclusive of the cursor row.
  test "GET ?after=<id> returns rows with id > cursor in ASC id order",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    # Pick the second-oldest row's id; should yield m2, m3, m4 ascending.
    conn0 = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body0 = json_response(conn0, 200)
    # Body is DESC; the second-oldest is the second-from-last.
    second_oldest = Enum.at(body0, -2)

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?after=#{second_oldest["id"]}")
    body = json_response(conn, 200)
    assert Enum.map(body, & &1["body"]) == ["m2", "m3", "m4"]
  end

  test "GET ?after=<huge> returns []", %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?after=999999999")
    assert json_response(conn, 200) == []
  end

  test "GET ?after=banana returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?after=banana")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "GET ?before and ?after together returns 400 (mutually exclusive)",
       %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=10&after=5")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  # CP29 R-2: cursor mutex extended from {before, after} to {before,
  # after, around}. Any two together is a client bug.
  test "GET ?before and ?around together returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=10&around=5")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "GET ?after and ?around together returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?after=10&around=5")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "GET ?around=banana returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?around=banana")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  # CP29 R-2: HTTP boundary ceiling at 200. Underlying Scrollback cap
  # (500) stays as backstop; HTTP request asking 5000 is a client bug.
  test "GET ?limit=201 returns 400 (HTTP ceiling)", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=201")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "GET ?limit=200 is accepted (boundary)", %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=200")
    body = json_response(conn, 200)
    assert length(body) == 5
  end

  # CP29 R-2: ?around=<id> returns floor(limit/2) before + ceil(limit/2)
  # after, merged DESC. With 5 rows seeded (ids ascending) and limit=4,
  # asking around the middle row should yield 2 before + 2 after.
  test "GET ?around=<id>&limit=4 returns rows centered on the cursor",
       %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn0 = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body0 = json_response(conn0, 200)
    m2 = Enum.find(body0, fn row -> row["body"] == "m2" end)

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?around=#{m2["id"]}&limit=4")
    body = json_response(conn, 200)
    # Returned DESC: 2 after (m4, m3) then floor(4/2) = 2 before-or-at (m2, m1).
    assert Enum.map(body, & &1["body"]) == ["m4", "m3", "m2", "m1"]
  end

  test "GET ?around=<id> with default limit returns up to 50 rows", %{conn: conn, user: user, network: network} do
    seed(user, network)
    conn0 = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body0 = json_response(conn0, 200)
    m2 = Enum.find(body0, fn row -> row["body"] == "m2" end)

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?around=#{m2["id"]}")
    body = json_response(conn, 200)
    # All 5 fit in default limit=50. DESC ordering preserved.
    assert Enum.map(body, & &1["body"]) == ["m4", "m3", "m2", "m1", "m0"]
  end

  test "GET ?after=<id>&limit=2 caps the page size", %{conn: conn, user: user, network: network} do
    seed(user, network)
    # cursor BELOW the lowest id in the table — yields all five, capped to 2.
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?after=0&limit=2")
    body = json_response(conn, 200)
    assert length(body) == 2
    # ASC: lowest two of m0..m4 (which are inserted with server_time = 0..4).
    assert Enum.map(body, & &1["body"]) == ["m0", "m1"]
  end

  # After the C4/DM fix-up: the target validator accepts BOTH channel-sigil
  # names AND valid IRC nicks (DM targets). A plain nick like "notachan"
  # is a valid DM target — it returns 200+[] (no scrollback rows) not 400.
  # The shape-check only rejects targets that are neither a valid channel
  # NOR a valid nick, e.g. digit-leading strings.
  test "GET with nick-shaped target returns 200 (DM scrollback fetch)", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/notachan/messages")
    assert json_response(conn, 200) == []
  end

  test "GET with truly malformed target (digit-leading, neither nick nor channel) returns 400",
       %{conn: conn} do
    # "123bad" starts with a digit → rejected by valid_nick?; has no
    # channel sigil → rejected by valid_channel?.  This is the shape
    # check that still fires after the DM widening.
    conn = get(conn, "/networks/azzurra/channels/123bad/messages")
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  # BUG 2c: $server is Grappa's synthetic pseudo-target for server-window
  # scrollback. validate_target_name/1 must accept it so REST
  # loadInitialScrollback succeeds for the Server window.
  test "GET with $server synthetic target returns 200 (server-window scrollback fetch)",
       %{conn: conn, user: user, network: network} do
    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: "$server",
        server_time: 1,
        kind: :notice,
        sender: "irc.azzurra.org",
        body: "Welcome to Azzurra"
      })

    conn = get(conn, "/networks/azzurra/channels/%24server/messages")
    body = json_response(conn, 200)
    assert length(body) == 1
    assert hd(body)["channel"] == "$server"
  end

  test "GET without Bearer returns 401" do
    conn = get(Phoenix.ConnTest.build_conn(), "/networks/azzurra/channels/%23sniffo/messages")
    assert json_response(conn, 401) == %{"error" => "unauthorized"}
  end

  # #693 — the gap probe. cic decides "am I more than one page behind?" from
  # this count, NOT from `page.length == limit` (a full page says "≥ limit",
  # which cannot distinguish a 201-row gap from a 3000-row one).
  describe "GET /networks/:network_id/channels/:channel_id/messages/count (#693)" do
    test "?after=0 returns the total row count for the channel",
         %{conn: conn, user: user, network: network} do
      seed(user, network)

      conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages/count?after=0")

      assert json_response(conn, 200) == %{"count" => 5}
    end

    test "the count is NOT capped at the page ceiling — a 201-row gap reads 201",
         %{conn: conn, user: user, network: network} do
      for i <- 0..200 do
        {:ok, _} =
          ScrollbackHelpers.insert(%{
            user_id: user.id,
            network_id: network.id,
            channel: "#sniffo",
            server_time: i,
            kind: :privmsg,
            sender: "vjt",
            body: "m#{i}"
          })
      end

      conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages/count?after=0")

      assert json_response(conn, 200) == %{"count" => 201}
    end

    test "?after=<tail id> returns 0", %{conn: conn, user: user, network: network} do
      seed(user, network)
      rows = json_response(get(conn, "/networks/azzurra/channels/%23sniffo/messages"), 200)
      tail = rows |> Enum.map(& &1["id"]) |> Enum.max()

      conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages/count?after=#{tail}")

      assert json_response(conn, 200) == %{"count" => 0}
    end

    test "counts only VISIBLE rows when the channel pref hides presence (#458)",
         %{conn: conn, user: user, network: network} do
      # The count feeds a "can I drain this in one page?" decision, so it MUST
      # apply the same presence filter `index/2` applies — otherwise a channel
      # with 500 hidden JOINs and 5 messages reads as a 505-row gap.
      :ok = put_presence_pref(user, "azzurra #sniffo", "hide")
      seed_mixed(user, network)

      conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages/count?after=0")

      assert json_response(conn, 200) == %{"count" => 1}
    end

    test "a missing ?after returns 400", %{conn: conn, user: user, network: network} do
      seed(user, network)

      conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages/count")

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "an unparseable ?after returns 400", %{conn: conn, user: user, network: network} do
      seed(user, network)

      conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages/count?after=banana")

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "a list-valued ?after returns 400, not a 500", %{conn: conn, user: user, network: network} do
      # `?after[]=1` reaches the action as `["1"]`. A missing catch-all clause
      # would raise FunctionClauseError — a stacktrace for a malformed request.
      seed(user, network)

      conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages/count?after[]=1")

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "a negative ?after returns 400", %{conn: conn, user: user, network: network} do
      seed(user, network)

      conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages/count?after=-1")

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "does not leak another channel's rows", %{conn: conn, user: user, network: network} do
      seed(user, network)
      seed(user, network, "#altro")

      conn = get(conn, "/networks/azzurra/channels/%23altro/messages/count?after=0")

      assert json_response(conn, 200) == %{"count" => 5}
    end

    test "without Bearer returns 401" do
      conn =
        get(
          Phoenix.ConnTest.build_conn(),
          "/networks/azzurra/channels/%23sniffo/messages/count?after=0"
        )

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  describe "POST /networks/:network_id/channels/:channel_id/messages — input validation" do
    test "unknown network slug returns 404 not found", %{conn: conn} do
      # Sub-task 2g: slug → integer FK resolution short-circuits with
      # "not_found" before reaching the Session lookup. A known slug
      # without a session is the separate :no_session path tested in
      # `MessagesControllerOutboundTest`.
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/no-such-net/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "empty body returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => ""})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "missing body field returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "non-string body returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => 42})

      assert json_response(conn, 400)["error"] == "bad_request"
    end

    # HIGH-19 (no-silent-drops B6.9a 2026-05-14): body byte cap. Pre-fix
    # an oversized body reached IRC.Client.transport_send and either
    # truncated silently at the 512-byte RFC framing limit or got the
    # upstream peer to disconnect — UI claimed `:ok` while the message
    # never arrived. Surfacing as 413 + body_too_large lets cic render
    # an actionable rejection.
    test "body over BodyLimit cap returns 413 body_too_large", %{conn: conn} do
      oversize = String.duplicate("x", GrappaWeb.BodyLimit.max_body_bytes() + 1)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => oversize})

      assert json_response(conn, 413)["error"] == "body_too_large"
      assert json_response(conn, 413)["limit"] == GrappaWeb.BodyLimit.max_body_bytes()
    end

    test "POST without Bearer returns 401" do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "hello"})

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    # Codebase review 2026-05-08 W1: $server is a Grappa-internal
    # synthetic for the server-messages window. GET accepts it (so
    # `loadInitialScrollback` works) but POST must NOT, otherwise a
    # client could smuggle `PRIVMSG $server :body` upstream — server-
    # mask form per RFC 2812 §3.3.1 — pollute the synthetic Server-
    # window scrollback with single-source echo, and inadvertently
    # probe operator privileges. The shared `validate_target_name/1`
    # earned the `$server` clause for GET; POST should reject it.
    test "POST to $server target returns 400 — synthetic is read-only", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%24server/messages", %{"body" => "hello"})

      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  # Task 30: visitor scrollback partition. `Scrollback.fetch/5` was
  # widened to take a `subject :: {:user, id} | {:visitor, id}` tuple;
  # the controller threads `:current_subject` (plumbed by Plugs.Authn
  # S18 C2) so visitor sessions read their visitor-id-partitioned rows.
  describe "visitor subject — read partition" do
    test "GET returns visitor's own rows; never another visitor's", %{conn: _conn} do
      slug = "azzurra-vis-msg-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})

      {visitor, session} = visitor_and_session_with_credential(network_slug: slug)
      other_visitor = visitor_fixture(network_slug: slug)

      {:ok, _} =
        ScrollbackHelpers.insert(%{
          visitor_id: visitor.id,
          network_id: network.id,
          channel: "#sniffo",
          server_time: 1,
          kind: :privmsg,
          sender: "mine-sender",
          body: "mine"
        })

      {:ok, _} =
        ScrollbackHelpers.insert(%{
          visitor_id: other_visitor.id,
          network_id: network.id,
          channel: "#sniffo",
          server_time: 2,
          kind: :privmsg,
          sender: "other-sender",
          body: "not-mine"
        })

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> get("/networks/#{slug}/channels/%23sniffo/messages")

      body = json_response(conn, 200)
      assert length(body) == 1
      assert hd(body)["body"] == "mine"
    end

    test "GET against a network the visitor isn't pinned to returns 404 (oracle close)",
         %{conn: _conn} do
      slug = "azzurra-iso-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})
      {_, session} = visitor_and_session_with_credential(network_slug: slug)

      other_slug = "other-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: other_slug})

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(session.id)
        |> get("/networks/#{other_slug}/channels/%23sniffo/messages")

      assert json_response(conn, 404)["error"] == "not_found"
    end
  end
end
