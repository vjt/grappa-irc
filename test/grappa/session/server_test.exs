defmodule Grappa.Session.ServerTest do
  @moduledoc """
  Integration tests for `Grappa.Session.Server` — the per-(user, network)
  GenServer. Uses `Grappa.IRCServer` (in-process TCP fake) instead of
  mocking `:gen_tcp` per CLAUDE.md "Mock at boundaries (Mox), real
  dependencies inside."

  `async: false` because:
    1. `Grappa.SessionRegistry` is a singleton (`name: Grappa.SessionRegistry`
       in `application.ex`); concurrent tests would collide on
       `{:session, user, net_id}` keys.
    2. `Grappa.SessionSupervisor` (DynamicSupervisor) is also a singleton.
    3. `Grappa.PubSub` is a singleton; topic subscriptions across async
       tests would cross-deliver.
  `Grappa.DataCase` switches to shared sandbox mode automatically when
  `async: false` (`shared: not tags[:async]` line 24 of data_case.ex), so
  the Session GenServer (spawned under the application's
  DynamicSupervisor, outside the test PID) can still see the sandboxed
  Repo.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.{AuthFixtures, MessageEventAssertions}

  alias Grappa.{IRCServer, Networks, PubSub.Topic, Scrollback, Session}

  setup do
    # Phase 2 (sub-task 2e): Session.Server's persist path writes via
    # Scrollback's user_id FK. Pre-insert the users this file's tests
    # spawn sessions for, plus the network row Session.Server resolves
    # from the slug at init.
    vjt = user_fixture(name: "vjt")
    alice = user_fixture(name: "alice")
    {:ok, network} = Networks.find_or_create_network(%{slug: "test"})
    %{vjt: vjt, alice: alice, network: network}
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server(handler \\ passthrough_handler()) do
    {:ok, server} = IRCServer.start_link(handler)
    {server, IRCServer.port(server)}
  end

  defp session_opts(port, user, overrides) do
    base = %{
      user_id: user.id,
      user_name: user.name,
      network_id: "test",
      host: "127.0.0.1",
      port: port,
      tls: false,
      nick: "grappa-test",
      autojoin: ["#sniffo"]
    }

    Map.merge(base, overrides)
  end

  defp start_session(port, user, overrides \\ %{}) do
    {:ok, pid} = Session.start_session(session_opts(port, user, overrides))
    pid
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
    :ok
  end

  describe "registration" do
    test "registers via {:session, user, net_id} in Grappa.SessionRegistry", %{vjt: vjt} do
      {_, port} = start_server()
      pid = start_session(port, vjt)

      assert Session.whereis("vjt", "test") == pid
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "two sessions with different (user, network) keys coexist", %{vjt: vjt, alice: alice} do
      {_, port1} = start_server()
      {_, port2} = start_server()

      pid1 = start_session(port1, vjt)
      pid2 = start_session(port2, alice)

      assert pid1 != pid2
      assert Session.whereis("vjt", "test") == pid1
      assert Session.whereis("alice", "test") == pid2

      :ok = GenServer.stop(pid1, :normal, 1_000)
      :ok = GenServer.stop(pid2, :normal, 1_000)
    end

    test "whereis/2 returns nil for unknown keys" do
      assert Session.whereis("nobody", "nowhere") == nil
    end
  end

  describe "handshake" do
    test "sends NICK + USER on init", %{vjt: vjt} do
      {server, port} = start_server()
      pid = start_session(port, vjt)

      assert {:ok, "NICK grappa-test\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"))

      # Sub-task 2f: realname defaults to the nick when no `:realname`
      # is supplied — matches the per-credential default in
      # `Grappa.Networks.Credential` (and what `Grappa.IRC.Client`
      # falls back to).
      assert {:ok, "USER grappa-test 0 * :grappa-test\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "autojoin on 001" do
    test "sends JOIN for each configured channel after server welcome", %{vjt: vjt} do
      {server, port} = start_server()

      pid = start_session(port, vjt, %{autojoin: ["#sniffo", "#other"]})

      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")

      assert {:ok, "JOIN #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #sniffo\r\n"))

      assert {:ok, "JOIN #other\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #other\r\n"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "no JOIN sent when autojoin list is empty", %{vjt: vjt} do
      {server, port} = start_server()

      pid = start_session(port, vjt, %{autojoin: []})

      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")
      Process.sleep(100)

      refute Enum.any?(IRCServer.sent_lines(server), &String.starts_with?(&1, "JOIN"))
      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "PING/PONG" do
    test "responds to server PING with matching PONG", %{vjt: vjt} do
      {server, port} = start_server()
      pid = start_session(port, vjt)

      :ok = await_handshake(server)
      IRCServer.feed(server, "PING :irc.test.org\r\n")

      assert {:ok, "PONG :irc.test.org\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PONG"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "PRIVMSG persistence + broadcast" do
    test "persists row and broadcasts canonical wire-shape event on PRIVMSG",
         %{vjt: vjt, network: network} do
      {server, port} = start_server()
      topic = Topic.channel("vjt", "test", "#sniffo")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      # Sub-task 2h regression: Phase 1 broadcast topic shape (no user
      # discriminator) must NOT receive anything anymore. If a future
      # change accidentally reverts to the old shape, this subscriber
      # would catch the leak.
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, "grappa:network:test/channel:#sniffo")

      pid = start_session(port, vjt)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":alice!~a@host PRIVMSG #sniffo :hello\r\n")

      msg =
        assert_message_event(
          kind: :privmsg,
          body: "hello",
          sender: "alice",
          channel: "#sniffo",
          network: "test",
          meta: %{}
        )

      assert is_integer(msg.server_time)
      assert is_integer(msg.id)

      # Phase 1 shape gets nothing — proves new routing iso.
      refute_received {:event, _}

      [row] = Scrollback.fetch(vjt.id, network.id, "#sniffo", nil, 10)
      assert row.body == "hello"
      assert row.sender == "alice"
      assert row.kind == :privmsg
      assert row.network_id == network.id
      assert row.channel == "#sniffo"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "broadcast scoped per (user, network, channel) — does not leak across channels",
         %{vjt: vjt} do
      {server, port} = start_server()

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel("vjt", "test", "#other")
        )

      pid = start_session(port, vjt)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":alice!~a@host PRIVMSG #sniffo :hello\r\n")

      refute_receive {:event, _}, 200
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "PER-USER ROUTING ISO: alice's subscribe on the same (network, channel) gets nothing",
         %{vjt: vjt} do
      # This is the load-bearing 2h test: even if alice subscribes to
      # the SAME network + channel pair as vjt, the user-discriminator
      # in the topic string keeps her PubSub mailbox empty. Without 2h
      # this would have leaked because Phase 1's topic was
      # `grappa:network:{net}/channel:{chan}` (shared across users).
      {server, port} = start_server()

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel("alice", "test", "#sniffo")
        )

      pid = start_session(port, vjt)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":alice!~a@host PRIVMSG #sniffo :hello\r\n")

      refute_receive {:event, _}, 200
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "server-prefixed PRIVMSG (rare but valid) records server name as sender", %{vjt: vjt} do
      {server, port} = start_server()
      topic = Topic.channel("vjt", "test", "#sniffo")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      pid = start_session(port, vjt)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org PRIVMSG #sniffo :system message\r\n")

      assert_receive {:event, %{message: %{sender: "irc.test.org", body: "system message"}}},
                     1_000

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "non-PRIVMSG events" do
    test "JOIN/PART/QUIT/NICK/MODE/TOPIC/KICK are logged but not persisted or broadcast",
         %{vjt: vjt, network: network} do
      {server, port} = start_server()

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel("vjt", "test", "#sniffo")
        )

      Logger.put_module_level(Grappa.Session.Server, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Session.Server) end)

      pid = start_session(port, vjt)

      :ok = await_handshake(server)

      log =
        capture_log(fn ->
          IRCServer.feed(server, ":bob!~b@host JOIN #sniffo\r\n")
          IRCServer.feed(server, ":bob!~b@host PART #sniffo :bye\r\n")
          Process.sleep(100)
        end)

      assert log =~ "irc event"

      refute_receive {:event, _}, 100
      assert Scrollback.fetch(vjt.id, network.id, "#sniffo", nil, 10) == []

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "malformed inbound" do
    test "parse error logged, session stays alive", %{vjt: vjt} do
      {server, port} = start_server()
      pid = start_session(port, vjt)

      :ok = await_handshake(server)

      log =
        capture_log(fn ->
          IRCServer.feed(server, ":\r\n")
          Process.sleep(100)
        end)

      assert log =~ "irc parse failed"
      assert Process.alive?(pid)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end
end
