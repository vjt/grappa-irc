defmodule GrappaWeb.MessagesControllerOwnSendCursorTest do
  @moduledoc """
  issue 2407 — the subject's own send through `POST .../messages` advances
  the read cursor of the window the sent row lands in, to that row's id.

  Replying in a window is the one read signal a client without read markers
  (an IRC client behind a bridge) ever gives grappa. Before this, the only
  cursor writer was `POST .../read-cursor`, so everything read from such a
  client stayed unread on every other device, and the icon badge kept the
  mentions the subject had just answered.

  Every assertion waits on the `read_cursor_set` broadcast the advance fans
  out on the window's per-channel topic: it is the cross-device outcome the
  issue asks for, and it is emitted only after the cursor row is committed,
  so the DB read that follows it is deterministic.

  `async: false` — Session uses singleton supervisors + Registry, and the
  task drain reads the global `Grappa.TaskSupervisor`.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, ReadCursor, ScrollbackHelpers, TaskSupervisorHelpers}
  alias Grappa.PubSub.Topic
  alias Grappa.Push.BadgeCount

  @own_nick "grappa-test"

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {network, _} = network_with_server(port: port, slug: "own-send-#{System.unique_integer([:positive])}")
    _ = credential_fixture(vjt, network, %{nick: @own_nick, autojoin_channels: []})
    _ = start_session_for(vjt, network)
    :ok = IRCServer.await_handshake(server, 1_000)

    # The advance runs in a detached task; keep a straggler off the sandbox
    # owner's teardown (on_exit is LIFO — this runs before ConnCase's).
    on_exit(&TaskSupervisorHelpers.drain_children/0)

    {:ok,
     conn: conn |> put_bearer(session.id) |> put_req_header("content-type", "application/json"),
     vjt: vjt,
     network: network}
  end

  test "a reply in a channel reads the mentions above it: cursor on the sent row, badge 0",
       %{conn: conn, vjt: vjt, network: network} do
    subject = {:user, vjt.id}
    read = inbound(vjt, network, "#sniffo", "earlier chatter")
    {:ok, _} = ReadCursor.set(subject, network.id, "#sniffo", read.id)
    _ = inbound(vjt, network, "#sniffo", "#{@own_nick}: ping")
    _ = inbound(vjt, network, "#sniffo", "#{@own_nick}: are you there?")

    # Positive control: the two mentions ARE in the badge before the reply,
    # so the 0 below is the reply's doing and not a badge that never counted.
    assert BadgeCount.count(subject) == 2

    sent = send_and_await_cursor(conn, vjt, network, "#sniffo", "%23sniffo", %{"body" => "yes, here"})

    assert sent.badge_count == 0
    assert cursor_id(subject, network, "#sniffo") == sent.id
  end

  test "an outbound DM advances the peer window's cursor",
       %{conn: conn, vjt: vjt, network: network} do
    sent = send_and_await_cursor(conn, vjt, network, "someuser", "someuser", %{"body" => "hey"})

    assert cursor_id({:user, vjt.id}, network, "someuser") == sent.id
  end

  test "an ACTION advances the cursor like a PRIVMSG",
       %{conn: conn, vjt: vjt, network: network} do
    sent =
      send_and_await_cursor(conn, vjt, network, "#sniffo", "%23sniffo", %{
        "body" => "\x01ACTION waves\x01"
      })

    assert cursor_id({:user, vjt.id}, network, "#sniffo") == sent.id
  end

  test "CTCP, NOTICE and ops-only echoes advance the window each one lands in",
       %{conn: conn, vjt: vjt, network: network} do
    subject = {:user, vjt.id}

    # Three sends spend the whole test send bucket (`config/test.exs`
    # `:send_throttle` capacity 3); a fourth here would answer 429.
    ctcp =
      send_and_await_cursor(conn, vjt, network, "#ctcp", "%23ctcp", %{
        "body" => "\x01PING 1706743200000\x01",
        "ctcp_target" => "carol"
      })

    notice =
      send_and_await_cursor(conn, vjt, network, "#notice", "%23notice", %{
        "body" => "heads up",
        "notice_target" => "carol"
      })

    # The ops-only echo is keyed to the channel BEHIND the sigil (issue 2179),
    # so that is the window whose cursor moves.
    ops =
      send_and_await_cursor(conn, vjt, network, "#ops", "%23ops", %{
        "body" => "ops only",
        "statusmsg_target" => "@#ops"
      })

    assert cursor_id(subject, network, "#ctcp") == ctcp.id
    assert cursor_id(subject, network, "#notice") == notice.id
    assert cursor_id(subject, network, "#ops") == ops.id
  end

  # POSTs one send and waits for the advance's `read_cursor_set` on the
  # window's topic, which must carry the id of the row the send created.
  defp send_and_await_cursor(conn, vjt, network, window, url_channel, params) do
    topic = Topic.channel(vjt.name, network.slug, window)
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

    %{"id" => id, "channel" => ^window} =
      conn
      |> post("/networks/#{network.slug}/channels/#{url_channel}/messages", params)
      |> json_response(201)

    assert_receive %Phoenix.Socket.Broadcast{
                     topic: ^topic,
                     event: "event",
                     payload: %{kind: :read_cursor_set, last_read_message_id: ^id, badge_count: badge}
                   },
                   2_000

    :ok = Phoenix.PubSub.unsubscribe(Grappa.PubSub, topic)
    %{id: id, badge_count: badge}
  end

  defp cursor_id(subject, network, window) do
    %{last_read_message_id: id} = ReadCursor.get(subject, network.id, window)
    id
  end

  defp inbound(vjt, network, channel, body) do
    {:ok, row} =
      ScrollbackHelpers.insert(%{
        user_id: vjt.id,
        network_id: network.id,
        channel: channel,
        server_time: System.unique_integer([:positive]),
        kind: :privmsg,
        sender: "bot",
        body: body
      })

    row
  end
end
