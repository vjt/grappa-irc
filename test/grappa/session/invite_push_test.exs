defmodule Grappa.Session.InvitePushTest do
  @moduledoc """
  End-to-end gate for the inbound-INVITE web push (issue 2487).

  Drives the WHOLE path — real `Session.Server`, real `EventRouter` off the
  `Grappa.IRCServer` fake ircd, real `Push.Triggers` dispatch, real
  `Push.Sender` fan-out against a Bypass vendor — because what this issue
  decides is WHICH invites reach the lock screen, and that is settled on the
  session side, where the `:invited` window is opened:

    * an INVITE that opens the banner pushes;
    * an INVITE to a channel the subject has MUTED opens the banner and
      pushes nothing — the mute applies to invites too;
    * an INVITE to a channel the subject is already IN opens no banner and
      pushes nothing — the notification and the banner are one event;
    * likewise an INVITE the invited-window ceiling turns away;
    * an INVITE from a user the subject ignores disappears entirely — no
      push, no banner, no window, no row (vjt's ruling (b) on this issue).

  The positive case decrypts the vendor POST the way a browser would
  (`Grappa.PushReceiver`), so it pins the payload a REAL dispatch built —
  which argument went where — not only that a delivery happened. A
  repeat INVITE to a window still waiting on an answer pushes nothing.

  `async: false` — `SessionRegistry` / `SessionSupervisor` / `WSPresence`
  are singletons, same rationale as `Grappa.Session.ServerTest`.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.IRC.Identifier
  alias Grappa.{IRCServer, PushReceiver, Scrollback, SessionStateHelpers, UserSettings, WSPresence}
  alias Grappa.PubSub.Topic
  alias Grappa.Session.WindowState

  setup do
    :ok = WSPresence.reset_for_test()
    bypass = Bypass.open()
    {:ok, bypass: bypass, endpoint: "http://localhost:#{bypass.port}/wp"}
  end

  defp attach_telemetry(events) do
    test_pid = self()
    handler_id = "invite-push-#{System.unique_integer([:positive])}"

    :telemetry.attach_many(
      handler_id,
      events,
      fn event, measurements, metadata, _ -> send(test_pid, {:telemetry, event, measurements, metadata}) end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler_id) end)
  end

  # A subject on one network, subscribed to push from a browser whose keys
  # the test holds, with the DEFAULT prefs — an invite has no preference of
  # its own, so nothing here is switched on to make it notify.
  defp subscribed_session(port, endpoint) do
    user = user_fixture(name: "invite-push-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "ip-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{nick: "grappa-test"})
    subject = {:user, user.id}
    {_, client} = PushReceiver.browser_subscription(subject, endpoint)

    {user, network, subject, client}
  end

  defp mute(subject, network, channel) do
    {:ok, _} =
      UserSettings.put_notification_prefs(
        subject,
        Map.put(
          UserSettings.default_notification_prefs(),
          :muted_targets,
          %{Identifier.channel_key(network.slug, channel) => %{"until" => nil}}
        )
      )

    :ok
  end

  # PING/PONG round-trip: every line fed before it has been routed and its
  # effects applied by the time the PONG comes back.
  defp flush(server) do
    IRCServer.feed(server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)
    :ok
  end

  test "an INVITE that opens the banner pushes the invite payload", %{bypass: bypass, endpoint: endpoint} do
    test_pid = self()

    Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:vendor_body, body})
      Plug.Conn.resp(conn, 201, "")
    end)

    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, _, client} = subscribed_session(port, endpoint)
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)

    IRCServer.feed(server, ":someguy!u@h INVITE grappa-test :#secret\r\n")

    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :window_invited, channel: "#secret"}}, 1_000
    assert_receive {:vendor_body, body}, 2_000

    # Literals: who invited, to what, on which network — read off the bytes
    # a browser receives.
    assert PushReceiver.decode_payload(body, client) == %{
             "title" => "someguy is inviting you to #secret",
             "body" => "on #{network.slug}",
             "tag" => "#{network.slug}:#secret",
             "url" => "/?network=#{network.slug}&channel=%23secret"
           }

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "a repeat INVITE to a window still waiting on an answer pushes nothing", %{
    bypass: bypass,
    endpoint: endpoint
  } do
    attach_telemetry([[:grappa, :push, :send, :start]])
    Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, subject, _} = subscribed_session(port, endpoint)
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)

    IRCServer.feed(server, ":someguy!u@h INVITE grappa-test :#secret\r\n")
    assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 1}, %{subject: ^subject}}, 2_000

    # The banner is re-affirmed — the window state is unchanged by this
    # issue — and the lock screen is left alone.
    IRCServer.feed(server, ":someguy!u@h INVITE grappa-test :#secret\r\n")
    :ok = flush(server)

    assert_received %Phoenix.Socket.Broadcast{payload: %{kind: :window_invited, channel: "#secret"}}
    assert_received %Phoenix.Socket.Broadcast{payload: %{kind: :window_invited, channel: "#secret"}}
    refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 500

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "an INVITE to a muted channel still opens the banner and pushes nothing", %{
    bypass: bypass,
    endpoint: endpoint
  } do
    attach_telemetry([[:grappa, :push, :send, :start], [:grappa, :push, :suppressed]])
    Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 500, "should-not-happen") end)

    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, subject, _} = subscribed_session(port, endpoint)
    :ok = mute(subject, network, "#secret")
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)

    # RAW-cased on the wire: the mute was written folded, and the invite must
    # meet it through the same fold.
    IRCServer.feed(server, ":someguy!u@h INVITE grappa-test :#Secret\r\n")

    # The banner is unchanged by the mute — it is the notification the issue
    # silences, not the invite.
    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :window_invited, channel: "#secret"}}, 1_000

    refute_receive {:telemetry, _, _, _}, 500

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "an INVITE from an ignored user disappears: no push, no banner, no window, no row", %{
    bypass: bypass,
    endpoint: endpoint
  } do
    # vjt's ruling (b) on this issue: the whole person is ignored, so their
    # invitation leaves no trace at all — not only no push.
    attach_telemetry([[:grappa, :push, :send, :start], [:grappa, :push, :suppressed]])
    Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, subject, _} = subscribed_session(port, endpoint)
    {:ok, :added, _, _} = UserSettings.add_ignore(subject, network.slug, "spambot", nil, :ascii)
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)

    IRCServer.feed(server, ":SpamBot!u@h INVITE grappa-test :#secret\r\n")
    :ok = flush(server)

    refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :window_invited}}
    window_state = pid |> SessionStateHelpers.fetch() |> SessionStateHelpers.window_state()
    refute WindowState.state_of(window_state, "#secret")
    assert Scrollback.fetch(subject, network.id, "#secret", nil, 10, nil, false) == []
    refute_receive {:telemetry, _, _, _}, 500

    # The pre-state, proven on the same session: someone NOT ignored still
    # gets the whole invite.
    IRCServer.feed(server, ":someguy!u@h INVITE grappa-test :#secret\r\n")
    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :window_invited, channel: "#secret"}}, 1_000
    assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 1}, %{subject: ^subject}}, 2_000

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "an INVITE to a channel we are already in opens no banner and pushes nothing", %{
    bypass: bypass,
    endpoint: endpoint
  } do
    attach_telemetry([[:grappa, :push, :send, :start], [:grappa, :push, :suppressed]])
    Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 500, "should-not-happen") end)

    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, _, _} = subscribed_session(port, endpoint)
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)

    IRCServer.feed(server, ":grappa-test!u@h JOIN :#live\r\n")
    :ok = flush(server)

    IRCServer.feed(server, ":someguy!u@h INVITE grappa-test :#live\r\n")
    :ok = flush(server)

    refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :window_invited}}
    refute_receive {:telemetry, _, _, _}, 500

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "an INVITE the invited-window ceiling turns away pushes nothing", %{
    bypass: bypass,
    endpoint: endpoint
  } do
    attach_telemetry([[:grappa, :push, :send, :start]])
    Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, subject, _} = subscribed_session(port, endpoint)

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)

    cap = WindowState.invited_cap()

    for i <- 1..cap do
      IRCServer.feed(server, ":someguy!u@h INVITE grappa-test :#flood#{i}\r\n")
    end

    for _ <- 1..cap do
      assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 1}, %{subject: ^subject}}, 5_000
    end

    IRCServer.feed(server, ":someguy!u@h INVITE grappa-test :#overtheceiling\r\n")
    :ok = flush(server)

    refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 500

    :ok = GenServer.stop(pid, :normal, 1_000)
  end
end
