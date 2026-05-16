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

  alias Grappa.{AdmissionStateHelpers, LiveIntrospection, Session}
  alias Grappa.LiveIntrospection.SessionEntry

  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_irc_server do
    {:ok, server} = Grappa.IRCServer.start_link(passthrough_handler())
    {server, Grappa.IRCServer.port(server)}
  end

  describe "list_sessions/0" do
    test "returns empty list when registry is empty" do
      assert LiveIntrospection.list_sessions() == []
    end

    test "returns one entry per live Session.Server with introspection fields" do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

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
      {_, port} = start_irc_server()
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
