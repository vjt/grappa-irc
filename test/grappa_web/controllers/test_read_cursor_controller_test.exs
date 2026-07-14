defmodule GrappaWeb.TestReadCursorControllerTest do
  @moduledoc """
  POST `/networks/:slug/channels/:chan/read-cursor/force` — the
  test-only force write surface (compile-gated to dev/test) that lets
  the e2e cursor/divider specs plant a BACKWARD (mid-page) cursor the
  production advance-only endpoint refuses (#233).

  Coverage:
    * force writes a LOWER id, bypassing the monotonic clamp that
      `POST /read-cursor` enforces — the exact capability the e2e
      cursor specs lost when #233 hardened the production endpoint.
    * 422 when message_id doesn't belong to (subject, network, channel).
    * 400 on malformed payload.
    * Cross-device WS broadcast on every successful force (cic adopts a
      backward move ONLY through the `read_cursor_set` echo).

  `async: false` — the broadcast test subscribes to a global PubSub
  topic; stable per-test user names keep topic strings non-overlapping
  under sandbox (mirrors `ReadCursorControllerTest`).
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.PubSub.Topic
  alias Grappa.{ReadCursor, ScrollbackHelpers}

  defp uniq, do: System.unique_integer([:positive])

  setup %{conn: conn} do
    {user, session} = user_and_session()
    {network, _} = network_with_server(port: 7601, slug: "frc-net-#{uniq()}")
    _ = credential_fixture(user, network)
    {:ok, conn: put_bearer(conn, session.id), user: user, network: network}
  end

  defp insert_message(user, network, channel, server_time) do
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

  describe "POST /read-cursor/force — backward seed" do
    test "forces a LOWER id, unlike the advance-only production endpoint (#233)",
         %{conn: conn, user: user, network: network} do
      m1 = insert_message(user, network, "#sniffo", 1)
      m2 = insert_message(user, network, "#sniffo", 2)

      # Advance to the tail first via the CONTEXT (mirrors a prior spec's
      # restore-to-tail leaving the cursor high).
      {:ok, _} = ReadCursor.set({:user, user.id}, network.id, "#sniffo", m2.id)

      conn =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor/force", %{
          "message_id" => m1.id
        })

      # The production endpoint would clamp this to m2; force writes m1.
      assert json_response(conn, 200) == %{"last_read_message_id" => m1.id}
      assert %{last_read_message_id: id} = ReadCursor.get({:user, user.id}, network.id, "#sniffo")
      assert id == m1.id
    end

    test "returns 422 when message_id belongs to a different channel",
         %{conn: conn, user: user, network: network} do
      msg = insert_message(user, network, "#other-channel", 1)

      conn =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor/force", %{
          "message_id" => msg.id
        })

      assert json_response(conn, 422) == %{"error" => "invalid_message"}
    end

    test "returns 400 when message_id is missing", %{conn: conn, network: network} do
      conn = post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor/force", %{})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "broadcasts the forced (backward) id so cic adopts it via read_cursor_set",
         %{conn: conn, user: user, network: network} do
      m1 = insert_message(user, network, "#sniffo", 1)
      m2 = insert_message(user, network, "#sniffo", 2)
      {:ok, _} = ReadCursor.set({:user, user.id}, network.id, "#sniffo", m2.id)

      topic = Topic.channel(user.name, network.slug, "#sniffo")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      _ =
        post(conn, "/networks/#{network.slug}/channels/%23sniffo/read-cursor/force", %{
          "message_id" => m1.id
        })

      m1_id = m1.id

      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^topic,
        event: "event",
        payload: %{kind: "read_cursor_set", last_read_message_id: ^m1_id}
      }
    end
  end
end
