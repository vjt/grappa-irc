defmodule Grappa.Session.ServerTest do
  @moduledoc """
  Integration tests for `Grappa.Session.Server` — the per-(user, network)
  GenServer. Uses `Grappa.IRCServer` (in-process TCP fake) instead of
  mocking `:gen_tcp` per CLAUDE.md "Mock at boundaries (Mox), real
  dependencies inside."

  ## Cluster 2 — A2 cycle inversion

  `Session.Server.init/1` is a pure data consumer: it takes the
  fully-resolved `Grappa.Session.start_opts/0` plan (host / port /
  tls / nick / realname / sasl_user / password / auth_method /
  autojoin_channels / user_name / network_slug). `SessionPlan.resolve/1`
  is the canonical producer; tests build the DB rows via
  `network_with_server/1` + `credential_fixture/3` then go through
  `start_session_for/2` (in `Grappa.AuthFixtures`) which mirrors
  Bootstrap's production resolve-then-spawn shape.

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

  alias Grappa.{IRCServer, PubSub.Topic, Scrollback, Session}
  alias Grappa.Networks.{Credentials, SessionPlan}

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server(handler \\ passthrough_handler()) do
    {:ok, server} = IRCServer.start_link(handler)
    {server, IRCServer.port(server)}
  end

  # See `Grappa.IRC.ClientTest` — same trick. Bind ephemeral, capture,
  # release. The connect attempt that follows refuses fast on localhost
  # because nothing took the port back over in the meantime.
  defp pick_unused_port do
    {:ok, l} = :gen_tcp.listen(0, [])
    {:ok, port} = :inet.port(l)
    :gen_tcp.close(l)
    port
  end

  defp setup_user_and_network(port, cred_attrs \\ %{}) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    credential = credential_fixture(user, network, cred_attrs)
    {user, network, credential}
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

    # Cluster 2 (A2): the "missing credential / missing servers"
    # failure modes moved out of `Session.Server.init/1` and into
    # `SessionPlan.resolve/1` (the data resolver). The equivalent
    # invariants now live in `Grappa.NetworksTest` —
    # `SessionPlan.resolve/1 returns {:error, :no_server}` and friends.
    # Server boot can still fail at `Client.start_link` (port
    # refused) — covered by the `bootstrap_test.exs` partial-failure
    # path which exercises a refused upstream port end-to-end.
  end

  describe "init/1 non-blocking (C2)" do
    # Pairs with `Grappa.IRC.ClientTest`'s C2 test. `Session.Server.init/1`
    # must NOT call `Client.start_link/1` synchronously: Bootstrap iterates
    # credentials sequentially via `Enum.reduce` and a slow upstream would
    # serialize every other (user, network) start_child. Client spawn
    # moves into `handle_continue(:connect, _)`.

    test "Server.start_link/1 returns {:ok, pid} even when upstream is unreachable" do
      # Test the GenServer init contract directly — `Session.Server.start_link/1`
      # — instead of going through `Session.start_session/3` /
      # `DynamicSupervisor`. The `:transient` restart cycle that fires when
      # the connect-refused crash propagates would otherwise burn through the
      # singleton `SessionSupervisor`'s `max_restarts: 3` budget in <100ms,
      # crashing the supervisor and cascading through every other Session in
      # the test run. Linking to the test pid (via `start_link`) traps the
      # crash here so the supervisor is never involved.
      port = pick_unused_port()
      {user, network, _} = setup_user_and_network(port)
      Process.flag(:trap_exit, true)

      credential = Credentials.get_credential!(user, network)
      {:ok, plan} = SessionPlan.resolve(credential)
      init_opts = Map.merge(plan, %{user_id: user.id, network_id: network.id})

      # Pre-fix: `Client.start_link/1` returns `{:error, :econnrefused}`
      # synchronously inside `Session.Server.init/1`, which returns
      # `{:stop, _}` → `Server.start_link/1` returns `{:error, _}`.
      # Post-fix: `init/1` returns ok-with-continue, Client spawn happens
      # async in `handle_continue`, `start_link/1` returns `{:ok, pid}`.
      assert {:ok, pid} = Grappa.Session.Server.start_link(init_opts)
      assert is_pid(pid)

      # The connect failure surfaces async — `Client.start_link/1` returns
      # `{:ok, _}` immediately (post-C2), `Session.handle_continue/2` writes
      # the client pid into state, then the Client's OWN `handle_continue`
      # runs the connect, hits :econnrefused, and crashes. The link kills
      # Session with the same `{:connect_failed, _}` reason — no
      # `:client_start_failed` wrapping (that path only fires if
      # `Client.start_link/1` itself returns `{:error, _}`, e.g. a
      # `{:missing_password, _}` validation failure).
      assert_receive {:EXIT, ^pid, {:connect_failed, _}}, 1_000
    end
  end

  describe "registration" do
    test "registers via {user_id, network_id} in Grappa.SessionRegistry" do
      {_, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      assert Session.whereis({:user, user.id}, network.id) == pid
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
      assert Session.whereis({:user, vjt.id}, net1.id) == pid1
      assert Session.whereis({:user, alice.id}, net2.id) == pid2

      :ok = GenServer.stop(pid1, :normal, 1_000)
      :ok = GenServer.stop(pid2, :normal, 1_000)
    end

    test "whereis/2 returns nil for unknown keys" do
      assert Session.whereis({:user, Ecto.UUID.generate()}, 999_999_999) == nil
    end

    test "user-subject and visitor-subject sessions for the same network_id coexist on the registry" do
      # Task 6.5 isolation guarantee. The registry key is
      # `{:session, subject, network_id}` — different first-tuple-element
      # discriminates user from visitor even when the underlying UUID
      # happens to coincide. Visitor.SessionPlan + visitor wiring land
      # in Task 7+; this test hand-crafts the visitor opts to isolate
      # the subject-tuple registry behavior at the Session boundary.
      {_, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      user_pid = start_session_for(user, network)

      visitor_id = Ecto.UUID.generate()
      visitor_subject = {:visitor, visitor_id}

      visitor_plan = %{
        subject: visitor_subject,
        subject_label: "visitor:" <> visitor_id,
        network_slug: network.slug,
        nick: "vsh",
        realname: "Grappa Visitor",
        sasl_user: "vsh",
        auth_method: :none,
        password: nil,
        autojoin_channels: [],
        host: "127.0.0.1",
        port: port,
        tls: false
      }

      Process.flag(:trap_exit, true)
      {:ok, visitor_pid} = Session.start_session(visitor_subject, network.id, visitor_plan)

      assert Session.whereis({:user, user.id}, network.id) == user_pid
      assert Session.whereis(visitor_subject, network.id) == visitor_pid
      assert user_pid != visitor_pid

      :ok = Session.stop_session(visitor_subject, network.id)
      :ok = GenServer.stop(user_pid, :normal, 1_000)
    end
  end

  describe "stop_session/2 + unbind_credential teardown (S29 H5)" do
    test "stop_session/2 is idempotent for unknown keys" do
      assert :ok = Session.stop_session({:user, Ecto.UUID.generate()}, 999_999_999)
    end

    test "stop_session/2 tears down a running Session and clears the registry" do
      {_, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      assert Process.alive?(pid)
      assert Session.whereis({:user, user.id}, network.id) == pid

      assert :ok = Session.stop_session({:user, user.id}, network.id)

      refute Process.alive?(pid)
      assert Session.whereis({:user, user.id}, network.id) == nil
    end

    # The integration check: Credentials.unbind_credential/2 must call
    # stop_session/2 BEFORE deleting the credential row so the running
    # GenServer doesn't outlive the FK row it cached. Without the
    # teardown the GenServer's `state.network_id` points at a deleted
    # row; the next outbound PRIVMSG crashes the call handler and
    # the `:transient` restart would loop forever (init can't reload
    # the now-absent credential).
    test "Credentials.unbind_credential/2 tears down the running session" do
      {_, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      assert Process.alive?(pid)

      assert :ok = Credentials.unbind_credential(user, network)

      refute Process.alive?(pid)
      assert Session.whereis({:user, user.id}, network.id) == nil
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

  describe "non-PRIVMSG events (post-E1: persisted + broadcast via EventRouter)" do
    test "JOIN + PART are persisted to scrollback + broadcast on PubSub" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)

      :ok =
        Phoenix.PubSub.subscribe(
          Grappa.PubSub,
          Topic.channel(user.name, network.slug, "#sniffo")
        )

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":bob!~b@host JOIN #sniffo\r\n")
      IRCServer.feed(server, ":bob!~b@host PART #sniffo :bye\r\n")

      assert_receive {:event, %{message: %{kind: :join, sender: "bob"}}}, 1_000
      assert_receive {:event, %{message: %{kind: :part, sender: "bob", body: "bye"}}}, 1_000

      rows = Scrollback.fetch(user.id, network.id, "#sniffo", nil, 10)
      kinds = Enum.map(rows, & &1.kind)
      assert :join in kinds
      assert :part in kinds

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "nick mutation tracking (C6 / S13)" do
    # `state.nick` is captured at `init/1` from the credential's nick
    # field, but the upstream server is the source of truth: a nick
    # collision can land us on a fallback (`433 ERR_NICKNAMEINUSE`
    # is currently fatal but Phase 5 may add fallback), `001 RPL_WELCOME`
    # always echoes the *welcomed* nick (which may differ from
    # requested even on a clean register), and an admin/services-issued
    # forced rename arrives as a self-prefixed `NICK` after
    # registration. Without tracking, outbound PRIVMSGs from the
    # operator persist Scrollback rows with the dead nick — and the
    # rows are forever (immutable historical record).

    test "RPL_WELCOME echoes welcomed nick: subsequent PRIVMSG persists with welcomed nick" do
      welcomed_nick_handler = fn state, line ->
        if String.starts_with?(line, "USER ") do
          # Server registers the operator under a different nick than
          # the one requested (rare but possible — Azzurra used to do
          # this with case-fold normalization).
          {:reply, ":server 001 grappa-actual :Welcome\r\n", state}
        else
          {:reply, nil, state}
        end
      end

      {server, port} = start_server(welcomed_nick_handler)
      {user, network, _} = setup_user_and_network(port)

      topic = Topic.channel(user.name, network.slug, "#sniffo")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      # Autojoin JOIN signals Session has processed `001` fully.
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      assert {:ok, msg} = Session.send_privmsg({:user, user.id}, network.id, "#sniffo", "hi")
      assert msg.sender == "grappa-actual"

      assert_message_event(
        kind: :privmsg,
        body: "hi",
        sender: "grappa-actual",
        channel: "#sniffo",
        network: network.slug,
        meta: %{}
      )

      [row] = Scrollback.fetch(user.id, network.id, "#sniffo", nil, 10)
      assert row.sender == "grappa-actual"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "self-NICK rename: subsequent PRIVMSG persists with new nick" do
      rfc_handler = fn state, line ->
        if String.starts_with?(line, "USER ") do
          {:reply, ":server 001 grappa-test :Welcome\r\n", state}
        else
          {:reply, nil, state}
        end
      end

      {server, port} = start_server(rfc_handler)
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      # Forced upstream rename — services or operator-driven.
      IRCServer.feed(server, ":grappa-test!u@h NICK :renamed-vjt\r\n")

      # PING/PONG round-trip flushes the cross-process pipeline:
      # the NICK has cleared TCP buffer, Client mailbox, and Session
      # mailbox by the time we see the PONG line back at the server.
      # `:sys.get_state` alone is insufficient — it serializes against
      # the Session mailbox but the NICK message may still be in
      # transit through the kernel TCP buffer or the Client GenServer.
      IRCServer.feed(server, "PING :flush\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"))

      assert {:ok, msg} = Session.send_privmsg({:user, user.id}, network.id, "#sniffo", "post-rename")
      assert msg.sender == "renamed-vjt"

      [row] = Scrollback.fetch(user.id, network.id, "#sniffo", nil, 10)
      assert row.sender == "renamed-vjt"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "other-user NICK rename does NOT affect own state.nick" do
      rfc_handler = fn state, line ->
        if String.starts_with?(line, "USER ") do
          {:reply, ":server 001 grappa-test :Welcome\r\n", state}
        else
          {:reply, nil, state}
        end
      end

      {server, port} = start_server(rfc_handler)
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      IRCServer.feed(server, ":alice!~a@host NICK :alice2\r\n")

      # PING/PONG flushes — same rationale as the self-rename test.
      IRCServer.feed(server, "PING :flush\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"))

      assert {:ok, msg} = Session.send_privmsg({:user, user.id}, network.id, "#sniffo", "still me")
      assert msg.sender == "grappa-test"

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

  describe "EventRouter delegation — members tracking" do
    test "Session.Server starts with empty members map" do
      {_, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      state = :sys.get_state(pid)
      assert state.members == %{}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "JOIN-self resets members[channel] to %{own_nick => []}" do
      handler = fn state, line ->
        if String.starts_with?(line, "USER ") do
          {:reply, ":irc 001 grappa-test :Welcome\r\n", state}
        else
          {:reply, nil, state}
        end
      end

      {server, port} = start_server(handler)

      {user, network, _} =
        setup_user_and_network(port, %{autojoin_channels: ["#test"]})

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#test\r\n")

      # PING/PONG flush — same trick as nick-mutation tests above.
      IRCServer.feed(server, "PING :flush\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"))

      state = :sys.get_state(pid)
      assert state.members["#test"] == %{"grappa-test" => []}

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "353 RPL_NAMREPLY populates members with mode prefixes parsed" do
      handler = fn state, line ->
        if String.starts_with?(line, "USER ") do
          {:reply, ":irc 001 grappa-test :Welcome\r\n", state}
        else
          {:reply, nil, state}
        end
      end

      {server, port} = start_server(handler)

      {user, network, _} =
        setup_user_and_network(port, %{autojoin_channels: ["#test"]})

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#test\r\n")
      IRCServer.feed(server, ":irc 353 grappa-test = #test :@grappa-test +alice bob\r\n")
      IRCServer.feed(server, ":irc 366 grappa-test #test :End of /NAMES list.\r\n")
      IRCServer.feed(server, "PING :flush\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"))

      state = :sys.get_state(pid)

      assert state.members["#test"] == %{
               "grappa-test" => ["@"],
               "alice" => ["+"],
               "bob" => []
             }

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "QUIT removes nick from every channel + persists one row per channel" do
      handler = fn state, line ->
        if String.starts_with?(line, "USER ") do
          {:reply, ":irc 001 grappa-test :Welcome\r\n", state}
        else
          {:reply, nil, state}
        end
      end

      {server, port} = start_server(handler)

      {user, network, _} =
        setup_user_and_network(port, %{autojoin_channels: ["#a", "#b"]})

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN #a"))
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN #b"))

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#a\r\n")
      IRCServer.feed(server, ":grappa-test!u@h JOIN :#b\r\n")
      IRCServer.feed(server, ":alice!u@h JOIN :#a\r\n")
      IRCServer.feed(server, ":alice!u@h JOIN :#b\r\n")
      IRCServer.feed(server, ":alice!u@h QUIT :Ping timeout\r\n")
      IRCServer.feed(server, "PING :flush\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"))

      state = :sys.get_state(pid)
      refute Map.has_key?(state.members["#a"], "alice")
      refute Map.has_key?(state.members["#b"], "alice")

      rows_a = Scrollback.fetch(user.id, network.id, "#a", nil, 10)
      assert Enum.any?(rows_a, &(&1.kind == :quit and &1.sender == "alice"))

      rows_b = Scrollback.fetch(user.id, network.id, "#b", nil, 10)
      assert Enum.any?(rows_b, &(&1.kind == :quit and &1.sender == "alice"))

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "list_members/3 snapshot" do
    test "returns members in mIRC sort: @ ops first, + voiced second, plain last" do
      handler = fn state, line ->
        if String.starts_with?(line, "USER ") do
          {:reply, ":irc 001 grappa-test :Welcome\r\n", state}
        else
          {:reply, nil, state}
        end
      end

      {server, port} = start_server(handler)

      {user, network, _} =
        setup_user_and_network(port, %{autojoin_channels: ["#test"]})

      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#test\r\n")

      IRCServer.feed(
        server,
        ":irc 353 grappa-test = #test :@op_a +voice_a plain_b @op_b plain_a\r\n"
      )

      IRCServer.feed(server, ":irc 366 grappa-test #test :End\r\n")
      IRCServer.feed(server, "PING :flush\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"))

      assert {:ok, members} = Session.list_members({:user, user.id}, network.id, "#test")

      # mIRC sort: @ ops alphabetical → + voiced alphabetical → plain alphabetical
      # `grappa-test` is the operator's own nick (added by JOIN-self with no
      # modes); it sorts under "plain" tier alphabetically before plain_a.
      assert members == [
               %{nick: "op_a", modes: ["@"]},
               %{nick: "op_b", modes: ["@"]},
               %{nick: "voice_a", modes: ["+"]},
               %{nick: "grappa-test", modes: []},
               %{nick: "plain_a", modes: []},
               %{nick: "plain_b", modes: []}
             ]

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "no session for (user, network) returns {:error, :no_session}" do
      assert {:error, :no_session} =
               Session.list_members({:user, Ecto.UUID.generate()}, 999_999_999, "#test")
    end

    test "channel not in members returns empty list" do
      {_, port} = start_server()
      {user, network, _} = setup_user_and_network(port)

      pid = start_session_for(user, network)

      assert {:ok, []} = Session.list_members({:user, user.id}, network.id, "#nowhere")

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "list_channels via GenServer.call" do
    test "returns Map.keys(state.members) sorted alphabetically" do
      {_, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      :sys.replace_state(pid, fn state ->
        %{
          state
          | members: %{
              "#azzurra" => %{"vjt" => []},
              "#italia" => %{"vjt" => [], "alice" => []},
              "#bnc" => %{"vjt" => []}
            }
        }
      end)

      assert {:ok, channels} = GenServer.call(pid, {:list_channels})
      assert channels == ["#azzurra", "#bnc", "#italia"]

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "returns empty list when state.members is empty" do
      {_, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      assert {:ok, []} = GenServer.call(pid, {:list_channels})

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "Session.list_channels/2 facade" do
    test "returns sorted channel-name list from session state" do
      {_, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      :sys.replace_state(pid, fn state ->
        %{
          state
          | members: %{
              "#italia" => %{"vjt" => []},
              "#azzurra" => %{"vjt" => []}
            }
        }
      end)

      assert {:ok, ["#azzurra", "#italia"]} =
               Session.list_channels({:user, user.id}, network.id)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "send_topic/4" do
    test "persists a :topic scrollback row, broadcasts, and writes TOPIC upstream" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)
      :ok = await_handshake(server)

      assert {:ok, message} =
               Session.send_topic({:user, user.id}, network.id, "#italia", "new topic")

      assert message.kind == :topic
      assert message.channel == "#italia"
      assert message.body == "new topic"
      assert message.sender == "grappa-test"

      {:ok, line} =
        IRCServer.wait_for_line(server, &String.starts_with?(&1, "TOPIC "))

      assert line == "TOPIC #italia :new topic\r\n"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "rejects CRLF in body before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_topic({:user, Ecto.UUID.generate()}, 999_999, "#x", "bad\r\nINJECT")
    end

    test "rejects CRLF in channel before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_topic({:user, Ecto.UUID.generate()}, 999_999, "#x\r\nQUIT", "ok")
    end

    test "no_session for unknown (user, network)" do
      assert {:error, :no_session} =
               Session.send_topic({:user, Ecto.UUID.generate()}, 999_999, "#x", "ok")
    end
  end

  describe "send_nick/3" do
    test "writes NICK upstream" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)
      :ok = await_handshake(server)

      assert :ok = Session.send_nick({:user, user.id}, network.id, "vjt-away")

      {:ok, line} =
        IRCServer.wait_for_line(server, &(&1 == "NICK vjt-away\r\n"))

      assert line == "NICK vjt-away\r\n"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "rejects CRLF in nick before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_nick({:user, Ecto.UUID.generate()}, 999_999, "vjt\r\nQUIT")
    end

    test "no_session for unknown (user, network)" do
      assert {:error, :no_session} =
               Session.send_nick({:user, Ecto.UUID.generate()}, 999_999, "newnick")
    end
  end

  describe "channels_changed broadcast on user topic" do
    # Server-side half of the cicchetto live-channel-on-/join fix.
    # Whenever `Map.keys(state.members)` mutates between input + derived
    # state in `Session.Server.delegate/2`, fire a fan-out
    # `%{kind: "channels_changed"}` broadcast on `Topic.user(user_name)`
    # so every connected tab refetches GET /channels and re-subscribes
    # to per-channel WS topics. Direction-agnostic: self-JOIN, self-PART,
    # self-KICK collapse to the same heartbeat (channels-list mutation
    # IS the event; cause is irrelevant to subscribers).

    defp welcome_handler do
      fn state, line ->
        if String.starts_with?(line, "USER ") do
          {:reply, ":irc 001 grappa-test :Welcome\r\n", state}
        else
          {:reply, nil, state}
        end
      end
    end

    test "self-JOIN broadcasts channels_changed on user topic" do
      {server, port} = start_server(welcome_handler())
      {user, network, _} = setup_user_and_network(port)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      pid = start_session_for(user, network)
      :ok = await_handshake(server)

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#newchan\r\n")

      assert_receive {:event, %{kind: "channels_changed"}}, 1_000

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "self-PART broadcasts channels_changed on user topic" do
      {server, port} = start_server(welcome_handler())

      {user, network, _} =
        setup_user_and_network(port, %{autojoin_channels: ["#existing"]})

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      pid = start_session_for(user, network)
      :ok = await_handshake(server)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#existing\r\n")
      assert_receive {:event, %{kind: "channels_changed"}}, 1_000

      IRCServer.feed(server, ":grappa-test!u@h PART #existing :bye\r\n")
      assert_receive {:event, %{kind: "channels_changed"}}, 1_000

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "self-KICK broadcasts channels_changed on user topic" do
      {server, port} = start_server(welcome_handler())

      {user, network, _} =
        setup_user_and_network(port, %{autojoin_channels: ["#existing"]})

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      pid = start_session_for(user, network)
      :ok = await_handshake(server)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#existing\r\n")
      assert_receive {:event, %{kind: "channels_changed"}}, 1_000

      IRCServer.feed(server, ":op!u@h KICK #existing grappa-test :reason\r\n")
      assert_receive {:event, %{kind: "channels_changed"}}, 1_000

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "other-user JOIN does NOT broadcast (keyset unchanged)" do
      {server, port} = start_server(welcome_handler())

      {user, network, _} =
        setup_user_and_network(port, %{autojoin_channels: ["#existing"]})

      pid = start_session_for(user, network)
      :ok = await_handshake(server)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#existing\r\n")

      # PING/PONG flushes the self-JOIN through before we subscribe,
      # so we don't see the keyset-grow broadcast for the autojoin.
      IRCServer.feed(server, "PING :flush1\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush1\r\n"))

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      IRCServer.feed(server, ":alice!u@h JOIN :#existing\r\n")
      IRCServer.feed(server, "PING :flush2\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush2\r\n"))

      refute_receive {:event, %{kind: "channels_changed"}}, 200

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "PRIVMSG does NOT broadcast (keyset unchanged)" do
      {server, port} = start_server(welcome_handler())

      {user, network, _} =
        setup_user_and_network(port, %{autojoin_channels: ["#existing"]})

      pid = start_session_for(user, network)
      :ok = await_handshake(server)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#existing\r\n")
      IRCServer.feed(server, "PING :flush1\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush1\r\n"))

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      IRCServer.feed(server, ":alice!u@h PRIVMSG #existing :hello\r\n")
      IRCServer.feed(server, "PING :flush2\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush2\r\n"))

      refute_receive {:event, %{kind: "channels_changed"}}, 200

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "notify_pid/notify_ref synchronous login readiness (Task 8)" do
    # Task 8 / W5 — Visitors.Login (Task 9) blocks the synchronous
    # POST /auth/login until upstream registration completes. The
    # block is implemented by passing a `notify_pid` + `notify_ref`
    # pair into `start_opts` so the spawning request handler can
    # `receive` the readiness signal once the Session.Server observes
    # `001 RPL_WELCOME`. One-shot so a future reconnect-001 doesn't
    # re-fire to a long-dead login probe.

    test "caller receives {:session_ready, ref} on first 001 RPL_WELCOME" do
      {server, port} = start_server()
      {user, network, credential} = setup_user_and_network(port)

      parent = self()
      ref = make_ref()

      {:ok, base_plan} = SessionPlan.resolve(credential)
      plan = Map.merge(base_plan, %{notify_pid: parent, notify_ref: ref})
      {:ok, pid} = Session.start_session({:user, user.id}, network.id, plan)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")

      assert_receive {:session_ready, ^ref}, 5_000
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "notify is one-shot — second 001 does NOT re-fire" do
      {server, port} = start_server()
      {user, network, credential} = setup_user_and_network(port)

      parent = self()
      ref = make_ref()

      {:ok, base_plan} = SessionPlan.resolve(credential)
      plan = Map.merge(base_plan, %{notify_pid: parent, notify_ref: ref})
      {:ok, pid} = Session.start_session({:user, user.id}, network.id, plan)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")
      assert_receive {:session_ready, ^ref}, 5_000

      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome again\r\n")
      refute_receive {:session_ready, ^ref}, 200

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "no notify opts — Session.Server runs normally without firing" do
      {server, port} = start_server()
      {user, network, _} = setup_user_and_network(port)
      pid = start_session_for(user, network)

      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")

      refute_receive {:session_ready, _}, 200
      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end
end
