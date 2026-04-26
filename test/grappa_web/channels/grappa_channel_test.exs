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

  `Phoenix.PubSub` is process-routed but topics are global, so two
  `async: true` tests that share a topic name will see each other's
  broadcasts. Each test below uses a distinct identifier so the topic
  namespace is partitioned per-test.
  """
  use GrappaWeb.ChannelCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Networks, PubSub.Topic, Repo, Scrollback}
  alias Grappa.Scrollback.Wire
  alias GrappaWeb.UserSocket

  defp build_socket(user_name) do
    socket(UserSocket, "user_socket:#{user_name}", %{user_name: user_name})
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
        Scrollback.insert(%{
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
      # route from UserSocket. A stale client subscribing on the old
      # prefix gets rejected by Phoenix's route matcher (in-process
      # tests raise `NoRouteError`; over the wire the transport replies
      # with `unmatched topic`). Either way, the old shape can no longer
      # reach a channel — regression-pinned.
      assert_raise RuntimeError,
                   ~r/no channel/i,
                   fn ->
                     "vjt"
                     |> build_socket()
                     |> subscribe_and_join("grappa:network:azzurra/channel:#sniffo", %{})
                   end
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
