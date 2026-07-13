defmodule GrappaWeb.ReadCursorControllerTest do
  @moduledoc """
  POST `/networks/:slug/channels/:chan/read-cursor` — server-owned read
  cursor write surface.

  Coverage:
    * happy path: insert + same-id no-op + monotonic advance on higher
      id + clamp-to-current on a stale lower id (#233).
    * 422 when message_id doesn't belong to (subject, network, channel).
    * 400 on malformed payload (missing message_id, non-integer,
      non-positive, malformed channel).
    * 404 on unknown network slug / not-our-network — collapsed via
      `Plugs.ResolveNetwork` upstream.
    * Cross-device WS broadcast on every successful set.

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

    test "moves forward when message_id is greater than the existing cursor",
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

    test "clamps a stale lower message_id to the current cursor (#233 monotonic — re-affirms higher id)",
         %{conn: conn, user: user, network: network} do
      # #233: a stale scroll-to-bottom POST carrying a LOWER id (the
      # currently-loaded page bottom, arriving during a slow message-page
      # load) must NOT regress the cursor. The controller returns the
      # current (higher) id, so its `read_cursor_set` broadcast re-affirms
      # the correct position instead of snapping every device's view back
      # to the old read marker. Pre-fix this returned m1 (the bug).
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
    test "emits read_cursor_set on the per-channel topic on every set",
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

    test "broadcast carries the post-set badge_count (door #3)",
         %{conn: conn, user: user, network: network} do
      # channel-all so every unread content row after the cursor is
      # notify-worthy. own_nick resolves off the setup's credential nick.
      {:ok, _} =
        Grappa.UserSettings.put_notification_prefs(
          {:user, user.id},
          Map.merge(Grappa.UserSettings.default_notification_prefs(), %{
            channel_messages_all: true
          })
        )

      anchor = insert_message(user, network, "#sniffo", 1)
      _ = insert_message(user, network, "#sniffo", 2)
      _ = insert_message(user, network, "#sniffo", 3)

      topic = Topic.channel(user.name, network.slug, "#sniffo")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      _ =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor", %{
          "message_id" => anchor.id
        })

      anchor_id = anchor.id

      # Cursor at the anchor → the 2 later rows are unread + notify-worthy.
      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^topic,
        event: "event",
        payload: %{
          kind: "read_cursor_set",
          last_read_message_id: ^anchor_id,
          badge_count: 2
        }
      }
    end

    test "broadcast still fires on no-op (forward-only)",
         %{conn: conn, user: user, network: network} do
      msg = insert_message(user, network, "#sniffo")
      {:ok, _} = ReadCursor.set({:user, user.id}, network.id, "#sniffo", msg.id)

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

    # V4 visitor-parity (2026-05-15): visitors get the same per-channel
    # broadcast as users. Pre-V4 the visitor branch short-circuited to
    # :ok with no fan-out (HIGH-20 rationale: visitors single-device).
    # Same-NickServ-identity reuse + multi-tab visitor sessions make
    # the no-fan-out a UX gap; lift restores parity. Topic uses
    # `"visitor:" <> id` as the user_name — same convention as
    # `Topic.user(socket.assigns.user_name)` in the user_socket lift.
    test "visitor: emits read_cursor_set on visitor's per-channel topic — V4",
         %{conn: %Plug.Conn{} = base_conn} do
      port = 7502
      {visitor, network} = visitor_with_network(port)
      session = visitor_session_fixture(visitor)
      visitor_user_name = "visitor:" <> visitor.id

      {:ok, m} =
        ScrollbackHelpers.insert(%{
          visitor_id: visitor.id,
          network_id: network.id,
          channel: "#vis-cursor",
          server_time: 1,
          kind: :privmsg,
          sender: "vjt",
          body: "msg"
        })

      conn = put_bearer(base_conn, session.id)
      topic = Topic.channel(visitor_user_name, network.slug, "#vis-cursor")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      _ =
        post(conn, "/networks/#{network.slug}/channels/%23vis-cursor/read-cursor", %{
          "message_id" => m.id
        })

      msg_id = m.id

      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^topic,
        event: "event",
        payload: %{kind: "read_cursor_set", last_read_message_id: ^msg_id}
      }
    end
  end
end
