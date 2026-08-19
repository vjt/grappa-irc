defmodule Grappa.LiveIntrospectionTest do
  @moduledoc """
  Tests for `Grappa.LiveIntrospection` — the shared live-BEAM helper
  used by both `Grappa.Operator` text formatters AND
  `GrappaWeb.Admin.*Controller` JSON wires. M-4 cluster admin console.

  ## Test isolation

  `async: false` because the registry scan in `list_sessions/0`
  reads the singleton `Grappa.SessionRegistry`. Concurrent tests
  would see each other's spawned sessions. `AdmissionStateHelpers.reset_all/0`
  in setup terminates leftover Session.Servers from prior tests so
  list_sessions/0 starts from a known-empty registry. Same shape
  as `Grappa.OperatorTest`.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{AdmissionStateHelpers, IRCServer, LiveIntrospection, Session}
  alias Grappa.LiveIntrospection.SessionEntry

  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  describe "list_sessions/0" do
    test "returns empty list when registry is empty" do
      assert LiveIntrospection.list_sessions() == []
    end

    test "returns one entry per live Session.Server with introspection fields" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      # #550 — the upstream peer is captured ASYNCHRONOUSLY: the Client dials
      # the in-process IRCServer, then pushes {:irc_peer, _} to Session.Server
      # which caches it. Until that message is processed the session is a live
      # pid with peer_address: nil, so handle_call({:connection_info}) replies
      # {:error, :no_peer} (peer_address/3 projects it) and `introspection_degraded`
      # carries :peer_address
      # (server.ex + fetch_peer_address). This test reads introspection_degraded
      # right after spawn, so without a barrier it races the capture — green
      # when the {:irc_peer, _} lands first (pull_request / local fast timing),
      # red when the registry scan wins (CI push slow timing, same sha: the
      # flake this fixes). USER is sent right AFTER the Client pushes
      # {:irc_peer, _}, so waiting for it guarantees the peer is captured before
      # the scan — the same deterministic barrier the #550 peer-capture test
      # below uses. NOT an assertion weakening: it makes `== []` honest.
      :ok = IRCServer.await_handshake(server, 1_000)

      entries = LiveIntrospection.list_sessions()

      assert [%SessionEntry{} = entry] = entries
      assert entry.subject == {:visitor, visitor.id}
      assert entry.network_id == network.id
      assert entry.pid == pid
      assert entry.alive == true
      assert is_integer(entry.mailbox_len) and entry.mailbox_len >= 0
      assert is_integer(entry.memory_bytes) and entry.memory_bytes > 0
      assert is_list(entry.joined_channels)
      assert entry.introspection_degraded == []
    end
  end

  describe "lookup_session/2" do
    test "returns nil for unregistered subject" do
      assert LiveIntrospection.lookup_session({:visitor, Ecto.UUID.generate()}, 1) == nil
    end

    test "returns the SessionEntry for a registered subject" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      assert %SessionEntry{} =
               entry =
               LiveIntrospection.lookup_session({:visitor, visitor.id}, network.id)

      assert entry.subject == {:visitor, visitor.id}
      assert entry.network_id == network.id
      assert entry.pid == pid
      assert entry.alive == true
    end
  end

  describe "upstream peer capture (#550)" do
    test "captures the peer address string + port for a connected session" do
      # #550 netsplit triage — the entry carries the destination the socket
      # landed on. The Client dialed the in-process IRCServer on
      # 127.0.0.1:<port>; USER is sent right after the Client pushes
      # {:irc_peer, _}, so waiting for it guarantees the peer is captured
      # before the registry scan reads it.
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, network} = visitor_with_network(port)
      _ = start_visitor_session_for(visitor, network)
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      :ok = IRCServer.await_handshake(server, 1_000)

      entry = LiveIntrospection.lookup_session({:visitor, visitor.id}, network.id)

      assert entry.peer_address == "127.0.0.1"
      assert entry.peer_port == port
      assert entry.introspection_degraded == []
    end

    test "a non-responsive session pid degrades peer_address to nil + marker" do
      # A registered pid that never answers a GenServer.call (mailbox-bloat /
      # stuck session) → peer_address times out at 250ms → nil + the
      # :peer_address degraded marker: the honest "sick session" signal, never
      # a fabricated or stale address. Same dummy-pid trick as the
      # count_sessions test — no real Session.Server needed.
      subject = {:visitor, Ecto.UUID.generate()}
      network_id = 424_242
      key = {:session, subject, network_id}
      parent = self()

      {:ok, pid} =
        Task.start_link(fn ->
          {:ok, _} = Registry.register(Grappa.SessionRegistry, key, nil)
          send(parent, :registered)
          Process.sleep(:infinity)
        end)

      assert_receive :registered, 500
      on_exit(fn -> if Process.alive?(pid), do: Process.exit(pid, :kill) end)

      entry = LiveIntrospection.lookup_session(subject, network_id)

      assert entry.peer_address == nil
      assert entry.peer_port == nil
      assert :peer_address in entry.introspection_degraded
    end
  end

  describe "count_sessions_by_user/0 (M-6 admin console)" do
    test "returns empty map when registry holds no user sessions" do
      assert LiveIntrospection.count_sessions_by_user() == %{}
    end

    test "counts registered user sessions grouped by user_id, drops visitor rows" do
      # Register dummy pids directly under the user-session registry
      # key shape. We don't need real Session.Servers — the match-spec
      # only inspects the registration key.
      user_a = Ecto.UUID.generate()
      user_b = Ecto.UUID.generate()
      visitor_x = Ecto.UUID.generate()

      keys = [
        {:session, {:user, user_a}, 1},
        {:session, {:user, user_a}, 2},
        {:session, {:user, user_b}, 1},
        {:session, {:visitor, visitor_x}, 1}
      ]

      parent = self()

      registrants =
        for key <- keys do
          {:ok, pid} =
            Task.start_link(fn ->
              {:ok, _} = Registry.register(Grappa.SessionRegistry, key, nil)
              send(parent, {:registered, self()})
              Process.sleep(:infinity)
            end)

          assert_receive {:registered, ^pid}, 500
          pid
        end

      on_exit(fn ->
        Enum.each(registrants, fn pid ->
          if Process.alive?(pid), do: Process.exit(pid, :kill)
        end)
      end)

      counts = LiveIntrospection.count_sessions_by_user()

      assert Map.get(counts, user_a) == 2
      assert Map.get(counts, user_b) == 1
      refute Map.has_key?(counts, visitor_x)
    end
  end
end
