defmodule GrappaWeb.GrappaChannelTest do
  @moduledoc """
  Channel tests for `GrappaWeb.GrappaChannel`.

  The channel is a thin pass-through: it subscribes to the joined
  topic on `Grappa.PubSub` and pushes any `{:event, payload}` it
  receives to the connected socket verbatim. Tests verify the join
  shape (which topics are accepted, which are rejected) and the
  broadcast → push contract.

  Test broadcasts use the wire shape established by Task 6
  (`%{kind: :message, message: %{...}}`), not a synthetic one — that
  way a regression in either side (channel pushing the wrong shape OR
  controller broadcasting the wrong shape) shows up here.
  """
  use GrappaWeb.ChannelCase, async: true

  alias GrappaWeb.UserSocket

  describe "join grappa:network:{net}/channel:{chan}" do
    test "delivers PubSub-broadcast events verbatim" do
      topic = "grappa:network:azzurra/channel:#sniffo"

      {:ok, _, socket} =
        UserSocket
        |> socket("user_socket:vjt", %{user_name: "vjt"})
        |> subscribe_and_join(topic, %{})

      assert socket.topic == topic

      payload = %{
        kind: :message,
        message: %{
          id: 1,
          network_id: "azzurra",
          channel: "#sniffo",
          server_time: 1_700_000_000_000,
          kind: :privmsg,
          sender: "<local>",
          body: "ciao raga"
        }
      }

      Phoenix.PubSub.broadcast(Grappa.PubSub, topic, {:event, payload})

      assert_push("event", ^payload)
    end

    test "broadcasts on a sibling channel topic do NOT reach this socket" do
      joined = "grappa:network:azzurra/channel:#sniffo"
      other = "grappa:network:azzurra/channel:#other"

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
      topic = "grappa:user:vjt"

      {:ok, _, _} =
        UserSocket
        |> socket("user_socket:vjt", %{user_name: "vjt"})
        |> subscribe_and_join(topic, %{})

      Phoenix.PubSub.broadcast(Grappa.PubSub, topic, {:event, %{kind: :motd, body: "welcome"}})

      assert_push("event", %{kind: :motd, body: "welcome"})
    end
  end

  describe "join rejects malformed topics" do
    test "rejects malformed network topic (suffix is not channel:{chan})" do
      assert {:error, %{reason: "unknown topic"}} =
               UserSocket
               |> socket("user_socket:vjt", %{user_name: "vjt"})
               |> subscribe_and_join("grappa:network:azzurra/wrong:foo", %{})
    end

    test "rejects empty network segment" do
      assert {:error, %{reason: "unknown topic"}} =
               UserSocket
               |> socket("user_socket:vjt", %{user_name: "vjt"})
               |> subscribe_and_join("grappa:network:", %{})
    end
  end
end
