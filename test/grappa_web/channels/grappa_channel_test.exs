defmodule GrappaWeb.GrappaChannelTest do
  @moduledoc """
  Channel tests for `GrappaWeb.GrappaChannel`.

  The channel is a thin pass-through: it subscribes to the joined
  topic on `Grappa.PubSub` and pushes any `{:event, payload}` it
  receives to the connected socket verbatim. Tests verify the join
  shape (which topics are accepted, which are rejected) and the
  broadcast → push contract.

  Network/channel happy-path test builds the inner message map by
  inserting through `Grappa.Scrollback` and formatting via
  `Grappa.Scrollback.Wire.message_event/1` — same code path the
  controller uses when broadcasting. That way the wire-shape contract
  is pinned end-to-end: a regression in either side (channel reshapes,
  or domain wire helper changes shape) shows up here, not just in the
  controller test.

  `Phoenix.PubSub` is process-routed but topics are global, so two
  `async: true` tests that share a topic name will see each other's
  broadcasts. Each test below uses a distinct `(network, channel)`
  pair so the topic namespace is partitioned per-test. The schema's
  free-form string columns make this trivial.
  """
  use GrappaWeb.ChannelCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Networks, Repo, Scrollback}
  alias Grappa.Scrollback.Wire
  alias GrappaWeb.UserSocket

  describe "join grappa:network:{net}/channel:{chan}" do
    test "delivers PubSub-broadcast events verbatim" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

      {:ok, network} =
        Networks.find_or_create_network(%{slug: "ch-happy-#{System.unique_integer([:positive])}"})

      chan = "#ch_happy"
      topic = "grappa:network:#{network.slug}/channel:#{chan}"

      {:ok, _, _} =
        UserSocket
        |> socket("user_socket:vjt", %{user_name: "vjt"})
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
      net = "ch_sibling_net"
      joined = "grappa:network:#{net}/channel:#ch_joined"
      other = "grappa:network:#{net}/channel:#ch_other"

      {:ok, _, _} =
        UserSocket
        |> socket("user_socket:vjt", %{user_name: "vjt"})
        |> subscribe_and_join(joined, %{})

      Phoenix.PubSub.broadcast(Grappa.PubSub, other, {:event, %{kind: :message}})

      refute_push("event", _, 50)
    end
  end

  describe "join grappa:user:{user}" do
    test "subscribes to the user topic and pushes events verbatim" do
      topic = "grappa:user:ch_user_test"

      {:ok, _, _} =
        UserSocket
        |> socket("user_socket:vjt", %{user_name: "vjt"})
        |> subscribe_and_join(topic, %{})

      payload = %{kind: :motd, body: "welcome"}
      Phoenix.PubSub.broadcast(Grappa.PubSub, topic, {:event, payload})

      assert_push("event", ^payload)
    end
  end

  describe "join rejects malformed topics" do
    test "rejects malformed network topic (suffix is not channel:{chan})" do
      assert {:error, %{reason: "unknown topic"}} =
               UserSocket
               |> socket("user_socket:vjt", %{user_name: "vjt"})
               |> subscribe_and_join("grappa:network:ch_reject_net/wrong:foo", %{})
    end

    test "rejects empty network segment" do
      assert {:error, %{reason: "unknown topic"}} =
               UserSocket
               |> socket("user_socket:vjt", %{user_name: "vjt"})
               |> subscribe_and_join("grappa:network:", %{})
    end

    test "rejects empty channel segment after channel: prefix" do
      assert {:error, %{reason: "unknown topic"}} =
               UserSocket
               |> socket("user_socket:vjt", %{user_name: "vjt"})
               |> subscribe_and_join("grappa:network:ch_reject_net/channel:", %{})
    end

    test "rejects empty user segment" do
      assert {:error, %{reason: "unknown topic"}} =
               UserSocket
               |> socket("user_socket:vjt", %{user_name: "vjt"})
               |> subscribe_and_join("grappa:user:", %{})
    end
  end
end
