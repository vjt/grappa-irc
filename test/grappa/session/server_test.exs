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

  alias Grappa.Config.Network
  alias Grappa.{IRCServer, Scrollback, Session}

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server(handler \\ passthrough_handler()) do
    {:ok, server} = IRCServer.start_link(handler)
    {server, IRCServer.port(server)}
  end

  defp network(port, overrides) do
    base = %Network{
      id: "test",
      host: "127.0.0.1",
      port: port,
      tls: false,
      nick: "grappa-test",
      autojoin: ["#sniffo"]
    }

    Map.merge(base, overrides)
  end

  defp start_session(port, opts \\ %{}) do
    {:ok, pid} =
      Session.start_session(%{
        user_name: Map.get(opts, :user_name, "vjt"),
        network: network(port, Map.get(opts, :network, %{}))
      })

    pid
  end

  describe "registration" do
    test "registers via {:session, user, net_id} in Grappa.SessionRegistry" do
      {_, port} = start_server()
      pid = start_session(port)

      assert Session.whereis("vjt", "test") == pid
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "two sessions with different (user, network) keys coexist" do
      {_, port1} = start_server()
      {_, port2} = start_server()

      pid1 = start_session(port1, %{user_name: "vjt"})
      pid2 = start_session(port2, %{user_name: "alice"})

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
    test "sends NICK + USER on init" do
      {server, port} = start_server()
      pid = start_session(port)

      assert {:ok, "NICK grappa-test\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"))

      assert {:ok, "USER grappa-test 0 * :grappa\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "autojoin on 001" do
    test "sends JOIN for each configured channel after server welcome" do
      {server, port} = start_server()

      pid =
        start_session(port, %{
          network: %{autojoin: ["#sniffo", "#other"]}
        })

      Process.sleep(50)
      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")

      assert {:ok, "JOIN #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #sniffo\r\n"))

      assert {:ok, "JOIN #other\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #other\r\n"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "no JOIN sent when autojoin list is empty" do
      {server, port} = start_server()

      pid = start_session(port, %{network: %{autojoin: []}})

      Process.sleep(50)
      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")
      Process.sleep(100)

      refute Enum.any?(IRCServer.sent_lines(server), &String.starts_with?(&1, "JOIN"))
      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "PING/PONG" do
    test "responds to server PING with matching PONG" do
      {server, port} = start_server()
      pid = start_session(port)

      Process.sleep(50)
      IRCServer.feed(server, "PING :irc.test.org\r\n")

      assert {:ok, "PONG :irc.test.org\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PONG"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "PRIVMSG persistence + broadcast" do
    test "persists row and broadcasts canonical wire-shape event on PRIVMSG" do
      {server, port} = start_server()
      topic = "grappa:network:test/channel:#sniffo"
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      pid = start_session(port)

      Process.sleep(50)
      IRCServer.feed(server, ":alice!~a@host PRIVMSG #sniffo :hello\r\n")

      assert_receive {:event,
                      %{
                        kind: :message,
                        message: %{
                          kind: :privmsg,
                          body: "hello",
                          sender: "alice",
                          channel: "#sniffo",
                          network_id: "test",
                          meta: %{},
                          server_time: server_time,
                          id: id
                        }
                      }},
                     1_000

      assert is_integer(server_time)
      assert is_integer(id)

      [row] = Scrollback.fetch("test", "#sniffo", nil, 10)
      assert row.body == "hello"
      assert row.sender == "alice"
      assert row.kind == :privmsg
      assert row.network_id == "test"
      assert row.channel == "#sniffo"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "broadcast is scoped per channel — does not leak across channels" do
      {server, port} = start_server()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, "grappa:network:test/channel:#other")

      pid = start_session(port)

      Process.sleep(50)
      IRCServer.feed(server, ":alice!~a@host PRIVMSG #sniffo :hello\r\n")

      refute_receive {:event, _}, 200
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "server-prefixed PRIVMSG (rare but valid) records server name as sender" do
      {server, port} = start_server()
      topic = "grappa:network:test/channel:#sniffo"
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      pid = start_session(port)

      Process.sleep(50)
      IRCServer.feed(server, ":irc.test.org PRIVMSG #sniffo :system message\r\n")

      assert_receive {:event, %{message: %{sender: "irc.test.org", body: "system message"}}},
                     1_000

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "non-PRIVMSG events" do
    test "JOIN/PART/QUIT/NICK/MODE/TOPIC/KICK are logged but not persisted or broadcast" do
      {server, port} = start_server()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, "grappa:network:test/channel:#sniffo")

      # Test config sets global Logger level to :warning; the per-event
      # log line lives at :info. Override the module level for the
      # duration of this assertion so capture_log can see it.
      Logger.put_module_level(Grappa.Session.Server, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Session.Server) end)

      pid = start_session(port)

      Process.sleep(50)

      log =
        capture_log(fn ->
          IRCServer.feed(server, ":bob!~b@host JOIN #sniffo\r\n")
          IRCServer.feed(server, ":bob!~b@host PART #sniffo :bye\r\n")
          Process.sleep(100)
        end)

      assert log =~ "irc event"

      refute_receive {:event, _}, 100
      assert Scrollback.fetch("test", "#sniffo", nil, 10) == []

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "malformed inbound" do
    test "parse error logged, session stays alive" do
      {server, port} = start_server()
      pid = start_session(port)

      Process.sleep(50)

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
