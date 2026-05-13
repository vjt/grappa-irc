defmodule GrappaWeb.ReadCursorControllerTest do
  @moduledoc """
  POST `/networks/:slug/channels/:chan/read-cursor` — server-owned read
  cursor write surface. Landed in CP29 R-3 of the
  `server-side-read-state` cluster.

  Coverage:
    * happy path: insert + advance + no-op for forward-only.
    * 422 when message_id doesn't belong to (subject, network, channel).
    * 400 on malformed payload (missing message_id, non-integer,
      non-positive, malformed channel).
    * 404 on unknown network slug / not-our-network — collapsed via
      `Plugs.ResolveNetwork` upstream.
    * Cross-device WS broadcast on every successful advance.

  `async: false` because the WS broadcast subscription test attaches to
  a global PubSub topic and we use stable user names per test to keep
  topic strings non-overlapping under sandbox.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.PubSub.Topic
  alias Grappa.{ReadCursor, ScrollbackHelpers}

  defp uniq, do: System.unique_integer([:positive])

  setup %{conn: conn} do
    {user, session} = user_and_session()
    {network, _} = network_with_server(port: 7501, slug: "rc-net-#{uniq()}")
    _ = credential_fixture(user, network)
    {:ok, conn: put_bearer(conn, session.id), user: user, network: network}
  end

  defp insert_message(user, network, channel, server_time \\ 1) do
    {:ok, m} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: network.id,
        channel: channel,
        server_time: server_time,
        kind: :privmsg,
        sender: "vjt",
        body: "msg"
      })

    m
  end

  describe "POST /read-cursor — happy path" do
    test "inserts a new cursor and returns 200 with last_read_message_id",
         %{conn: conn, user: user, network: network} do
      msg = insert_message(user, network, "#sniffo")

      conn =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => msg.id
        })

      body = json_response(conn, 200)
      assert body == %{"last_read_message_id" => msg.id}
    end

    test "advances forward when message_id is greater than the existing cursor",
         %{conn: conn, user: user, network: network} do
      m1 = insert_message(user, network, "#sniffo", 1)
      m2 = insert_message(user, network, "#sniffo", 2)

      _ =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => m1.id
        })

      conn =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => m2.id
        })

      assert json_response(conn, 200) == %{"last_read_message_id" => m2.id}
    end

    test "no-op (returns existing id) when message_id is lower than the existing cursor",
         %{conn: conn, user: user, network: network} do
      m1 = insert_message(user, network, "#sniffo", 1)
      m2 = insert_message(user, network, "#sniffo", 2)

      _ =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => m2.id
        })

      conn =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => m1.id
        })

      assert json_response(conn, 200) == %{"last_read_message_id" => m2.id}
    end
  end

  describe "POST /read-cursor — validation" do
    test "returns 400 when message_id is missing", %{conn: conn, network: network} do
      conn = post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "returns 400 when message_id is non-integer", %{conn: conn, network: network} do
      conn =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => "banana"
        })

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "returns 400 when message_id is non-positive", %{conn: conn, network: network} do
      conn =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => 0
        })

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "returns 422 when message_id belongs to a different channel",
         %{conn: conn, user: user, network: network} do
      msg = insert_message(user, network, "#other-channel")

      conn =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => msg.id
        })

      assert json_response(conn, 422) == %{"error" => "invalid_message"}
    end

    test "returns 422 when message_id is absent from the messages table",
         %{conn: conn, network: network} do
      conn =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => 999_999_999
        })

      assert json_response(conn, 422) == %{"error" => "invalid_message"}
    end
  end

  describe "POST /read-cursor — auth + scoping" do
    test "returns 404 on unknown network slug (Plugs.ResolveNetwork)", %{conn: conn} do
      conn =
        post(conn, "/networks/no-such-slug/channels/%23sniffo/read-cursor", %{
          "message_id" => 1
        })

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  describe "POST /read-cursor — cross-device broadcast" do
    test "emits read_cursor_set on the per-channel topic on every advance",
         %{conn: conn, user: user, network: network} do
      msg = insert_message(user, network, "#sniffo")
      topic = Topic.channel(user.name, network.slug, "#sniffo")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      _ =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => msg.id
        })

      msg_id = msg.id

      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^topic,
        event: "event",
        payload: %{kind: "read_cursor_set", last_read_message_id: ^msg_id}
      }
    end

    test "broadcast still fires on no-op (forward-only)",
         %{conn: conn, user: user, network: network} do
      msg = insert_message(user, network, "#sniffo")
      {:ok, _} = ReadCursor.advance({:user, user.id}, network.id, "#sniffo", msg.id)

      topic = Topic.channel(user.name, network.slug, "#sniffo")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      # Re-POST same id — no-op server-side, but cross-device sync still
      # benefits from the broadcast (other devices may be on a stale id).
      _ =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => msg.id
        })

      msg_id = msg.id

      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^topic,
        event: "event",
        payload: %{kind: "read_cursor_set", last_read_message_id: ^msg_id}
      }
    end
  end
end
