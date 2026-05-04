defmodule GrappaWeb.GrappaChannelTest do
  @moduledoc """
  Channel tests for `GrappaWeb.GrappaChannel`.

  The channel is a thin pass-through: it subscribes to the joined
  topic on `Grappa.PubSub` and pushes any `{:event, payload}` it
  receives to the connected socket verbatim. Tests verify the join
  shape (which topics are accepted, which are rejected), the authz
  check that rejects topics belonging to a different user, and the
  broadcast → push contract.

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
  alias Grappa.{Networks, QueryWindows, Repo, ScrollbackHelpers, Session}
  alias Grappa.Networks.{Credentials, Servers}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Wire
  alias GrappaWeb.UserSocket

  defp build_socket(user_name) do
    socket(UserSocket, "user_socket:#{user_name}", %{user_name: user_name})
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

    {user, network}
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
    :ok
  end

  defp welcome_session_on_channel(server, channel) do
    :ok = await_handshake(server)
    IRCServer.feed(server, ":irc.test.org 001 grappa-snap :Welcome\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN #{channel}"))
    IRCServer.feed(server, ":grappa-snap!u@h JOIN :#{channel}\r\n")
    flush_server(server)
  end

  defp flush_server(server) do
    token = "flush-#{System.unique_integer([:positive])}"
    IRCServer.feed(server, "PING :#{token}\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :#{token}\r\n"))
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
      {:event, payload} = event = Wire.message_event(preloaded)

      Phoenix.PubSub.broadcast(Grappa.PubSub, topic, event)

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

      Phoenix.PubSub.broadcast(Grappa.PubSub, other, {:event, %{kind: :message}})

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
      assert_push("event", %{kind: "topic_changed", channel: "#snap", topic: %{text: "Snapshot topic"}})
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

      assert_push("event", %{kind: "channel_modes_changed", channel: "#snap", modes: %{modes: modes}})
      assert "n" in modes
      assert "t" in modes
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
      refute_push("event", %{kind: "topic_changed"}, 100)
      refute_push("event", %{kind: "channel_modes_changed"}, 100)
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
      Phoenix.PubSub.broadcast(Grappa.PubSub, topic, {:event, payload})

      assert_push("event", ^payload)
    end

    test "after-join snapshot: visitor socket receives no query_windows_list" do
      # Visitor user_names start with "visitor:"
      visitor_name = "visitor:#{Ecto.UUID.generate()}"
      topic = Topic.user(visitor_name)

      {:ok, _, _} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      # Visitors must NOT receive query_windows_list
      refute_push("event", %{kind: "query_windows_list"}, 200)
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
      {:ok, _} = QueryWindows.open(user.id, network.id, "alice", user_name)

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
  end

  describe "join authz — cross-user topics are forbidden" do
    test "user-level topic of a different user returns forbidden" do
      assert {:error, %{reason: "forbidden"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join(Topic.user("alice"), %{})
    end

    test "network-level topic of a different user returns forbidden" do
      assert {:error, %{reason: "forbidden"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join(Topic.network("alice", "azzurra"), %{})
    end

    test "channel-level topic of a different user returns forbidden" do
      assert {:error, %{reason: "forbidden"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join(Topic.channel("alice", "azzurra", "#sniffo"), %{})
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
      assert {:error, %{reason: "unknown topic"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join("grappa:user:vjt/network:azzurra/wrong:foo", %{})
    end

    test "rejects empty network slug after network: prefix" do
      assert {:error, %{reason: "unknown topic"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join("grappa:user:vjt/network:", %{})
    end

    test "rejects empty channel name after channel: prefix" do
      assert {:error, %{reason: "unknown topic"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join("grappa:user:vjt/network:azzurra/channel:", %{})
    end

    test "rejects empty user segment" do
      assert {:error, %{reason: "unknown topic"}} =
               "vjt"
               |> build_socket()
               |> subscribe_and_join("grappa:user:", %{})
    end
  end
end
