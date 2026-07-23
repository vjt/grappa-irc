defmodule GrappaWeb.GrappaChannelTest do
  @moduledoc """
  Channel tests for `GrappaWeb.GrappaChannel`.

  The channel is a thin pass-through: the framework's auto-installed
  fastlane (Phoenix.Channel.Server.init/1) subscribes the transport
  pid for the joined topic and writes any
  `%Phoenix.Socket.Broadcast{event: "event", payload: ...}` arriving
  via `Grappa.PubSub.broadcast_event/2` directly to the WS as a single
  frame. Tests verify the join shape (which topics are accepted, which
  are rejected), the authz check that rejects topics belonging to a
  different user, and the broadcast → push contract.

  BUG 6 (2026-05-05): the channel previously called
  `Phoenix.PubSub.subscribe/2` manually in `join/3` IN ADDITION to the
  framework fastlane, which double-pushed every event. Fixed by
  removing the manual subscribe and migrating all broadcasters to
  `Grappa.PubSub.broadcast_event/2`. The two regression tests below
  (`BUG 6 regression: ...`) lock in the single-push invariant.

  Sub-task 2h shifts every Grappa topic to be rooted in the user
  discriminator (`grappa:user:{name}/...`) so multi-user instances
  cannot cross-deliver broadcasts. The authz check on join enforces
  that no socket can subscribe to another user's topic, even if the
  string is well-formed.

  Sub-task S2.5 adds after-join snapshots:

    * Joining the user-level topic delivers `query_windows_list` (for
      authenticated users; skipped for visitors).
    * Joining a channel-level topic delivers cached `topic_changed` and
      `channel_modes_changed` snapshots (best-effort; skips gracefully
      when no session is running or the cache is empty).

  `Phoenix.PubSub` is process-routed but topics are global, so two
  `async: true` tests that share a topic name will see each other's
  broadcasts. Each test below uses a distinct identifier so the topic
  namespace is partitioned per-test.
  """
  use GrappaWeb.ChannelCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.IRCServer
  alias Grappa.{Networks, QueryWindows, Repo, ScrollbackHelpers, Session, WSPresence}
  alias Grappa.Networks.{Credentials, Servers}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Wire
  alias Grappa.Visitors.SessionPlan, as: VisitorSessionPlan
  alias GrappaWeb.UserSocket

  # Mirrors `UserSocket.connect/3`'s assigns surface — assigns
  # `:user_name` AND `:current_subject` (V4: channel arms read the
  # bare-id subject directly so visitor watchlist arms can lift
  # without a per-arm visitor? branch). When `subject` is omitted,
  # derives from `user_name`'s `"visitor:" <> uuid` prefix:
  # everything-else is treated as a user. Tests that need a different
  # subject (e.g. user_name from the route but subject from a fixture)
  # pass `subject:` explicitly.
  defp build_socket(user_name, opts \\ []) do
    subject =
      Keyword.get_lazy(opts, :subject, fn ->
        case String.split(user_name, "visitor:", parts: 2) do
          ["", visitor_id] -> {:visitor, visitor_id}
          _ -> {:user, Ecto.UUID.generate()}
        end
      end)

    socket(UserSocket, "user_socket:#{user_name}", %{
      user_name: user_name,
      current_subject: subject
    })
  end

  # Drain up to `max_attempts` query_windows_list pushes and return the
  # LAST one's `windows` map. Used in tests where a direct DB mutation
  # (via context fn) and a channel inbound event both fire broadcasts, so
  # there may be two consecutive query_windows_list pushes in the mailbox;
  # we want the last one (the authoritative post-mutation state).
  defp drain_for_query_windows_list(max_attempts) do
    drain_for_query_windows_list(max_attempts, nil)
  end

  defp drain_for_query_windows_list(0, last_windows), do: last_windows || %{}

  defp drain_for_query_windows_list(remaining, last_windows) do
    receive do
      %Phoenix.Socket.Message{event: "event", payload: %{kind: "query_windows_list", windows: w}} ->
        drain_for_query_windows_list(remaining - 1, w)
    after
      200 ->
        last_windows || %{}
    end
  end

  # Shared IRC-fake helpers for after-join snapshot tests.

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_irc_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  defp setup_user_and_network_with_session(port, extra_cred_attrs \\ %{}) do
    user_name = "ch-snap-#{System.unique_integer([:positive])}"
    user = user_fixture(name: user_name)

    slug = "snap-net-#{System.unique_integer([:positive])}"
    {:ok, network} = Networks.find_or_create_network(%{slug: slug})
    {:ok, _} = Servers.add_server(network, %{host: "127.0.0.1", port: port, tls: false})

    base = %{nick: "grappa-snap", auth_method: :none, autojoin_channels: ["#snap"]}
    {:ok, credential} = Credentials.bind_credential(user, network, Map.merge(base, extra_cred_attrs))
    preloaded = Repo.preload(credential, :network)

    {:ok, plan} = Networks.SessionPlan.resolve(preloaded)
    {:ok, _} = Session.start_session({:user, user.id}, network.id, plan)

    # Stop the Session at test end so the next test's
    # `AdmissionStateHelpers.reset_all/0` doesn't race a
    # post-IRC-fake-shutdown reconnect loop (upstream
    # `:econnrefused` → `:transient` respawn → orphan in
    # `SessionRegistry` not under `SessionSupervisor`). The
    # `Session.stop_session/2` verb is the production teardown
    # path: synchronous, supervisor-mediated, registry-drained.
    on_exit(fn -> Session.stop_session({:user, user.id}, network.id) end)

    {user, network}
  end

  # Visitor counterpart to `setup_user_and_network_with_session/1`. Mints a
  # `%Visitor{}` row pointing at a fresh per-test network slug, attaches one
  # server endpoint to the network at `port`, then resolves the visitor plan
  # via `Visitors.SessionPlan.resolve/1` and starts a real `Session.Server`
  # under the `{:visitor, visitor.id}` subject. Returns the visitor +
  # network so tests can build a `"visitor:#{visitor.id}"` socket and push
  # ops verbs through `Session.send_*` end-to-end.
  defp setup_visitor_and_network_with_session(port) do
    slug = "snap-visitor-net-#{System.unique_integer([:positive])}"
    {:ok, network} = Networks.find_or_create_network(%{slug: slug})
    {:ok, _} = Servers.add_server(network, %{host: "127.0.0.1", port: port, tls: false})

    visitor =
      visitor_fixture(
        nick: "grappa-snap-v#{System.unique_integer([:positive])}",
        network_slug: slug
      )

    {:ok, plan} = VisitorSessionPlan.resolve(visitor, network)
    {:ok, _} = Session.start_session({:visitor, visitor.id}, network.id, plan)

    on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

    {visitor, network}
  end

  # #211 phase 7 — the visitor nick lives on its per-network credential now
  # (the `visitors.nick` scalar is dropped). Resolve the representative
  # (identity-anchor) credential's nick for tests that need to interpolate
  # the visitor's own nick into fed IRC lines.
  defp visitor_nick(visitor) do
    {:ok, cred} = Credentials.representative_visitor_credential(visitor.id)
    cred.nick
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    :ok
  end

  defp welcome_session_on_channel(server, channel) do
    :ok = await_handshake(server)
    IRCServer.feed(server, ":irc.test.org 001 grappa-snap :Welcome\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN #{channel}"), 1_000)
    IRCServer.feed(server, ":grappa-snap!u@h JOIN :#{channel}\r\n")
    flush_server(server)
  end

  # Visitor counterpart: welcomes the session using the visitor's own nick
  # (`grappa-snap` is hard-coded above for the user-class helper and would
  # not match the visitor's `state.nick`). Visitor session_plan carries
  # `autojoin = []` (visitor's `last_joined_channels` empty for a fresh
  # row), so the JOIN is driven explicitly via `Session.send_join/4` rather
  # than waiting for the 001-autojoin loop.
  defp welcome_visitor_on_channel(server, subject, network_id, nick, channel) do
    :ok = await_handshake(server)
    IRCServer.feed(server, ":irc.test.org 001 #{nick} :Welcome\r\n")
    :ok = Session.send_join(subject, network_id, channel, nil)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN #{channel}"), 1_000)
    IRCServer.feed(server, ":#{nick}!u@h JOIN :#{channel}\r\n")
    flush_server(server)
  end

  defp flush_server(server) do
    token = "flush-#{System.unique_integer([:positive])}"
    IRCServer.feed(server, "PING :#{token}\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :#{token}\r\n"), 1_000)
  end

  describe "join grappa:user:{user}/network:{net}/channel:{chan}" do
    test "delivers PubSub-broadcast events verbatim when authz passes" do
      user_name = "vjt-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)

      {:ok, network} =
        Networks.find_or_create_network(%{slug: "ch-happy-#{System.unique_integer([:positive])}"})

      chan = "#ch_happy"
      topic = Topic.channel(user_name, network.slug, chan)

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      {:ok, message} =
        ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: chan,
          server_time: 1_700_000_000_000,
          kind: :privmsg,
          sender: "<local>",
          body: "ciao raga"
        })

      preloaded = Repo.preload(message, :network)
      payload = Wire.message_payload(preloaded)

      Grappa.PubSub.broadcast_event(topic, payload)

      assert_push("event", ^payload)
    end

    test "broadcasts on a sibling channel topic do NOT reach this socket" do
      user_name = "vjt-#{System.unique_integer([:positive])}"
      net = "ch_sibling_net-#{System.unique_integer([:positive])}"
      joined = Topic.channel(user_name, net, "#ch_joined")
      other = Topic.channel(user_name, net, "#ch_other")

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(joined, %{})

      Grappa.PubSub.broadcast_event(other, %{kind: "message"})

      refute_push("event", _, 50)
    end

    test "after-join snapshot: pushes cached topic_changed if session has topic cached" do
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)

      welcome_session_on_channel(irc_server, "#snap")

      # Seed the topic cache via 332 RPL_TOPIC
      IRCServer.feed(irc_server, ":irc.test.org 332 grappa-snap #snap :Snapshot topic\r\n")
      flush_server(irc_server)

      # Now join the channel-level Phoenix Channel topic
      topic = Topic.channel(user.name, network.slug, "#snap")

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      # Must receive the cached topic_changed snapshot
      assert_push("event", %{kind: :topic_changed, channel: "#snap", topic: %{text: "Snapshot topic"}})
    end

    test "after-join snapshot: pushes cached channel_modes_changed if session has modes cached" do
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)

      welcome_session_on_channel(irc_server, "#snap")

      # Seed modes cache via 324 RPL_CHANNELMODEIS
      IRCServer.feed(irc_server, ":irc.test.org 324 grappa-snap #snap +nt\r\n")
      flush_server(irc_server)

      topic = Topic.channel(user.name, network.slug, "#snap")

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{kind: :channel_modes_changed, channel: "#snap", modes: %{modes: modes}})
      assert "n" in modes
      assert "t" in modes
    end

    test "after-join snapshot: pushes the network's ISUPPORT capability set (#216)" do
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)

      welcome_session_on_channel(irc_server, "#snap")

      # Advertise a non-default CHANMODES/PREFIX so we can tell the pushed
      # snapshot came from the live session, not cic's built-in default.
      IRCServer.feed(
        irc_server,
        ":irc.test.org 005 grappa-snap CHANMODES=beI,k,l,imnpst PREFIX=(qaohv)~&@%+ :are supported\r\n"
      )

      flush_server(irc_server)

      topic = Topic.channel(user.name, network.slug, "#snap")

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{
        kind: :isupport_changed,
        network_id: net_id,
        prefix: prefix
      })

      assert net_id == network.id
      assert prefix["q"] == "~"
    end

    test "after-join snapshot: no push when no session is running for channel" do
      user_name = "ch-nosession-#{System.unique_integer([:positive])}"
      net_slug = "nosession-net-#{System.unique_integer([:positive])}"
      # No session started — snapshot is best-effort, no crash expected
      topic = Topic.channel(user_name, net_slug, "#nowhere")

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      # No topic_changed push; no crash
      refute_push("event", %{kind: :topic_changed}, 100)
      refute_push("event", %{kind: :channel_modes_changed}, 100)
      # CP15 B3 closes the deploy-reconnect race for window_state +
      # members too; cold subscribe with no session must not push these.
      refute_push("event", %{kind: :joined}, 100)
      refute_push("event", %{kind: :kicked}, 100)
      refute_push("event", %{kind: :join_failed}, 100)
      refute_push("event", %{kind: :members_seeded}, 100)
    end

    test "after-join snapshot: pushes cached members_seeded if session has members for channel (CP15 B3)" do
      # B3 deploy-reconnect race fix: cic reconnects to a session whose
      # members_seeded broadcast already fired before the WS subscribe
      # landed → without snapshot push, cic's members pane stays empty.
      # The snapshot push closes the race by re-emitting the seeded list
      # on the cold subscribe.
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)

      welcome_session_on_channel(irc_server, "#snap")

      # Seed members via 353 RPL_NAMREPLY + 366 RPL_ENDOFNAMES.
      IRCServer.feed(
        irc_server,
        ":irc.test.org 353 grappa-snap = #snap :@op_a +voice_a plain_b\r\n"
      )

      IRCServer.feed(
        irc_server,
        ":irc.test.org 366 grappa-snap #snap :End of /NAMES list\r\n"
      )

      flush_server(irc_server)

      topic = Topic.channel(user.name, network.slug, "#snap")

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{
        kind: :members_seeded,
        channel: "#snap",
        members: members
      })

      assert Enum.any?(members, &match?(%{nick: "op_a"}, &1))
      assert Enum.any?(members, &match?(%{nick: "voice_a"}, &1))
      assert Enum.any?(members, &match?(%{nick: "plain_b"}, &1))
    end

    test "after-join snapshot: pushes window_state joined when session is in :joined state (CP15 B3)" do
      # Same race motivation as members_seeded: B1's :joined broadcast
      # may have fired before WS subscribe; the snapshot push must
      # re-emit it so cic transitions the window from :pending to
      # :joined on reconnect without polling.
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)

      # welcome_session_on_channel feeds the self-JOIN echo, which sets
      # window_states["#snap"] = :joined via the B1 apply_effects arm.
      welcome_session_on_channel(irc_server, "#snap")

      topic = Topic.channel(user.name, network.slug, "#snap")

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{
        kind: :joined,
        channel: "#snap",
        state: "joined"
      })
    end

    test "after-join snapshot: pushes window_state kicked with by + reason when session is :kicked (CP15 B3)" do
      # Snapshot payload must be byte-identical to the event-time
      # broadcast — including by + reason — so cic's renderer doesn't
      # branch on origin. Validates the window_kicked_meta mirror map.
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)

      welcome_session_on_channel(irc_server, "#snap")

      # Drive into :kicked via an inbound KICK targeting our nick.
      IRCServer.feed(irc_server, ":alice!u@h KICK #snap grappa-snap :behave\r\n")
      flush_server(irc_server)

      topic = Topic.channel(user.name, network.slug, "#snap")

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{
        kind: :kicked,
        channel: "#snap",
        state: "kicked",
        by: "alice",
        reason: "behave"
      })
    end

    test "after-join snapshot: pushes cached members_seeded for visitor subjects (2026-05-27)" do
      # Pre-fix `push_channel_snapshot/4` routed through `safe_get_user/1`
      # which raised `Ecto.NoResultsError` on the `"visitor:" <> id`
      # prefix and was rescued to `:error` — visitor snapshots never
      # pushed. Live incident: a visitor `/join`ed `#sbiffo`, server
      # received NAMES (state.members + seeded_channels populated) and
      # broadcast `members_seeded` BEFORE cic's WS topic subscribe
      # landed → no subscriber, broadcast dropped → cic's MembersPane
      # stayed empty. The user-class equivalent of this test
      # ("CP15 B3") already covered the user path; this is the visitor
      # parity case.
      {irc_server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)

      welcome_visitor_on_channel(
        irc_server,
        {:visitor, visitor.id},
        network.id,
        visitor_nick(visitor),
        "#snap"
      )

      IRCServer.feed(
        irc_server,
        ":irc.test.org 353 #{visitor_nick(visitor)} = #snap :@op_a +voice_a plain_b\r\n"
      )

      IRCServer.feed(
        irc_server,
        ":irc.test.org 366 #{visitor_nick(visitor)} #snap :End of /NAMES list\r\n"
      )

      flush_server(irc_server)

      topic = Topic.channel("visitor:" <> visitor.id, network.slug, "#snap")

      {:ok, _, _} =
        ("visitor:" <> visitor.id)
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{
        kind: :members_seeded,
        channel: "#snap",
        members: members
      })

      assert Enum.any?(members, &match?(%{nick: "op_a"}, &1))
      assert Enum.any?(members, &match?(%{nick: "voice_a"}, &1))
      assert Enum.any?(members, &match?(%{nick: "plain_b"}, &1))
    end

    test "after-join snapshot: pushes window_state join_failed with reason + numeric when session is :failed (CP15 B3)" do
      # Validates the window_failure_numerics mirror — the snapshot
      # carries `numeric` as a stable cross-language key for a future
      # cic-side i18n layer (server-provided reasons are
      # upstream-language-locked; numerics are RFC).
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)

      :ok = await_handshake(irc_server)
      IRCServer.feed(irc_server, ":irc.test.org 001 grappa-snap :Welcome\r\n")
      {:ok, _} = IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "JOIN #snap"), 1_000)

      # Now feed a 473 ERR_INVITEONLYCHAN — autojoin recorded
      # in_flight_joins["#snap"] so the failure correlates and
      # window_states["#snap"] flips to :failed.
      IRCServer.feed(
        irc_server,
        ":irc.test.org 473 grappa-snap #snap :Cannot join channel (+i)\r\n"
      )

      flush_server(irc_server)

      topic = Topic.channel(user.name, network.slug, "#snap")

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{
        kind: :join_failed,
        channel: "#snap",
        state: "failed",
        reason: "Cannot join channel (+i)",
        numeric: 473
      })
    end
  end

  # CP29 R-3 — channel join reply carries the current read cursor (or
  # nil when no cursor exists yet). cic uses this to skip a per-window
  # REST round-trip on subscribe; the bulk envelope from /me is the
  # boot-time path.
  describe "join reply — read cursor (CP29 R-3) + unread count (2026-06-01)" do
    test "channel topic join returns nil cursor + zero unread when no cursor exists and channel empty" do
      user_name = "rc-cursor-nil-#{System.unique_integer([:positive])}"
      _ = user_fixture(name: user_name)

      {:ok, network} =
        Networks.find_or_create_network(%{slug: "rc-net-#{System.unique_integer([:positive])}"})

      topic = Topic.channel(user_name, network.slug, "#fresh")

      {:ok, reply, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert reply == %{
               read_cursor: nil,
               window_counts: %{messages: 0, mentions: 0, events: 0, severity: :none}
             }
    end

    test "channel topic join returns the cursor id and unread count (cursor at tail → 0)" do
      user_name = "rc-cursor-hit-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)

      {:ok, network} =
        Networks.find_or_create_network(%{slug: "rc-net-#{System.unique_integer([:positive])}"})

      {:ok, msg} =
        ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#hit",
          server_time: 1,
          kind: :privmsg,
          sender: "vjt",
          body: "hi"
        })

      {:ok, _} = Grappa.ReadCursor.set({:user, user.id}, network.id, "#hit", msg.id)

      topic = Topic.channel(user_name, network.slug, "#hit")

      {:ok, reply, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert reply == %{
               read_cursor: msg.id,
               window_counts: %{messages: 0, mentions: 0, events: 0, severity: :none}
             }
    end

    test "channel topic join surfaces the unread count when rows exist past the cursor" do
      user_name = "rc-unread-count-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)

      {:ok, network} =
        Networks.find_or_create_network(%{slug: "rc-net-#{System.unique_integer([:positive])}"})

      {:ok, anchor} =
        ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#busy",
          server_time: 1,
          kind: :privmsg,
          sender: "vjt",
          body: "old"
        })

      {:ok, _} = Grappa.ReadCursor.set({:user, user.id}, network.id, "#busy", anchor.id)

      for i <- 1..3 do
        {:ok, _} =
          ScrollbackHelpers.insert(%{
            user_id: user.id,
            network_id: network.id,
            channel: "#busy",
            server_time: 1 + i,
            kind: :privmsg,
            sender: "peer",
            body: "msg #{i}"
          })
      end

      topic = Topic.channel(user_name, network.slug, "#busy")

      {:ok, reply, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert reply == %{
               read_cursor: anchor.id,
               window_counts: %{messages: 3, mentions: 0, events: 0, severity: :message}
             }
    end

    test "channel topic join with no cursor yet counts every row as unread" do
      user_name = "rc-no-cursor-all-unread-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)

      {:ok, network} =
        Networks.find_or_create_network(%{slug: "rc-net-#{System.unique_integer([:positive])}"})

      for i <- 1..2 do
        {:ok, _} =
          ScrollbackHelpers.insert(%{
            user_id: user.id,
            network_id: network.id,
            channel: "#never-opened",
            server_time: i,
            kind: :privmsg,
            sender: "peer",
            body: "msg #{i}"
          })
      end

      topic = Topic.channel(user_name, network.slug, "#never-opened")

      {:ok, reply, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert reply == %{
               read_cursor: nil,
               window_counts: %{messages: 2, mentions: 0, events: 0, severity: :message}
             }
    end

    test "channel topic join surfaces the unread count for visitor subjects too" do
      slug = "rc-net-visitor-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})
      visitor = visitor_fixture(network_slug: slug)

      {:ok, anchor} =
        ScrollbackHelpers.insert(%{
          visitor_id: visitor.id,
          network_id: network.id,
          channel: "#visited",
          server_time: 1,
          kind: :privmsg,
          sender: "vjt",
          body: "anchor"
        })

      {:ok, _} = Grappa.ReadCursor.set({:visitor, visitor.id}, network.id, "#visited", anchor.id)

      for i <- 1..2 do
        {:ok, _} =
          ScrollbackHelpers.insert(%{
            visitor_id: visitor.id,
            network_id: network.id,
            channel: "#visited",
            server_time: 1 + i,
            kind: :privmsg,
            sender: "peer",
            body: "msg #{i}"
          })
      end

      topic = Topic.channel("visitor:" <> visitor.id, network.slug, "#visited")

      {:ok, reply, _} =
        ("visitor:" <> visitor.id)
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert reply == %{
               read_cursor: anchor.id,
               window_counts: %{messages: 2, mentions: 0, events: 0, severity: :message}
             }
    end

    test "user-level topic join returns an empty join reply (no cursor concept)" do
      user_name = "rc-user-empty-#{System.unique_integer([:positive])}"
      _ = user_fixture(name: user_name)

      topic = Topic.user(user_name)

      {:ok, reply, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert reply == %{}
    end
  end

  describe "join grappa:user:{user}" do
    test "subscribes to the user-level topic and pushes events verbatim" do
      user_name = "ch_user_test-#{System.unique_integer([:positive])}"
      topic = Topic.user(user_name)

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      payload = %{kind: :motd, body: "welcome"}
      Grappa.PubSub.broadcast_event(topic, payload)

      assert_push("event", ^payload)
    end

    # #364 web S4 — the #247 after-join snapshot pushes (push_notify_list +
    # push_presence_if_live) had zero channel-test coverage. These pin the
    # three contract branches: the full notify_list snapshot always fires;
    # presence_snapshot fires per bound network with a live, non-empty map;
    # it is skipped when no session is running.
    test "user-topic join pushes the notify_list snapshot (#364 web S4)" do
      user_name = "ch-notify-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)

      {:ok, network} =
        Networks.find_or_create_network(%{slug: "notify-snap-#{System.unique_integer([:positive])}"})

      {:ok, _} = Grappa.Notify.add({:user, user.id}, network.id, ["Foo"], user_name)

      topic = Topic.user(user_name)

      {:ok, _, _} =
        user_name
        |> build_socket(subject: {:user, user.id})
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{kind: "notify_list", networks: networks})
      assert [%{nick: "Foo"}] = networks[network.id]
    end

    test "user-topic join skips presence_snapshot when no session is live (#364 web S4)" do
      user_name = "ch-nopres-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)

      {:ok, network} =
        Networks.find_or_create_network(%{slug: "nopres-#{System.unique_integer([:positive])}"})

      # A watch entry exists but NO Session.Server runs (parked/absent), so
      # presence_snapshot has nothing live to read → must be skipped.
      {:ok, _} = Grappa.Notify.add({:user, user.id}, network.id, ["Foo"], user_name)

      topic = Topic.user(user_name)

      {:ok, _, _} =
        user_name
        |> build_socket(subject: {:user, user.id})
        |> subscribe_and_join(topic, %{})

      # notify_list still fires (DB read); presence_snapshot never does.
      assert_push("event", %{kind: "notify_list"})
      refute_push("event", %{kind: :presence_snapshot}, 100)
    end

    test "user-topic join pushes presence_snapshot for a live non-empty map (#364 web S4)" do
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)

      # Seed the watch list BEFORE end-of-MOTD so arm_presence reads it.
      {:ok, _} = Grappa.Notify.add({:user, user.id}, network.id, ["Foo"], user.name)

      :ok = await_handshake(irc_server)
      IRCServer.feed(irc_server, ":irc.test.org 001 grappa-snap :Welcome\r\n")
      IRCServer.feed(irc_server, ":irc.test.org 005 grappa-snap WATCH=128 :are supported\r\n")
      IRCServer.feed(irc_server, ":irc.test.org 376 grappa-snap :End of MOTD\r\n")
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "WATCH +Foo\r\n"), 1_000)

      # Baseline: Foo already online — populates the session presence map.
      IRCServer.feed(irc_server, ":irc.test.org 604 grappa-snap Foo user host 0 :is online\r\n")
      flush_server(irc_server)

      topic = Topic.user(user.name)

      {:ok, _, _} =
        user.name
        |> build_socket(subject: {:user, user.id})
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{kind: :presence_snapshot, network_id: nid, nicks: %{"foo" => :online}})
      assert nid == network.id
    end

    # BUG 6 regression: every channel topic used to have TWO subscribers
    # (the channel pid registered twice — manual subscribe with no metadata
    # AND the framework's auto-installed fastlane), so a single broadcast
    # produced TWO WS pushes per connected socket. Cicchetto's sidebar bumped
    # the unread badge by 2 on every PRIVMSG. Fix: removed the manual
    # `Phoenix.PubSub.subscribe/2` from `GrappaChannel.join/3` and migrated
    # all broadcasters to `Grappa.PubSub.broadcast_event/2` (which goes
    # through `Phoenix.Channel.Server.broadcast/4` and the framework's
    # fastlane). One broadcast → exactly one push.
    test "BUG 6 regression: one broadcast_event yields exactly ONE push per socket" do
      user_name = "ch_bug6-#{System.unique_integer([:positive])}"
      topic = Topic.user(user_name)

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      payload = %{kind: :motd, body: "single please"}
      Grappa.PubSub.broadcast_event(topic, payload)

      # First push must arrive...
      assert_push("event", ^payload, 200)
      # ...and no second push must follow.
      refute_push("event", ^payload, 200)
    end

    # BUG 6 regression on the channel-level topic — the topic shape that
    # actually triggered the user-visible badge=2 bug (sidebar message
    # counter for #grappa).
    test "BUG 6 regression: channel-level broadcast_event yields exactly ONE push" do
      user_name = "ch_bug6_chan-#{System.unique_integer([:positive])}"
      topic = Topic.channel(user_name, "irc.example", "#grappa")

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      payload = %{kind: "message", message: %{body: "ciao"}}
      Grappa.PubSub.broadcast_event(topic, payload)

      assert_push("event", ^payload, 200)
      refute_push("event", ^payload, 200)
    end

    test "after-join snapshot: visitor socket receives query_windows_list (V2 visitor parity)" do
      # V2 visitor parity (2026-05-15): visitor sockets get the same
      # after_join query_windows_list snapshot as user sockets, so cic
      # restores DM windows across reload regardless of subject kind.
      # Pre-V2 the snapshot was visitor-skipped; V2 lifts the skip.
      visitor_name = "visitor:#{Ecto.UUID.generate()}"
      topic = Topic.user(visitor_name)

      {:ok, _, _} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{kind: "query_windows_list", windows: %{}}, 200)
    end

    test "after-join snapshot: authenticated user receives query_windows_list (empty when no windows)" do
      user_name = "qwsnap-#{System.unique_integer([:positive])}"
      user_fixture(name: user_name)
      topic = Topic.user(user_name)

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      # Must receive query_windows_list with empty map
      assert_push("event", %{kind: "query_windows_list", windows: windows})
      assert windows == %{}
    end

    test "after-join snapshot: query_windows_list includes pre-existing open windows" do
      user_name = "qwsnap2-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)
      {:ok, network} = Networks.find_or_create_network(%{slug: "qwsnet-#{System.unique_integer([:positive])}"})
      {:ok, _} = QueryWindows.open({:user, user.id}, network.id, "alice", user_name)

      topic = Topic.user(user_name)

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{kind: "query_windows_list", windows: windows})
      assert is_map(windows)
      nicks = windows |> Map.values() |> List.flatten() |> Enum.map(& &1.target_nick)
      assert "alice" in nicks
    end

    test "after-join snapshot: pushes the session's umodes on the user topic (#229)" do
      # #229 cold-WS-subscribe race: umodes are per-session (reachable with
      # ZERO channels), so — unlike #216's per-channel isupport snapshot —
      # the umode snapshot rides the USER-topic after_join. cic reconnects
      # its WS long after the 221 RPL_UMODEIS fired, so without this the
      # /mode <nick> modal would stay blank until a mid-session change.
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)

      welcome_session_on_channel(irc_server, "#snap")

      # The upstream reports the connect-time umode set (answering the
      # welcome-time bare MODE query).
      IRCServer.feed(irc_server, ":irc.test.org 221 grappa-snap +iwS\r\n")
      flush_server(irc_server)

      topic = Topic.user(user.name)

      {:ok, _, _} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{kind: :umode_changed, network_id: net_id, modes: modes})
      assert net_id == network.id
      assert modes == ["S", "i", "w"]
    end

    # CP23 S4 B4 — bundle_hash push on user-topic join.
    #
    # The `Grappa.Cic.Bundle` reader live-reads `runtime/cicchetto-dist/
    # index.html` on every call. In the test env that file may or may
    # not exist (cicchetto-build is a prod-profile oneshot, not a test
    # prereq). Both shapes are valid contract: hash present → push;
    # absent → skip silently.
    test "after-join snapshot: pushes bundle_hash when cic bundle is on disk, otherwise skips" do
      user_name = "bundlehash-#{System.unique_integer([:positive])}"
      user_fixture(name: user_name)
      topic = Topic.user(user_name)

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      # Drain query_windows_list snapshot first (always pushed for users).
      assert_push("event", %{kind: "query_windows_list"})

      case Grappa.Cic.Bundle.current_hash() do
        nil ->
          refute_push("event", %{kind: "bundle_hash"}, 100)

        hash when is_binary(hash) ->
          assert_push("event", %{kind: "bundle_hash", hash: ^hash})
      end
    end

    test "after-join snapshot: visitor socket also receives bundle_hash when bundle exists" do
      visitor_name = "visitor:#{Ecto.UUID.generate()}"
      topic = Topic.user(visitor_name)

      {:ok, _, _} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      case Grappa.Cic.Bundle.current_hash() do
        nil ->
          refute_push("event", %{kind: "bundle_hash"}, 100)

        hash when is_binary(hash) ->
          assert_push("event", %{kind: "bundle_hash", hash: ^hash})
      end
    end

    # UX-6-B2 (2026-05-21) — `server_settings_changed` after-join push.
    # Cold-WS-subscribe parity with the put-time fan-out emitted by
    # `Admin.SettingsController.update/2`: cic's reactive
    # `serverSettings()` signal is populated before the first
    # ComposeBox render reads `activeHost()`. Parity-with-bundle_hash
    # test pattern.
    test "after-join snapshot: pushes server_settings_changed for user socket" do
      user_name = "settingssnap-#{System.unique_integer([:positive])}"
      user_fixture(name: user_name)
      topic = Topic.user(user_name)

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{
        kind: "server_settings_changed",
        upload: %{
          active_host: active_host,
          image_per_file_cap_bytes: image_cap,
          video_per_file_cap_bytes: video_cap,
          document_per_file_cap_bytes: document_cap,
          audio_per_file_cap_bytes: audio_cap,
          global_cap_bytes: global_cap_bytes
        }
      })

      assert active_host in [:embedded, :litterbox]
      assert is_integer(image_cap) and image_cap > 0
      assert is_integer(video_cap) and video_cap > 0
      assert is_integer(document_cap) and document_cap > 0
      assert is_integer(audio_cap) and audio_cap > 0
      assert is_integer(global_cap_bytes) and global_cap_bytes > 0
    end

    test "after-join snapshot: pushes server_settings_changed for visitor socket" do
      visitor_name = "visitor:#{Ecto.UUID.generate()}"
      topic = Topic.user(visitor_name)

      {:ok, _, _} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{
        kind: "server_settings_changed",
        upload: %{active_host: active_host}
      })

      assert active_host in [:embedded, :litterbox]
    end

    test "after-join snapshot: query_windows_list payload is JSON-serializable (regression)" do
      # Regression: the prod bug raised Protocol.UndefinedError for
      # Jason.Encoder on %QueryWindows.Window{} structs because the schema
      # was pushed verbatim. The fix renders to plain maps at the boundary;
      # this test guards by exercising the actual JSON encoder path.
      user_name = "qwjson-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)
      {:ok, network} = Networks.find_or_create_network(%{slug: "qwjsonnet-#{System.unique_integer([:positive])}"})
      {:ok, _} = QueryWindows.open({:user, user.id}, network.id, "bob", user_name)

      topic = Topic.user(user_name)

      {:ok, _, _} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{kind: "query_windows_list", windows: windows} = payload)
      # Push through Jason — Window schema would raise Protocol.UndefinedError.
      assert {:ok, json} = Jason.encode(payload)
      assert is_binary(json)
      assert json =~ "bob"
      # Each rendered window is a map with the three published fields.
      [first | _] = windows |> Map.values() |> List.flatten()
      assert %{network_id: _, target_nick: "bob", opened_at: opened_at} = first
      assert is_binary(opened_at)
    end
  end

  describe "join authz — cross-user topics are forbidden" do
    test "user-level topic of a different user returns forbidden" do
      assert {:error, %{error: "forbidden"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join(Topic.user("alice"), %{})
    end

    test "network-level topic of a different user returns forbidden" do
      assert {:error, %{error: "forbidden"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join(Topic.network("alice", "azzurra"), %{})
    end

    test "channel-level topic of a different user returns forbidden" do
      assert {:error, %{error: "forbidden"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join(Topic.channel("alice", "azzurra", "#sniffo"), %{})
    end
  end

  # ---------------------------------------------------------------------------
  # S5.3 — inbound ops events
  # ---------------------------------------------------------------------------
  #
  # Each test joins the user-level topic (simplest join shape), pushes an
  # event, and verifies:
  #   - The reply to the push is `:ok`.
  #   - The correct IRC line was emitted to the fake upstream.
  #
  # The channel-level join would also work but requires more setup; user-level
  # is sufficient to exercise the handle_in dispatch path.

  describe "S5.3 — ops verbs: inbound channel events" do
    setup do
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)
      welcome_session_on_channel(irc_server, "#snap")
      topic = Topic.user(user.name)

      {:ok, _, socket} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      %{irc_server: irc_server, socket: socket, user: user, network: network}
    end

    test "op: sends MODE #chan +ooo upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "op", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nicks" => ["alice", "bob", "carol"]
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "MODE #snap +ooo"), 1_000)
    end

    test "deop: sends MODE #chan -ooo upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "deop", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nicks" => ["alice", "bob", "carol"]
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "MODE #snap -ooo"), 1_000)
    end

    test "voice: sends MODE #chan +v upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "voice", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nicks" => ["alice"]
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "MODE #snap +v"), 1_000)
    end

    test "devoice: sends MODE #chan -v upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "devoice", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nicks" => ["alice"]
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "MODE #snap -v"), 1_000)
    end

    test "kick: sends KICK #chan nick :reason upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "kick", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nick" => "alice",
          "reason" => "bye"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "KICK #snap alice :bye\r\n"), 1_000)
    end

    test "ban: sends MODE #chan +b with explicit mask", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "ban", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "mask" => "*!*@evil.com"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MODE #snap +b *!*@evil.com\r\n"), 1_000)
    end

    test "unban: sends MODE #chan -b <mask> upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "unban", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "mask" => "*!*@evil.com"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MODE #snap -b *!*@evil.com\r\n"), 1_000)
    end

    test "invite: sends INVITE nick #chan upstream (nick first)", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "invite", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nick" => "alice"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "INVITE alice #snap\r\n"), 1_000)
    end

    test "banlist: sends MODE #chan b (query form, no sign)", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "banlist", %{
          "network_id" => network.id,
          "channel" => "#snap"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MODE #snap b\r\n"), 1_000)
    end

    test "umode: sends MODE own_nick <modes> upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "umode", %{
          "network_id" => network.id,
          "modes" => "+i"
        })

      assert_reply(ref, :ok)
      # grappa-snap is the nick used in setup
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MODE grappa-snap +i\r\n"), 1_000)
    end

    test "mode: sends raw verbatim MODE line, no chunking", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "mode", %{
          "network_id" => network.id,
          "target" => "#snap",
          "modes" => "+o-v",
          "params" => ["alice", "bob"]
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MODE #snap +o-v alice bob\r\n"), 1_000)
    end

    test "op: unknown network_id returns {:error, network_not_found}", %{socket: socket} do
      ref =
        push(socket, "op", %{
          "network_id" => 999_999,
          "channel" => "#snap",
          "nicks" => ["alice"]
        })

      assert_reply(ref, :error, %{error: "no_session"})
    end

    test "op (REV-E HIGH-1): dead Session.Server socket → typed upstream_unavailable reply, Channel survives",
         %{socket: socket, network: network, user: user} do
      # REV-E (H11) widened `Session.send_op/4`'s return shape from
      # `{:error, :no_session}` to include the dead-socket family
      # (`:no_socket | :closed | :invalid_line | :inet.posix()`). Pre-fix
      # the `dispatch_ops_verb/3` `with`/`else` chain had no arm for
      # those — the WITH-chain would have raised `WithClauseError`,
      # crashing the Channel process (same crash class as the original
      # MatchError, different victim).
      #
      # Repro: find the running Session.Server's linked Client pid and
      # nil its socket via `:sys.replace_state`, then fire /op. The
      # Channel's catch-all maps to `upstream_unavailable` and the
      # process stays alive.
      session_pid = Grappa.Session.whereis({:user, user.id}, network.id)
      assert is_pid(session_pid), "session must be live for this regression"

      client_pid = :sys.get_state(session_pid).client
      :sys.replace_state(client_pid, fn cs -> %{cs | socket: nil} end)

      socket_channel_pid = socket.channel_pid

      ref =
        push(socket, "op", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nicks" => ["alice"]
        })

      assert_reply(ref, :error, %{error: "upstream_unavailable"})
      assert Process.alive?(socket_channel_pid), "Channel process must survive dead-socket /op"
      assert Process.alive?(session_pid), "Session.Server must survive dead-socket /op"
    end

    # Issue #153 (P0): every state-changing verb is visitor-eligible. A
    # VISITOR socket pushing "op" must NOT short-circuit — it reaches
    # `Session.send_op` and ships MODE upstream on the visitor's OWN
    # session (mirror of the #148 /oper carve-out, now generalized to
    # every verb). Safe because the registry key includes the
    # `{:visitor, id}` subject tag, so the visitor mode-sets only its own
    # upstream IRC link; the ircd is authoritative on channel-op status.
    # Pre-#153 this replied `visitor_not_allowed` via the removed
    # `dispatch_ops_verb`/`check_not_visitor` gate.
    test "op: visitor socket ships MODE upstream (issue #153 — no visitor gate)" do
      {server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "op", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nicks" => ["alice"]
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "MODE #snap +o alice"), 1_000)
    end

    test "topic_set: sends TOPIC #chan :text upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "topic_set", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "text" => "new topic text"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "TOPIC #snap :new topic text\r\n"), 1_000)
    end

    test "topic_set: rejects CRLF/NUL in text at the channel boundary", %{
      socket: socket,
      network: network
    } do
      for evil <- ["new\r\nQUIT :pwn", "new\nfoo", "new\rfoo", "new\x00foo"] do
        ref =
          push(socket, "topic_set", %{
            "network_id" => network.id,
            "channel" => "#snap",
            "text" => evil
          })

        assert_reply(ref, :error, %{error: "invalid_line"})
      end
    end

    test "topic_set: rejects malformed channel at the channel boundary", %{
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "topic_set", %{
          "network_id" => network.id,
          "channel" => "#snap\r\nJOIN #pwn",
          "text" => "ok"
        })

      assert_reply(ref, :error, %{error: "invalid_channel"})
    end

    # CP24 bucket E web/S6: tag-by-source regression. Pre-fix the
    # `with`/`else` matched by raw `true`/`false` value so ANY new
    # boolean check above the visitor check would silently flip the
    # error message. These tests pin per-source tag mapping by sending
    # a malformed-AND-visitor payload and asserting the error tag comes
    # from the EARLIER check (channel/line gates), NOT the later one
    # (`visitor_not_allowed`) — proving the `with` short-circuits at
    # the right step and the `else` arm targets the correct source.
    test "topic_set: visitor + invalid_channel returns invalid_channel (earlier source wins)" do
      visitor_name = "visitor:#{Ecto.UUID.generate()}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "topic_set", %{
          "network_id" => 1,
          "channel" => "#snap\r\nQUIT :pwn",
          "text" => "ok"
        })

      assert_reply(ref, :error, %{error: "invalid_channel"})
    end

    # Issue #153: topic_set is visitor-eligible. A VISITOR with a live
    # session ships TOPIC upstream (pre-#153 this replied
    # `visitor_not_allowed` via the removed topic_set_dispatch gate). The
    # "earlier source wins" test above still pins that validate_args
    # runs BEFORE identity resolution — a malformed channel from a
    # visitor is still rejected with `invalid_channel`, not dispatched.
    test "topic_set: visitor socket ships TOPIC upstream (issue #153)" do
      {server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "topic_set", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "text" => "visitor topic"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "TOPIC #snap :visitor topic\r\n"), 1_000)
    end

    test "topic_clear: sends TOPIC #chan : (empty trailing) upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "topic_clear", %{
          "network_id" => network.id,
          "channel" => "#snap"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "TOPIC #snap :\r\n"), 1_000)
    end

    # Bundle C (#20 follow-up) — /oper bridge
    test "oper: sends OPER <name> <password> upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "oper", %{
          "network_id" => network.id,
          "name" => "vjt",
          "password" => "s3cret"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "OPER vjt s3cret\r\n"), 1_000)
    end

    # Issue #148 (P0): /oper is visitor-eligible. A VISITOR socket pushing
    # "oper" must NOT short-circuit with `visitor_not_allowed` — it reaches
    # `Session.send_oper` and ships OPER upstream on the visitor's OWN
    # session. Safe because the registry key includes the `{:visitor, id}`
    # subject tag (`Session.Server.registry_key/2`), so the visitor opers
    # only its own upstream IRC link (no shared/pooled session), and the
    # ircd O:line is authoritative on whether the creds are accepted. #153
    # generalized this to EVERY verb — see the sibling "op:/topic_set:/raw:
    # visitor socket ships … upstream" tests.
    test "oper: visitor socket ships OPER upstream (issue #148 — not visitor_not_allowed)" do
      {server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "oper", %{
          "network_id" => network.id,
          "name" => "testoper",
          "password" => "testoperpass"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "OPER testoper testoperpass\r\n"), 1_000)
    end

    test "oper: rejects CRLF in either field at the channel boundary", %{
      socket: socket,
      network: network
    } do
      for evil <- ["bad\r\nKILL", "bad\nfoo", "bad\rfoo", "bad\x00foo"] do
        ref_a =
          push(socket, "oper", %{
            "network_id" => network.id,
            "name" => evil,
            "password" => "pw"
          })

        assert_reply(ref_a, :error, %{error: "invalid_line"})

        ref_b =
          push(socket, "oper", %{
            "network_id" => network.id,
            "name" => "vjt",
            "password" => evil
          })

        assert_reply(ref_b, :error, %{error: "invalid_line"})
      end
    end

    # Bundle C (#20 follow-up) — stricter `:oper_token` validator
    # rejects empty fields and embedded whitespace at the channel
    # boundary (defense-in-depth — Session.send_oper also gates, but
    # this catches malformed pushes before they hop the GenServer).
    test "oper: rejects empty name or password at the channel boundary", %{
      socket: socket,
      network: network
    } do
      for {name, pw} <- [{"", "pw"}, {"vjt", ""}, {"", ""}] do
        ref =
          push(socket, "oper", %{
            "network_id" => network.id,
            "name" => name,
            "password" => pw
          })

        assert_reply(ref, :error, %{error: "invalid_line"})
      end
    end

    test "oper: rejects whitespace in name or password at the channel boundary", %{
      socket: socket,
      network: network
    } do
      for {name, pw} <- [
            {"vjt extra", "pw"},
            {"vjt", "pw with spaces"},
            {"vjt\textra", "pw"}
          ] do
        ref =
          push(socket, "oper", %{
            "network_id" => network.id,
            "name" => name,
            "password" => pw
          })

        assert_reply(ref, :error, %{error: "invalid_line"})
      end
    end

    # Bundle C (#20 follow-up) — /quote bridge
    test "raw: ships the line verbatim with trailing CRLF", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "raw", %{
          "network_id" => network.id,
          "line" => "PING :foo.bar"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "PING :foo.bar\r\n"), 1_000)
    end

    test "raw: rejects embedded CRLF (no frame-smuggling)", %{
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "raw", %{
          "network_id" => network.id,
          "line" => "PING\r\nQUIT :pwn"
        })

      assert_reply(ref, :error, %{error: "invalid_line"})
    end

    # Issue #153: /quote (the raw escape hatch) is visitor-eligible. A
    # VISITOR ships the raw line verbatim upstream — the ircd/services are
    # the authority on what the line is allowed to do; the bouncer keeps
    # only the CRLF/NUL frame-safety gate (asserted by the sibling
    # "raw: rejects embedded CRLF" test, which still holds for visitors
    # since validate_args runs before identity resolution).
    test "raw: visitor socket ships the line verbatim upstream (issue #153)" do
      {server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "raw", %{
          "network_id" => network.id,
          "line" => "PING :visitor-raw-153"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PING :visitor-raw-153\r\n"), 1_000)
    end

    # CP22 cluster B (channel-client-polish #14) — /who bridge: cic pushes
    # `"who"` with %{network_id, channel}; channel relays to
    # Session.send_who/3, which primes who_pending + emits WHO upstream.
    # Smoke-tests the dispatch plumbing (the bundle / persist / broadcast
    # paths are covered by Session.Server end-to-end tests).
    test "who: sends WHO #chan upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "who", %{
          "network_id" => network.id,
          "channel" => "#snap"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "WHO #snap\r\n"), 1_000)
    end

    # #221 — /who <mask> bridge: a host/nick mask is a legitimate WHO target
    # (RFC 2812 §3.6.1), NOT just a channel. Pre-#221 the channel handler
    # validated `:channel`, so a mask bounced with invalid_channel and never
    # reached upstream. Now validated as `:who_target` (single wire token).
    test "who: sends WHO <mask> upstream for a host mask", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "who", %{
          "network_id" => network.id,
          "channel" => "*!*@*.libera.chat"
        })

      assert_reply(ref, :ok)

      {:ok, _} =
        IRCServer.wait_for_line(irc_server, &(&1 == "WHO *!*@*.libera.chat\r\n"), 1_000)
    end

    test "who: rejects a whitespace-splicing target with invalid_mask", %{
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "who", %{
          "network_id" => network.id,
          "channel" => "*!*@x y"
        })

      assert_reply(ref, :error, %{error: "invalid_mask"})
    end

    # CP22 cluster B (channel-client-polish #14) — /names bridge: cic
    # pushes `"names"` with %{network_id, channel}; channel relays to
    # Session.send_names/3, which primes names_pending + emits NAMES
    # upstream. Smoke-tests the dispatch plumbing (the fold + drain +
    # persist paths are covered by Session.Server end-to-end tests).
    test "names: sends NAMES #chan upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "names", %{
          "network_id" => network.id,
          "channel" => "#snap"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "NAMES #snap\r\n"), 1_000)
    end

    # #127 — /info, /version, /motd bridges: cic pushes the bare verb with
    # %{network_id}; the channel relays to Session.send_{info,version,motd}/2
    # which primes the matching accumulator + emits the command upstream.
    # Smoke-tests the dispatch plumbing (the drain + broadcast paths are
    # covered by the EventRouter #127 tests).
    test "info: sends INFO upstream", %{irc_server: irc_server, socket: socket, network: network} do
      ref = push(socket, "info", %{"network_id" => network.id})

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "INFO\r\n"), 1_000)
    end

    test "version: sends VERSION upstream", %{
      irc_server: irc_server,
      socket: socket,
      network: network
    } do
      ref = push(socket, "version", %{"network_id" => network.id})

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "VERSION\r\n"), 1_000)
    end

    test "motd: sends MOTD upstream", %{irc_server: irc_server, socket: socket, network: network} do
      ref = push(socket, "motd", %{"network_id" => network.id})

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MOTD\r\n"), 1_000)
    end

    test "whois (REV-F H10): dead Session.Server socket → typed upstream_unavailable reply, Channel survives",
         %{socket: socket, network: network, user: user} do
      # REV-F (H10): `dispatch_subject_verb/3` (sister of `dispatch_ops_verb/3`)
      # was missing the catch-all `{:error, reason}` arm REV-E HIGH-1 added
      # to its sibling. `Session.send_whois/4` (and other subject-verb
      # facades — `send_who`, `send_names`, `send_banlist`) post-U-cluster
      # CAN return `Session.send_transport_error/0` shapes (`:no_socket
      # | :closed | :inet.posix()`) when the underlying client socket is
      # dead. Pre-REV-F those crashed the Channel pid with
      # `WithClauseError` — same crash class as REV-E HIGH-1 relocated
      # to the sibling helper.
      #
      # Repro mirrors the REV-E HIGH-1 test exactly (line 959), only
      # the verb differs (whois vs op) to exercise the subject-verb
      # path instead of ops-verb.
      session_pid = Grappa.Session.whereis({:user, user.id}, network.id)
      assert is_pid(session_pid), "session must be live for this regression"

      client_pid = :sys.get_state(session_pid).client
      :sys.replace_state(client_pid, fn cs -> %{cs | socket: nil} end)

      socket_channel_pid = socket.channel_pid

      ref =
        push(socket, "whois", %{
          "network_id" => network.id,
          "nick" => "alice"
        })

      assert_reply(ref, :error, %{error: "upstream_unavailable"})
      assert Process.alive?(socket_channel_pid), "Channel process must survive dead-socket /whois"
      assert Process.alive?(session_pid), "Session.Server must survive dead-socket /whois"
    end
  end

  # C3 (CRITICAL — 2026-05-12 codebase review): WHOIS is a read-only verb
  # carved out of the visitor-rejection rule (see `dispatch_subject_verb/2`
  # contract in grappa_channel.ex). Visitor sockets pushing `"whois"` MUST
  # reach `Session.send_whois({:visitor, _}, ...)` instead of bouncing on
  # `visitor_not_allowed`. Pre-fix the implementation routed through
  # `dispatch_ops_verb/2` despite the comment flagging the bug, so the
  # visitor reply was `visitor_not_allowed` for every WHOIS — these tests
  # pin the post-fix behaviour and would have caught the original
  # asymmetry.
  describe "C3 — visitor WHOIS dispatch carve-out" do
    test "visitor socket: whois with live session sends WHOIS upstream" do
      {irc_server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(irc_server)
      IRCServer.feed(irc_server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")
      flush_server(irc_server)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "whois", %{
          "network_id" => network.id,
          "nick" => "alice"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "WHOIS alice\r\n"), 1_000)
    end

    # #198 — two-arg `/whois <server> <nick>` (RFC 2812 §3.6.2 target-server
    # routing). When the push carries a non-null "server" field, the bouncer
    # emits `WHOIS <server> <nick>` upstream so the query is answered by that
    # server; single-arg behaviour is byte-identical when "server" is absent.
    test "visitor socket: whois with server emits WHOIS <server> <nick> upstream (#198)" do
      {irc_server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(irc_server)
      IRCServer.feed(irc_server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")
      flush_server(irc_server)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "whois", %{
          "network_id" => network.id,
          "nick" => "alice",
          "server" => "irc.example.org"
        })

      assert_reply(ref, :ok)

      {:ok, _} =
        IRCServer.wait_for_line(irc_server, &(&1 == "WHOIS irc.example.org alice\r\n"), 1_000)
    end

    test "visitor socket: whois without session returns no_session (NOT visitor_not_allowed)" do
      # No `setup_visitor_and_network_with_session/1` here — the visitor
      # exists but has no live `Session.Server`. The fix MUST surface
      # `no_session` from `Session.send_whois/4` rather than short-circuit
      # on the visitor gate the way the pre-fix `dispatch_ops_verb/2` did.
      slug = "snap-visitor-noses-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})
      visitor = visitor_fixture(network_slug: slug)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "whois", %{
          "network_id" => network.id,
          "nick" => "alice"
        })

      assert_reply(ref, :error, %{error: "no_session"})
    end

    test "visitor socket: whois with malformed nick returns invalid_nick" do
      # Belt-and-braces — bucket E web/S7 added `Identifier.valid_nick?`
      # gate at the channel inbound boundary. Pin that visitors hit the
      # same rejection users do (defense in depth — gate fires BEFORE
      # `Session.send_whois/4` is called).
      {irc_server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(irc_server)
      IRCServer.feed(irc_server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")
      flush_server(irc_server)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "whois", %{
          "network_id" => network.id,
          "nick" => "bad\r\nQUIT"
        })

      assert_reply(ref, :error, %{error: "invalid_nick"})
    end
  end

  # Issue #62: `/away` returned a bare "Send failed" for visitors because
  # the channel `handle_in("away", ...)` arms short-circuited every visitor
  # subject with `visitor_no_away`. The rationale ("the facade only routes
  # to user sessions") was factually wrong — each visitor owns a private,
  # isolated `Session.Server` + upstream IRC connection, and
  # `Session.set_explicit_away/3,4` already accepts `t:Session.subject/0`.
  # Explicit `/away` is a per-connection user action (distinct from the
  # WSPresence-driven auto-away that genuinely stays user-only). These tests
  # mirror the C3 WHOIS carve-out: subject-aware dispatch so visitors hit
  # the same `Session.set_explicit_away/unset_explicit_away` path users do.
  describe "S3.4 — /away explicit away dispatch (user + visitor, issue #62)" do
    test "user socket: away set sends AWAY :reason upstream and returns :ok" do
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)
      welcome_session_on_channel(irc_server, "#snap")
      topic = Topic.user(user.name)

      {:ok, _, socket} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(socket, "away", %{
          "action" => "set",
          "network" => network.slug,
          "reason" => "brb"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "AWAY :brb\r\n"), 1_000)
    end

    test "visitor socket: away set with live session sends AWAY :reason upstream" do
      {irc_server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(irc_server)
      IRCServer.feed(irc_server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")
      flush_server(irc_server)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "away", %{
          "action" => "set",
          "network" => network.slug,
          "reason" => "gone-fishing"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "AWAY :gone-fishing\r\n"), 1_000)
    end

    test "visitor socket: away unset after set issues bare AWAY upstream" do
      {irc_server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(irc_server)
      IRCServer.feed(irc_server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")
      flush_server(irc_server)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      set_ref =
        push(visitor_socket, "away", %{
          "action" => "set",
          "network" => network.slug,
          "reason" => "afk"
        })

      assert_reply(set_ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "AWAY :afk"), 1_000)

      unset_ref =
        push(visitor_socket, "away", %{
          "action" => "unset",
          "network" => network.slug
        })

      assert_reply(unset_ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "AWAY\r\n"), 1_000)
    end

    test "visitor socket: away set without live session returns no_session (NOT visitor_no_away)" do
      # The gate is gone; a visitor without a live `Session.Server` must now
      # surface the SAME real reason a user does — `no_session` from the
      # facade — never the dropped `visitor_no_away` short-circuit.
      slug = "snap-visitor-away-noses-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})
      visitor = visitor_fixture(network_slug: slug)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "away", %{
          "action" => "set",
          "network" => network.slug,
          "reason" => "brb"
        })

      assert_reply(ref, :error, %{error: "no_session"})
    end
  end

  # Issue #31: visitors could not `/invite` — the channel
  # `handle_in("invite", ...)` arm routed through `dispatch_ops_verb/2`,
  # which short-circuits every visitor subject with `visitor_not_allowed`
  # before the verb dispatches. INVITE is a write verb, but visitors are
  # entitled to issue it: each visitor owns a private, isolated
  # `Session.Server` + upstream IRC connection, `Session.send_invite/4`
  # already accepts `t:Session.subject/0`, and the upstream IRC server is
  # the real authority on whether the invite is permitted (must be on the
  # channel; must be an op for +i). Mirrors the #62 `/away` + C3 WHOIS
  # carve-outs: subject-aware dispatch so visitors hit the same
  # `Session.send_invite/4` path users do.
  describe "issue #31 — visitor /invite dispatch carve-out" do
    test "visitor socket: invite with live session sends INVITE nick #chan upstream" do
      {irc_server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(irc_server)
      IRCServer.feed(irc_server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")
      flush_server(irc_server)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "invite", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nick" => "alice"
        })

      assert_reply(ref, :ok)
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "INVITE alice #snap\r\n"), 1_000)
    end

    test "visitor socket: invite without session returns no_session (NOT visitor_not_allowed)" do
      # The visitor exists but has no live `Session.Server`. The fix MUST
      # surface `no_session` from `Session.send_invite/4`, never the
      # pre-fix `dispatch_ops_verb/2` `visitor_not_allowed` short-circuit.
      slug = "snap-visitor-inv-noses-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})
      visitor = visitor_fixture(network_slug: slug)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "invite", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nick" => "alice"
        })

      assert_reply(ref, :error, %{error: "no_session"})
    end

    test "visitor socket: invite with malformed nick returns invalid_nick" do
      # Defense in depth — the inbound `Identifier.valid_nick?` gate fires
      # BEFORE `Session.send_invite/4`, so visitors hit the same rejection
      # users do (mirror of the C3 WHOIS malformed-nick test).
      {irc_server, port} = start_irc_server()
      {visitor, network} = setup_visitor_and_network_with_session(port)
      :ok = await_handshake(irc_server)
      IRCServer.feed(irc_server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")
      flush_server(irc_server)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "invite", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nick" => "bad\r\nQUIT"
        })

      assert_reply(ref, :error, %{error: "invalid_nick"})
    end
  end

  # CP24 cluster post-cr-review bucket B reviewer add-on: read-only
  # ops verbs (`who`, `names`, `banlist`) were still routing through
  # `dispatch_ops_verb/2` post-bucket-A — visitors got `visitor_not_allowed`
  # despite the same spec-#2 carve-out logic that drove C3 (read-only
  # verbs broadcast on the visitor's own subject_label topic, so visitors
  # ARE entitled to issue them). These tests mirror the C3 WHOIS trio
  # for each verb: live-session ↔ upstream wire, no-session → `no_session`,
  # malformed channel → `invalid_line`.
  describe "bucket B reviewer add-on — visitor read-only verb carve-out (who/names/banlist)" do
    for {verb, wire_prefix} <- [
          {"who", "WHO "},
          {"names", "NAMES "},
          {"banlist", "MODE "}
        ] do
      @verb verb
      @wire_prefix wire_prefix

      test "visitor socket: #{@verb} with live session sends upstream line" do
        {irc_server, port} = start_irc_server()
        {visitor, network} = setup_visitor_and_network_with_session(port)
        :ok = await_handshake(irc_server)
        IRCServer.feed(irc_server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")
        flush_server(irc_server)

        visitor_name = "visitor:#{visitor.id}"
        topic = Topic.user(visitor_name)

        {:ok, _, visitor_socket} =
          visitor_name
          |> build_socket()
          |> subscribe_and_join(topic, %{})

        ref =
          push(visitor_socket, @verb, %{
            "network_id" => network.id,
            "channel" => "#test"
          })

        assert_reply(ref, :ok)

        {:ok, _} =
          IRCServer.wait_for_line(
            irc_server,
            &String.starts_with?(&1, @wire_prefix <> "#test"),
            1_000
          )
      end

      test "visitor socket: #{@verb} without session returns no_session" do
        # Slug constrained to 32 chars (Identifier.valid_network_slug?/1).
        # Use first 3 chars of verb + random suffix to fit comfortably.
        slug =
          "snv-#{String.slice(@verb, 0..2)}-#{System.unique_integer([:positive])}"

        {:ok, network} = Networks.find_or_create_network(%{slug: slug})
        visitor = visitor_fixture(network_slug: slug)

        visitor_name = "visitor:#{visitor.id}"
        topic = Topic.user(visitor_name)

        {:ok, _, visitor_socket} =
          visitor_name
          |> build_socket()
          |> subscribe_and_join(topic, %{})

        ref =
          push(visitor_socket, @verb, %{
            "network_id" => network.id,
            "channel" => "#test"
          })

        assert_reply(ref, :error, %{error: "no_session"})
      end

      test "visitor socket: #{@verb} with malformed channel returns a validation error" do
        {irc_server, port} = start_irc_server()
        {visitor, network} = setup_visitor_and_network_with_session(port)
        :ok = await_handshake(irc_server)
        IRCServer.feed(irc_server, ":irc.test.org 001 #{visitor_nick(visitor)} :Welcome\r\n")
        flush_server(irc_server)

        visitor_name = "visitor:#{visitor.id}"
        topic = Topic.user(visitor_name)

        {:ok, _, visitor_socket} =
          visitor_name
          |> build_socket()
          |> subscribe_and_join(topic, %{})

        ref =
          push(visitor_socket, @verb, %{
            "network_id" => network.id,
            "channel" => "#bad\r\nQUIT"
          })

        # #221 — WHO validates its target as a channel-OR-mask single wire
        # token (`:who_target` → `:invalid_mask`); names/banlist stay
        # channel-only (`:invalid_channel`). The CRLF is rejected either way
        # — the point is the malformed target never reaches upstream.
        expected_error = if @verb == "who", do: "invalid_mask", else: "invalid_channel"
        assert_reply(ref, :error, %{error: ^expected_error})
      end
    end
  end

  describe "join rejects malformed topics" do
    test "rejects Phase 1 grappa:network: shape (regression check)" do
      # Sub-task 2h removed the Phase 1 `grappa:network:*` channel
      # route from UserSocket. Pin the contract at the router lookup
      # layer (UserSocket.__channel__/1) — that's the actual mechanism
      # rejecting old-shape joins; depending on Phoenix's
      # subscribe_and_join error wording would couple the test to
      # framework internals.
      assert UserSocket.__channel__("grappa:network:azzurra/channel:#sniffo") == nil

      # Sanity check the new shape DOES route to GrappaChannel —
      # otherwise the assertion above is satisfied trivially by
      # everything failing.
      assert {GrappaWeb.GrappaChannel, _} =
               UserSocket.__channel__("grappa:user:vjt/network:azzurra/channel:#sniffo")
    end

    test "rejects malformed network suffix" do
      assert {:error, %{error: "unknown topic"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join("grappa:user:vjt/network:azzurra/wrong:foo", %{})
    end

    test "rejects empty network slug after network: prefix" do
      assert {:error, %{error: "unknown topic"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join("grappa:user:vjt/network:", %{})
    end

    test "rejects empty channel name after channel: prefix" do
      assert {:error, %{error: "unknown topic"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join("grappa:user:vjt/network:azzurra/channel:", %{})
    end

    test "rejects empty user segment" do
      assert {:error, %{error: "unknown topic"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join("grappa:user:", %{})
    end
  end

  # ---------------------------------------------------------------------------
  # C1.2 / C1.4 — open_query_window / close_query_window inbound events
  # ---------------------------------------------------------------------------
  #
  # Verifies that pushing `open_query_window` and `close_query_window`
  # on the user-level channel calls the correct `QueryWindows` context
  # functions and broadcasts the updated `query_windows_list` back to
  # the socket (via PubSub after the DB mutation).

  describe "C1.2/C1.4 — open_query_window / close_query_window" do
    setup do
      user_name = "qw-inbound-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)

      {:ok, network} =
        Networks.find_or_create_network(%{slug: "qw-net-#{System.unique_integer([:positive])}"})

      topic = Topic.user(user_name)

      {:ok, _, socket} =
        user_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      # Flush the after_join query_windows_list snapshot
      assert_push("event", %{kind: "query_windows_list"})

      %{socket: socket, user: user, network: network}
    end

    test "open_query_window: opens the DM window and broadcasts updated list", %{
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "open_query_window", %{
          "network_id" => network.id,
          "target_nick" => "alice"
        })

      assert_reply(ref, :ok)
      assert_push("event", %{kind: "query_windows_list", windows: windows})
      nicks = windows |> Map.values() |> List.flatten() |> Enum.map(& &1.target_nick)
      assert "alice" in nicks
    end

    test "open_query_window: idempotent — second open returns ok without duplicating", %{
      socket: socket,
      network: network
    } do
      ref1 =
        push(socket, "open_query_window", %{
          "network_id" => network.id,
          "target_nick" => "bob"
        })

      assert_reply(ref1, :ok)
      assert_push("event", %{kind: "query_windows_list"})

      ref2 =
        push(socket, "open_query_window", %{
          "network_id" => network.id,
          "target_nick" => "bob"
        })

      assert_reply(ref2, :ok)
      assert_push("event", %{kind: "query_windows_list", windows: windows})
      nicks = windows |> Map.values() |> List.flatten() |> Enum.map(& &1.target_nick)
      assert Enum.count(nicks, &(&1 == "bob")) == 1
    end

    test "close_query_window: closes the DM window and broadcasts updated list", %{
      socket: socket,
      user: user,
      network: network
    } do
      # Pre-open a window synchronously via the context (not via channel push)
      # to set up state without going through the inbound event path.
      # QueryWindows.open/4 broadcasts query_windows_list — flush it.
      {:ok, _} = QueryWindows.open({:user, user.id}, network.id, "carol", user.name)
      assert_push("event", %{kind: "query_windows_list"})

      ref =
        push(socket, "close_query_window", %{
          "network_id" => network.id,
          "target_nick" => "carol"
        })

      assert_reply(ref, :ok)

      # After close, the server broadcasts the updated list (without carol).
      # There may also be a stale broadcast from the open above that hasn't
      # arrived yet. Drain pushes until we find the post-close snapshot.
      windows = drain_for_query_windows_list(3)
      nicks = windows |> Map.values() |> List.flatten() |> Enum.map(& &1.target_nick)
      refute "carol" in nicks
    end

    test "close_query_window: idempotent — closing non-existent window returns ok", %{
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "close_query_window", %{
          "network_id" => network.id,
          "target_nick" => "nobody"
        })

      assert_reply(ref, :ok)
      assert_push("event", %{kind: "query_windows_list"})
    end

    # V2 — visitor parity: visitors persist DM windows alongside users.
    # Pre-V2 the channel handlers short-circuited `visitor_not_allowed`;
    # V2 lifts the gate so visitor sockets get the same broadcast +
    # persistence path as users. Per-subject XOR FK (V1) means rows
    # land in `query_windows.visitor_id` and CASCADE on TTL expiry.
    test "open_query_window: visitor socket persists window and broadcasts list" do
      slug = "qw-visitor-net-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})
      visitor = visitor_fixture(network_slug: slug)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{kind: "query_windows_list"})

      ref =
        push(visitor_socket, "open_query_window", %{
          "network_id" => network.id,
          "target_nick" => "alice"
        })

      assert_reply(ref, :ok)
      assert_push("event", %{kind: "query_windows_list", windows: windows})
      nicks = windows |> Map.values() |> List.flatten() |> Enum.map(& &1.target_nick)
      assert "alice" in nicks

      # Belt-and-braces: row landed under visitor_id, NOT user_id.
      stored = QueryWindows.list_for_subject({:visitor, visitor.id})
      stored_nicks = stored |> Map.values() |> List.flatten() |> Enum.map(& &1.target_nick)
      assert "alice" in stored_nicks
    end

    test "close_query_window: visitor socket deletes the persisted window" do
      slug = "qw-visitor-close-net-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})
      visitor = visitor_fixture(network_slug: slug)

      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      assert_push("event", %{kind: "query_windows_list"})

      # Pre-open via context (mirrors the user variant's setup pattern).
      {:ok, _} =
        QueryWindows.open({:visitor, visitor.id}, network.id, "carol", visitor_name)

      assert_push("event", %{kind: "query_windows_list"})

      ref =
        push(visitor_socket, "close_query_window", %{
          "network_id" => network.id,
          "target_nick" => "carol"
        })

      assert_reply(ref, :ok)

      windows = drain_for_query_windows_list(3)
      nicks = windows |> Map.values() |> List.flatten() |> Enum.map(& &1.target_nick)
      refute "carol" in nicks

      # Storage check — row really gone, not just hidden.
      stored = QueryWindows.list_for_subject({:visitor, visitor.id})
      stored_nicks = stored |> Map.values() |> List.flatten() |> Enum.map(& &1.target_nick)
      refute "carol" in stored_nicks
    end
  end

  # ---------------------------------------------------------------------------
  # C8 — /watch /highlight channel handlers
  #
  # `watchlist` handle_in dispatches: add / del / list. Stores persist
  # in UserSettings. Idempotent add / :not_found del. Visitors lifted
  # to first-class subjects (V4 visitor-parity, 2026-05-15).
  # ---------------------------------------------------------------------------

  describe "watchlist — /watch /highlight verbs" do
    setup do
      user_name = "watch-#{System.unique_integer([:positive])}"
      user = user_fixture(name: user_name)
      topic = Topic.user(user_name)

      {:ok, _, socket} =
        user_name
        |> build_socket(subject: {:user, user.id})
        |> subscribe_and_join(topic, %{})

      %{user: user, socket: socket, topic: topic}
    end

    test "list returns empty patterns for new user", %{socket: socket} do
      ref = push(socket, "watchlist", %{"action" => "list"})
      assert_reply(ref, :ok, %{patterns: []})
    end

    test "add inserts pattern and list returns it", %{socket: socket} do
      ref = push(socket, "watchlist", %{"action" => "add", "pattern" => "grappa"})
      assert_reply(ref, :ok, %{patterns: ["grappa"]})

      ref2 = push(socket, "watchlist", %{"action" => "list"})
      assert_reply(ref2, :ok, %{patterns: ["grappa"]})
    end

    test "add is idempotent — duplicate pattern is a no-op success", %{socket: socket} do
      push(socket, "watchlist", %{"action" => "add", "pattern" => "foo"})
      ref = push(socket, "watchlist", %{"action" => "add", "pattern" => "foo"})
      assert_reply(ref, :ok, %{patterns: patterns})
      assert Enum.count(patterns, &(&1 == "foo")) == 1
    end

    test "del removes pattern and list reflects the change", %{socket: socket} do
      push(socket, "watchlist", %{"action" => "add", "pattern" => "bar"})
      ref = push(socket, "watchlist", %{"action" => "del", "pattern" => "bar"})
      assert_reply(ref, :ok, %{patterns: []})
    end

    test "del of missing pattern returns :error :not_found", %{socket: socket} do
      ref = push(socket, "watchlist", %{"action" => "del", "pattern" => "nonexistent"})
      assert_reply(ref, :error, %{error: "not_found"})
    end

    test "visitor socket can list/add/del watchlist patterns — visitor-parity V4" do
      visitor = visitor_fixture()
      visitor_name = "visitor:#{visitor.id}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket(subject: {:visitor, visitor.id})
        |> subscribe_and_join(topic, %{})

      ref_list = push(visitor_socket, "watchlist", %{"action" => "list"})
      assert_reply(ref_list, :ok, %{patterns: []})

      ref_add = push(visitor_socket, "watchlist", %{"action" => "add", "pattern" => "testnick"})
      assert_reply(ref_add, :ok, %{patterns: ["testnick"]})

      ref_del = push(visitor_socket, "watchlist", %{"action" => "del", "pattern" => "testnick"})
      assert_reply(ref_del, :ok, %{patterns: []})
    end
  end

  # CP24 cluster post-cr-review bucket E web/S7: defense-in-depth at the
  # Channel inbound (WS) boundary. Pre-bucket-E `handle_in/3` clauses
  # accepted any binary `channel`/`nick`/`mask`/`target_nick` and let the
  # upstream `Identifier.safe_line_token?` gate (inside `IRC.Client`) do
  # the rejection. Bucket E adds explicit `Identifier.valid_channel?` /
  # `valid_nick?` / `safe_line_token?` gates at the WS inbound boundary
  # — a hostile cic instance (or compromised user) cannot inject
  # malformed/CRLF/NUL bytes via WS even if the upstream `Identifier`
  # gate ever loosens. Mirror of bucket C's irc/S5 self-defending
  # `AuthFSM.new/1` boundary at the IRC core.
  describe "bucket E web/S7 — Channel inbound IRC-shape validation" do
    setup do
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)
      welcome_session_on_channel(irc_server, "#snap")
      topic = Topic.user(user.name)

      {:ok, _, socket} =
        user.name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      %{socket: socket, network: network}
    end

    test "op: malformed channel returns invalid_channel", %{socket: socket, network: network} do
      ref =
        push(socket, "op", %{
          "network_id" => network.id,
          "channel" => "no-sigil",
          "nicks" => ["alice"]
        })

      assert_reply(ref, :error, %{error: "invalid_channel"})
    end

    test "op: malformed nick returns invalid_nick", %{socket: socket, network: network} do
      ref =
        push(socket, "op", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nicks" => ["bad nick"]
        })

      assert_reply(ref, :error, %{error: "invalid_nick"})
    end

    test "op: empty nicks list returns invalid_nick", %{socket: socket, network: network} do
      ref =
        push(socket, "op", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nicks" => []
        })

      assert_reply(ref, :error, %{error: "invalid_nick"})
    end

    test "kick: malformed nick returns invalid_nick", %{socket: socket, network: network} do
      ref =
        push(socket, "kick", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nick" => "no spaces",
          "reason" => "bye"
        })

      assert_reply(ref, :error, %{error: "invalid_nick"})
    end

    test "kick: CRLF reason returns invalid_line", %{socket: socket, network: network} do
      ref =
        push(socket, "kick", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nick" => "alice",
          "reason" => "bye\r\nQUIT :pwn"
        })

      assert_reply(ref, :error, %{error: "invalid_line"})
    end

    test "ban: CRLF mask returns invalid_mask", %{socket: socket, network: network} do
      ref =
        push(socket, "ban", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "mask" => "*!*@evil.com\r\nQUIT"
        })

      assert_reply(ref, :error, %{error: "invalid_mask"})
    end

    test "ban: empty mask returns invalid_mask", %{socket: socket, network: network} do
      ref =
        push(socket, "ban", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "mask" => ""
        })

      assert_reply(ref, :error, %{error: "invalid_mask"})
    end

    test "invite: malformed nick returns invalid_nick", %{socket: socket, network: network} do
      ref =
        push(socket, "invite", %{
          "network_id" => network.id,
          "channel" => "#snap",
          "nick" => "bad,comma"
        })

      assert_reply(ref, :error, %{error: "invalid_nick"})
    end

    test "open_query_window: malformed nick returns invalid_nick", %{
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "open_query_window", %{
          "network_id" => network.id,
          "target_nick" => "bad nick"
        })

      assert_reply(ref, :error, %{error: "invalid_nick"})
    end

    test "mode: CRLF in modes returns invalid_line", %{socket: socket, network: network} do
      ref =
        push(socket, "mode", %{
          "network_id" => network.id,
          "target" => "#snap",
          "modes" => "+o\r\nQUIT",
          "params" => ["alice"]
        })

      assert_reply(ref, :error, %{error: "invalid_line"})
    end

    test "mode: CRLF in params returns invalid_line", %{socket: socket, network: network} do
      ref =
        push(socket, "mode", %{
          "network_id" => network.id,
          "target" => "#snap",
          "modes" => "+o",
          "params" => ["alice\r\nQUIT"]
        })

      assert_reply(ref, :error, %{error: "invalid_line"})
    end

    test "umode: CRLF in modes returns invalid_line", %{socket: socket, network: network} do
      ref =
        push(socket, "umode", %{
          "network_id" => network.id,
          "modes" => "+i\r\nQUIT"
        })

      assert_reply(ref, :error, %{error: "invalid_line"})
    end

    test "topic_clear: malformed channel returns invalid_channel", %{
      socket: socket,
      network: network
    } do
      ref =
        push(socket, "topic_clear", %{
          "network_id" => network.id,
          "channel" => "no-sigil"
        })

      assert_reply(ref, :error, %{error: "invalid_channel"})
    end
  end

  # #182 — foreground-suppression: the page reports its PWA visibility over
  # the user-level channel; the handler forwards it to WSPresence keyed by
  # the SAME transport_pid UserSocket.connect registers.
  describe "handle_in visibility (#182)" do
    setup do
      :ok = WSPresence.reset_for_test()
      :ok
    end

    defp join_user_socket(user_name) do
      # Mirror UserSocket.connect: register the transport pid with
      # WSPresence, then join the user-level channel. In ChannelTest the
      # transport pid is the test process, so register/set_visibility both
      # key off the same pid.
      {:ok, _, socket} =
        user_name
        |> build_socket()
        |> subscribe_and_join(Topic.user(user_name), %{})

      :ok = WSPresence.register(user_name, socket.transport_pid)
      socket
    end

    test "visibility=true marks the transport pid visible" do
      user_name = "ch-vis-#{System.unique_integer([:positive])}"
      _ = user_fixture(name: user_name)
      socket = join_user_socket(user_name)
      refute WSPresence.any_visible?(user_name)

      ref = push(socket, "visibility", %{"visible" => true})
      assert_reply(ref, :ok)

      assert WSPresence.any_visible?(user_name)
    end

    test "visibility=false marks the transport pid hidden again" do
      user_name = "ch-vis-#{System.unique_integer([:positive])}"
      _ = user_fixture(name: user_name)
      socket = join_user_socket(user_name)

      ref1 = push(socket, "visibility", %{"visible" => true})
      assert_reply(ref1, :ok)
      assert WSPresence.any_visible?(user_name)

      ref2 = push(socket, "visibility", %{"visible" => false})
      assert_reply(ref2, :ok)
      refute WSPresence.any_visible?(user_name)
    end

    test "a non-boolean payload is rejected at the boundary" do
      user_name = "ch-vis-#{System.unique_integer([:positive])}"
      _ = user_fixture(name: user_name)
      socket = join_user_socket(user_name)

      ref = push(socket, "visibility", %{"visible" => "yes"})
      assert_reply(ref, :error, %{error: "invalid_payload"})

      refute WSPresence.any_visible?(user_name)
    end
  end

  # #364 bucket G / web S2 — a hostile or buggy cic must not be able to
  # crash its channel pid by sending a malformed `origin_window`. Pre-fix
  # `dispatch_set_away/4` / `dispatch_unset_away/3` had clauses only for
  # `nil` and `is_map/1`; a string/number/list `origin_window` raised
  # FunctionClauseError and killed the channel process. The boundary now
  # rejects it loudly (mirroring the sibling "visibility" handler).
  describe "#364 web/S2 — away rejects a malformed origin_window" do
    setup do
      {irc_server, port} = start_irc_server()
      {user, network} = setup_user_and_network_with_session(port)
      welcome_session_on_channel(irc_server, "#snap")

      {:ok, _, socket} =
        user.name
        |> build_socket()
        |> subscribe_and_join(Topic.user(user.name), %{})

      %{socket: socket, network: network}
    end

    test "away set: non-map origin_window is rejected, channel survives", %{
      socket: socket,
      network: network
    } do
      chan_pid = socket.channel_pid

      for bad <- ["main", 42, ["a"]] do
        ref =
          push(socket, "away", %{
            "action" => "set",
            "network" => network.slug,
            "reason" => "brb",
            "origin_window" => bad
          })

        assert_reply(ref, :error, %{error: "invalid_payload"})
      end

      assert Process.alive?(chan_pid), "channel must survive a malformed away payload"
    end

    test "away unset: non-map origin_window is rejected, channel survives", %{
      socket: socket,
      network: network
    } do
      chan_pid = socket.channel_pid

      ref =
        push(socket, "away", %{
          "action" => "unset",
          "network" => network.slug,
          "origin_window" => "main"
        })

      assert_reply(ref, :error, %{error: "invalid_payload"})
      assert Process.alive?(chan_pid), "channel must survive a malformed away payload"
    end
  end
end
