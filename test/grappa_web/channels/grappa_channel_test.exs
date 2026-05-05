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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "MODE #snap +ooo"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "MODE #snap -ooo"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "MODE #snap +v"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &String.starts_with?(&1, "MODE #snap -v"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "KICK #snap alice :bye\r\n"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MODE #snap +b *!*@evil.com\r\n"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MODE #snap -b *!*@evil.com\r\n"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "INVITE alice #snap\r\n"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MODE #snap b\r\n"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MODE grappa-snap +i\r\n"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "MODE #snap +o-v alice bob\r\n"))
    end

    test "op: unknown network_id returns {:error, network_not_found}", %{socket: socket} do
      ref =
        push(socket, "op", %{
          "network_id" => 999_999,
          "channel" => "#snap",
          "nicks" => ["alice"]
        })

      assert_reply(ref, :error, %{reason: "no_session"})
    end

    test "visitor socket: op returns visitor_not_allowed", %{network: network} do
      visitor_name = "visitor:#{Ecto.UUID.generate()}"
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

      assert_reply(ref, :error, %{reason: "visitor_not_allowed"})
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "TOPIC #snap :new topic text\r\n"))
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
      {:ok, _} = IRCServer.wait_for_line(irc_server, &(&1 == "TOPIC #snap :\r\n"))
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
      {:ok, _} = QueryWindows.open(user.id, network.id, "carol", user.name)
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

    test "open_query_window: visitor socket returns visitor_not_allowed" do
      visitor_name = "visitor:#{Ecto.UUID.generate()}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "open_query_window", %{
          "network_id" => 1,
          "target_nick" => "alice"
        })

      assert_reply(ref, :error, %{reason: "visitor_not_allowed"})
    end

    test "close_query_window: visitor socket returns visitor_not_allowed" do
      visitor_name = "visitor:#{Ecto.UUID.generate()}"
      topic = Topic.user(visitor_name)

      {:ok, _, visitor_socket} =
        visitor_name
        |> build_socket()
        |> subscribe_and_join(topic, %{})

      ref =
        push(visitor_socket, "close_query_window", %{
          "network_id" => 1,
          "target_nick" => "alice"
        })

      assert_reply(ref, :error, %{reason: "visitor_not_allowed"})
    end
  end
end
