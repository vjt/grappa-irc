defmodule Grappa.WSPresenceTest do
  @moduledoc """
  Unit tests for `Grappa.WSPresence` — WS-connection counter per user.

  The module tracks live socket pids per `user_name` and fires auto-away
  notifications to `Session.Server`s when all connections for a user close.

  `async: false` because `Grappa.WSPresence` is a singleton GenServer; concurrent
  tests would collide on the single shared state.
  """
  use ExUnit.Case, async: false

  alias Grappa.WSPresence

  # Each test registers a fake "socket pid" — we use `self()` or a
  # spawned stub process so we can simulate socket pid death.

  setup do
    # WSPresence is started in the application supervision tree under test.
    # Ensure it's running and reset to clean state between tests via a
    # direct GenServer call that we expose for test use.
    :ok = WSPresence.reset_for_test()
    :ok
  end

  describe "register/2 and ws_count/1" do
    test "registering a socket pid bumps the count" do
      pid = self()
      :ok = WSPresence.register("vjt", pid)
      assert WSPresence.ws_count("vjt") == 1
    end

    test "registering two different pids for same user gives count 2" do
      # Simulate two tabs: spawn a process, keep self()
      other =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      :ok = WSPresence.register("vjt", self())
      :ok = WSPresence.register("vjt", other)
      assert WSPresence.ws_count("vjt") == 2

      # Cleanup spawned process
      send(other, :stop)
    end

    test "registering same pid twice is idempotent (MapSet semantics)" do
      :ok = WSPresence.register("vjt", self())
      :ok = WSPresence.register("vjt", self())
      # MapSet deduplicates — count stays 1
      assert WSPresence.ws_count("vjt") == 1
    end

    test "count is 0 for unknown user" do
      assert WSPresence.ws_count("nobody") == 0
    end
  end

  describe "socket pid DOWN handling" do
    test "count decrements when a tracked pid exits" do
      # Spawn two processes: we'll kill one
      p1 =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      p2 =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      :ok = WSPresence.register("alice", p1)
      :ok = WSPresence.register("alice", p2)
      assert WSPresence.ws_count("alice") == 2

      # Kill p1 — WSPresence monitors it and handles the DOWN
      Process.exit(p1, :kill)
      # Give WSPresence time to process the DOWN message
      :timer.sleep(50)

      assert WSPresence.ws_count("alice") == 1

      send(p2, :stop)
    end

    test "closing last socket sends ws_all_disconnected notification to test receiver" do
      # Register THIS test process as the notification target via
      # the notify_pid option in register/3.
      p =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      :ok = WSPresence.register_with_notify("bob", p, self())

      # Kill the only socket
      Process.exit(p, :kill)
      :timer.sleep(50)

      assert WSPresence.ws_count("bob") == 0
      assert_receive {:ws_all_disconnected, "bob"}, 200
    end

    test "closing one of two sockets does NOT send ws_all_disconnected" do
      p1 =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      p2 =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      :ok = WSPresence.register_with_notify("carol", p1, self())
      :ok = WSPresence.register_with_notify("carol", p2, self())

      # Kill p1 — p2 is still up
      Process.exit(p1, :kill)
      :timer.sleep(50)

      assert WSPresence.ws_count("carol") == 1
      # No all-disconnected notification
      refute_receive {:ws_all_disconnected, "carol"}, 100

      send(p2, :stop)
    end
  end

  describe "ws_connected notification on re-register" do
    test "registering a socket for a user with zero count sends ws_connected" do
      :ok = WSPresence.register_with_notify("eve", self(), self())
      assert_receive {:ws_connected, "eve"}, 200
    end

    test "registering a second socket does NOT send ws_connected again" do
      p =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      :ok = WSPresence.register_with_notify("frank", p, self())
      # Consume the first ws_connected
      assert_receive {:ws_connected, "frank"}, 200

      # Register second — no second notification expected
      :ok = WSPresence.register_with_notify("frank", self(), self())
      refute_receive {:ws_connected, "frank"}, 100

      send(p, :stop)
    end
  end

  describe "client_closing/2 immediate path" do
    test "client_closing with last socket sends immediate ws_all_disconnected" do
      p =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      :ok = WSPresence.register_with_notify("grace", p, self())
      # Consume the ws_connected
      assert_receive {:ws_connected, "grace"}, 200

      # Signal immediate close — this is the pagehide path
      :ok = WSPresence.client_closing("grace", p)

      # Should receive ws_all_disconnected immediately (no debounce)
      assert_receive {:ws_all_disconnected, "grace"}, 200

      # Subsequent real DOWN from the dying socket is idempotent
      Process.exit(p, :kill)
      :timer.sleep(50)
      refute_receive {:ws_all_disconnected, "grace"}, 100
    end

    test "client_closing with other sockets remaining does NOT fire all-disconnected" do
      p1 =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      p2 =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      :ok = WSPresence.register_with_notify("heidi", p1, self())
      :ok = WSPresence.register_with_notify("heidi", p2, self())
      assert_receive {:ws_connected, "heidi"}, 200

      # Only p1 is closing — p2 still alive
      :ok = WSPresence.client_closing("heidi", p1)
      refute_receive {:ws_all_disconnected, "heidi"}, 100

      send(p1, :stop)
      send(p2, :stop)
    end
  end
end
