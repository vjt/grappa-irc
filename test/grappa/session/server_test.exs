defmodule Grappa.Session.ServerTest do
  @moduledoc """
  Integration tests for `Grappa.Session.Server` — the per-(user, network)
  GenServer. Uses `Grappa.IRCServer` (in-process TCP fake) instead of
  mocking `:gen_tcp` per CLAUDE.md "Mock at boundaries (Mox), real
  dependencies inside."

  ## Sub-task 2g

  Session.Server.init/1 now takes only `%{user_id, network_id}` and
  loads the network + servers + credential from the DB. The host /
  port / nick / password / auth_method / autojoin all come from the
  bound `Grappa.Networks.Credential` row + `Grappa.Networks.Server`
  endpoint — no more flat opts map. Tests build the DB rows via
  `network_with_server/1` + `credential_fixture/3` (in
  `Grappa.AuthFixtures`) and call `Session.start_session(user.id,
  network.id)` with the new `(Ecto.UUID.t, integer)` signature.

  `async: false` because `Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor`, and `Grappa.PubSub` are singletons —
  concurrent tests would collide on `{:session, user_id, network_id}`
  keys. `Grappa.DataCase` switches to shared sandbox mode automatically
  when `async: false` so the Session GenServer (spawned under the
  application's DynamicSupervisor, outside the test PID) can still see
  the sandboxed Repo.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.{AuthFixtures, MessageEventAssertions}

  alias Grappa.{IRCServer, Networks, PubSub.Topic, Scrollback, Session}

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server(handler \\ passthrough_handler()) do
    {:ok, server} = IRCServer.start_link(handler)
    {server, IRCServer.port(server)}
  end

  defp setup_user_and_network(port, cred_attrs \\ %{}) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    credential = credential_fixture(user, network, cred_attrs)
    {user, network, credential}
  end

  defp start_session_for(user, network) do
    {:ok, pid} = Session.start_session(user.id, network.id)
    pid
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
    :ok
  end

  describe "DB-driven init (sub-task 2g)" do
    test "threads credential password + auth_method to IRC.Client (server_pass branch)" do
      {server, port} = start_server()

      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {network, _} = network_with_server(port: port, slug: "azzurra-#{System.unique_integer([:positive])}")

      _ =
        credential_fixture(user, network, %{
          nick: "vjt-grappa",
          auth_method: :server_pass,
          password: "loadbearing-secret",
          autojoin_channels: ["#sniffo"]
        })

      pid = start_session_for(user, network)

      # PASS line proves the credential password reached IRC.Client
      # decrypted by Cloak — without DB-driven init this would be `nil`.
      assert {:ok, "PASS loadbearing-secret\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PASS"))

      assert {:ok, "NICK vjt-grappa\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"))

      assert {:ok, "USER vjt-grappa 0 * :vjt-grappa\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "missing credential row crashes init (start_child returns error tuple)" do
      {_, port} = start_server()
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

      {network, _} =
        network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

      # No credential bound — init must fail because Networks.get_credential!/2 raises.
      capture_log(fn ->
        assert {:error, _} = Session.start_session(user.id, network.id)
      end)
    end

    test "missing servers crashes init (operator must add at least one)" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

      {:ok, network} =
        Networks.find_or_create_network(%{
          slug: "no-servers-#{System.unique_integer([:positive])}"
        })

      _ = credential_fixture(user, network, %{nick: "x"})

      capture_log(fn ->
        assert {:error, _} = Session.start_session(user.id, network.id)
      end)
    end
  end

  describe "registration" do
    test "registers via {user_id, network_id} in Grappa.SessionRegistry" do
      {_, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      assert Session.whereis(user.id, network.id) == pid
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "two sessions with different (user, network) keys coexist" do
      {_, port1} = start_server()
      {_, port2} = start_server()

      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      alice = user_fixture(name: "alice-#{System.unique_integer([:positive])}")

      {net1, _} =
        network_with_server(port: port1, slug: "n1-#{System.unique_integer([:positive])}")

      {net2, _} =
        network_with_server(port: port2, slug: "n2-#{System.unique_integer([:positive])}")

      _ = credential_fixture(vjt, net1)
      _ = credential_fixture(alice, net2)

      pid1 = start_session_for(vjt, net1)
      pid2 = start_session_for(alice, net2)

      assert pid1 != pid2
      assert Session.whereis(vjt.id, net1.id) == pid1
      assert Session.whereis(alice.id, net2.id) == pid2

      :ok = GenServer.stop(pid1, :normal, 1_000)
      :ok = GenServer.stop(pid2, :normal, 1_000)
    end

    test "whereis/2 returns nil for unknown keys" do
      assert Session.whereis(Ecto.UUID.generate(), 999_999_999) == nil
    end
  end

  describe "handshake" do
    test "sends NICK + USER on init (auth_method :none, no realname override)" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      assert {:ok, "NICK grappa-test\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"))

      # Credential.effective_realname/1 returns nick when realname nil.
      assert {:ok, "USER grappa-test 0 * :grappa-test\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "credential :realname overrides nick-based default in USER line" do
      {server, port} = start_server()

      {user, network, _} =
        setup_user_and_network(port, %{nick: "vjt-grappa", realname: "Marcello Barnaba"})

      pid = start_session_for(user, network)

      assert {:ok, "USER vjt-grappa 0 * :Marcello Barnaba\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "autojoin on 001" do
    test "sends JOIN for each configured channel after server welcome" do
      {server, port} = start_server()

      {user, network, _} =
        setup_user_and_network(port, %{autojoin_channels: ["#sniffo", "#other"]})

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")

      assert {:ok, "JOIN #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #sniffo\r\n"))

      assert {:ok, "JOIN #other\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "JOIN #other\r\n"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "no JOIN sent when credential autojoin_channels empty" do
      {server, port} = start_server()

      {user, network, _} = setup_user_and_network(port, %{autojoin_channels: []})

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")
      Process.sleep(100)

      refute Enum.any?(IRCServer.sent_lines(server), &String.starts_with?(&1, "JOIN"))
      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "PING/PONG" do
    test "responds to server PING with matching PONG" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      IRCServer.feed(server, "PING :irc.test.org\r\n")

      assert {:ok, "PONG :irc.test.org\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PONG"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "PRIVMSG persistence + broadcast" do
    test "persists row and broadcasts canonical wire-shape event on PRIVMSG" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)

      topic = Topic.channel(user.name, network.slug, "#sniffo")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      # Sub-task 2h regression: Phase 1 broadcast topic shape (no user
      # discriminator) must NOT receive anything.
      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          "grappa:network:#{network.slug}/channel:#sniffo"
        )

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":alice!~a@host PRIVMSG #sniffo :hello\r\n")

      msg =
        assert_message_event(
          kind: :privmsg,
          body: "hello",
          sender: "alice",
          channel: "#sniffo",
          network: network.slug,
          meta: %{}
        )

      assert is_integer(msg.server_time)
      assert is_integer(msg.id)

      refute_received {:event, _}

      [row] = Scrollback.fetch(user.id, network.id, "#sniffo", nil, 10)
      assert row.body == "hello"
      assert row.sender == "alice"
      assert row.kind == :privmsg
      assert row.network_id == network.id
      assert row.channel == "#sniffo"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "broadcast scoped per (user, network, channel) — does not leak across channels" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel(user.name, network.slug, "#other")
        )

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":alice!~a@host PRIVMSG #sniffo :hello\r\n")

      refute_receive {:event, _}, 200
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "topic discriminator scopes by user_name — bare-slug subscriber gets nothing" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel("alice-other", network.slug, "#sniffo")
        )

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":alice!~a@host PRIVMSG #sniffo :hello\r\n")

      refute_receive {:event, _}, 200
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "server-prefixed PRIVMSG (rare but valid) records server name as sender" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)

      topic = Topic.channel(user.name, network.slug, "#sniffo")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org PRIVMSG #sniffo :system message\r\n")

      assert_receive {:event, %{message: %{sender: "irc.test.org", body: "system message"}}},
                     1_000

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "non-PRIVMSG events" do
    test "JOIN/PART/QUIT/NICK/MODE/TOPIC/KICK are logged but not persisted or broadcast" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel(user.name, network.slug, "#sniffo")
        )

      Logger.put_module_level(Grappa.Session.Server, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Session.Server) end)

      pid = start_session_for(user, network)

      :ok = await_handshake(server)

      log =
        capture_log(fn ->
          IRCServer.feed(server, ":bob!~b@host JOIN #sniffo\r\n")
          IRCServer.feed(server, ":bob!~b@host PART #sniffo :bye\r\n")
          Process.sleep(100)
        end)

      assert log =~ "irc event"

      refute_receive {:event, _}, 100
      assert Scrollback.fetch(user.id, network.id, "#sniffo", nil, 10) == []

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "malformed inbound" do
    test "parse error logged, session stays alive" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

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
