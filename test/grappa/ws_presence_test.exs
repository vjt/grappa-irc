defmodule Grappa.WSPresenceTest do
  @moduledoc """
  Unit tests for `Grappa.WSPresence` — per-user WS presence + per-pid
  visibility tracker.

  The module tracks live socket pids per `user_name` AND each pid's
  reported PWA visibility (`:visible | :hidden`). The auto-away FSM in
  `Session.Server` is driven by the `any_visible?/1` transition:
  `:ws_visible` fires when a user goes from no-visible-device to at
  least one; `:ws_all_hidden` fires when the last visible device hides
  or leaves (#182).

  `async: false` because `Grappa.WSPresence` is a singleton GenServer;
  concurrent tests would collide on the single shared state.
  """
  use ExUnit.Case, async: false

  alias Grappa.WSPresence

  # Each test registers a fake "socket pid" — we use `self()` or a
  # spawned stub process so we can simulate socket pid death.

  setup do
    # WSPresence is started in the application supervision tree under test.
    # Reset to clean state between tests via the test-only helper.
    :ok = WSPresence.reset_for_test()
    :ok
  end

  defp stub_pid do
    spawn(fn ->
      receive do
        :stop -> :ok
      end
    end)
  end

  describe "register/2 and ws_count/1" do
    test "registering a socket pid bumps the count" do
      :ok = WSPresence.register("vjt", self())
      assert WSPresence.ws_count("vjt") == 1
    end

    test "registering two different pids for same user gives count 2" do
      other = stub_pid()

      :ok = WSPresence.register("vjt", self())
      :ok = WSPresence.register("vjt", other)
      assert WSPresence.ws_count("vjt") == 2

      send(other, :stop)
    end

    test "registering same pid twice is idempotent (map semantics)" do
      :ok = WSPresence.register("vjt", self())
      :ok = WSPresence.register("vjt", self())
      assert WSPresence.ws_count("vjt") == 1
    end

    test "count is 0 for unknown user" do
      assert WSPresence.ws_count("nobody") == 0
    end
  end

  describe "register defaults to :hidden (deliver-leaning, #182)" do
    test "a freshly-registered socket is NOT visible" do
      :ok = WSPresence.register("vjt", self())
      refute WSPresence.any_visible?("vjt")
    end

    test "register alone does NOT fire :ws_visible (a hidden device can't cancel away)" do
      p = stub_pid()
      :ok = WSPresence.register_with_notify("eve", p, self())
      refute_receive {:ws_visible, "eve"}, 100
      send(p, :stop)
    end
  end

  describe "set_visibility/3 and any_visible?/1" do
    test "any_visible? is false for an unknown user" do
      refute WSPresence.any_visible?("nobody")
    end

    test "marking a tracked pid visible flips any_visible? and fires :ws_visible" do
      :ok = WSPresence.register_with_notify("vjt", self(), self())
      refute WSPresence.any_visible?("vjt")

      :ok = WSPresence.set_visibility("vjt", self(), true)

      assert WSPresence.any_visible?("vjt")
      assert_receive {:ws_visible, "vjt"}, 200
    end

    test "marking the last visible pid hidden flips any_visible? and fires :ws_all_hidden" do
      :ok = WSPresence.register_with_notify("vjt", self(), self())
      :ok = WSPresence.set_visibility("vjt", self(), true)
      assert_receive {:ws_visible, "vjt"}, 200

      :ok = WSPresence.set_visibility("vjt", self(), false)

      refute WSPresence.any_visible?("vjt")
      assert_receive {:ws_all_hidden, "vjt"}, 200
    end

    test "re-marking an already-visible pid visible does NOT re-fire :ws_visible" do
      :ok = WSPresence.register_with_notify("vjt", self(), self())
      :ok = WSPresence.set_visibility("vjt", self(), true)
      assert_receive {:ws_visible, "vjt"}, 200

      :ok = WSPresence.set_visibility("vjt", self(), true)
      refute_receive {:ws_visible, "vjt"}, 100
    end

    test "with two devices, hiding one while the other stays visible does NOT fire :ws_all_hidden" do
      p2 = stub_pid()
      :ok = WSPresence.register_with_notify("vjt", self(), self())
      :ok = WSPresence.register_with_notify("vjt", p2, self())

      :ok = WSPresence.set_visibility("vjt", self(), true)
      assert_receive {:ws_visible, "vjt"}, 200
      :ok = WSPresence.set_visibility("vjt", p2, true)
      # p2 visible while self() already visible — no transition
      refute_receive {:ws_visible, "vjt"}, 100

      :ok = WSPresence.set_visibility("vjt", self(), false)
      # p2 still visible — any_visible? stays true, no all-hidden
      assert WSPresence.any_visible?("vjt")
      refute_receive {:ws_all_hidden, "vjt"}, 100

      send(p2, :stop)
    end

    test "set_visibility on an untracked pid is a no-op (no event, stays hidden)" do
      ghost = stub_pid()
      :ok = WSPresence.register_with_notify("vjt", self(), self())

      :ok = WSPresence.set_visibility("vjt", ghost, true)

      refute WSPresence.any_visible?("vjt")
      refute_receive {:ws_visible, "vjt"}, 100
      send(ghost, :stop)
    end
  end

  describe "read-time staleness downgrade (#318)" do
    # #318 — an iOS PWA backgrounded/closed keeps its WS open but stops
    # sending fresh `visibility` reports (visibilitychange is unreliable on
    # the iOS PWA background lifecycle). A stale `:visible` pid must NOT
    # count as present, so push resumes within @stale_ms instead of only
    # when the zombie socket finally dies (~90 min in the field report).
    # `mark_stale_for_test/2` backdates a pid's last-visible stamp past
    # @stale_ms so we exercise the real staleness comparison without
    # sleeping the whole window.

    test "a :visible pid whose last report is older than @stale_ms is NOT counted present" do
      :ok = WSPresence.register("vjt", self())
      :ok = WSPresence.set_visibility("vjt", self(), true)
      assert WSPresence.any_visible?("vjt")

      :ok = WSPresence.mark_stale_for_test("vjt", self())

      refute WSPresence.any_visible?("vjt")
    end

    test "a fresh re-report bumps a stale pid back to visible" do
      :ok = WSPresence.register("vjt", self())
      :ok = WSPresence.set_visibility("vjt", self(), true)
      :ok = WSPresence.mark_stale_for_test("vjt", self())
      refute WSPresence.any_visible?("vjt")

      # The client foreground heartbeat re-asserts visibility — freshness resets.
      :ok = WSPresence.set_visibility("vjt", self(), true)
      assert WSPresence.any_visible?("vjt")
    end

    test "one stale + one fresh visible pid → any_visible? stays true" do
      fresh = stub_pid()
      :ok = WSPresence.register("vjt", self())
      :ok = WSPresence.register("vjt", fresh)
      :ok = WSPresence.set_visibility("vjt", self(), true)
      :ok = WSPresence.set_visibility("vjt", fresh, true)
      :ok = WSPresence.mark_stale_for_test("vjt", self())

      # self() is stale, `fresh` is not — the user is still genuinely present.
      assert WSPresence.any_visible?("vjt")

      send(fresh, :stop)
    end
  end

  describe "socket pid DOWN handling" do
    test "count decrements when a tracked pid exits" do
      p1 = stub_pid()
      p2 = stub_pid()

      :ok = WSPresence.register("alice", p1)
      :ok = WSPresence.register("alice", p2)
      assert WSPresence.ws_count("alice") == 2

      Process.exit(p1, :kill)
      :timer.sleep(50)

      assert WSPresence.ws_count("alice") == 1

      send(p2, :stop)
    end

    test "a VISIBLE pid dying fires :ws_all_hidden (last visible device gone)" do
      p = stub_pid()
      :ok = WSPresence.register_with_notify("bob", p, self())
      :ok = WSPresence.set_visibility("bob", p, true)
      assert_receive {:ws_visible, "bob"}, 200

      Process.exit(p, :kill)
      :timer.sleep(50)

      assert WSPresence.ws_count("bob") == 0
      refute WSPresence.any_visible?("bob")
      assert_receive {:ws_all_hidden, "bob"}, 200
    end

    test "a HIDDEN pid dying does NOT fire :ws_all_hidden (was never visible)" do
      p = stub_pid()
      :ok = WSPresence.register_with_notify("bob", p, self())
      # p stays hidden (default)

      Process.exit(p, :kill)
      :timer.sleep(50)

      assert WSPresence.ws_count("bob") == 0
      refute_receive {:ws_all_hidden, "bob"}, 100
    end

    test "one of two visible sockets dying does NOT fire :ws_all_hidden" do
      p1 = stub_pid()
      p2 = stub_pid()

      :ok = WSPresence.register_with_notify("carol", p1, self())
      :ok = WSPresence.register_with_notify("carol", p2, self())
      :ok = WSPresence.set_visibility("carol", p1, true)
      :ok = WSPresence.set_visibility("carol", p2, true)
      assert_receive {:ws_visible, "carol"}, 200

      Process.exit(p1, :kill)
      :timer.sleep(50)

      assert WSPresence.ws_count("carol") == 1
      assert WSPresence.any_visible?("carol")
      refute_receive {:ws_all_hidden, "carol"}, 100

      send(p2, :stop)
    end
  end

  describe "client_closing/2 immediate path" do
    test "client_closing on the last VISIBLE socket fires immediate :ws_all_hidden" do
      p = stub_pid()
      :ok = WSPresence.register_with_notify("grace", p, self())
      :ok = WSPresence.set_visibility("grace", p, true)
      assert_receive {:ws_visible, "grace"}, 200

      # pagehide hint — the tab is closing, treat as no-longer-visible now
      :ok = WSPresence.client_closing("grace", p)
      assert_receive {:ws_all_hidden, "grace"}, 200

      # Subsequent real DOWN is idempotent (already hidden → no re-fire)
      Process.exit(p, :kill)
      :timer.sleep(50)
      refute_receive {:ws_all_hidden, "grace"}, 100
    end

    test "client_closing with another VISIBLE socket remaining does NOT fire :ws_all_hidden" do
      p1 = stub_pid()
      p2 = stub_pid()

      :ok = WSPresence.register_with_notify("heidi", p1, self())
      :ok = WSPresence.register_with_notify("heidi", p2, self())
      :ok = WSPresence.set_visibility("heidi", p1, true)
      :ok = WSPresence.set_visibility("heidi", p2, true)
      assert_receive {:ws_visible, "heidi"}, 200

      :ok = WSPresence.client_closing("heidi", p1)
      refute_receive {:ws_all_hidden, "heidi"}, 100

      send(p1, :stop)
      send(p2, :stop)
    end
  end

  describe "reset_for_user/1" do
    test "drops the user_name's entries without touching other users" do
      :ok = WSPresence.reset_for_test()

      vjt_pid = spawn(fn -> Process.sleep(1_000) end)
      admin_pid = spawn(fn -> Process.sleep(1_000) end)
      :ok = WSPresence.register("vjt", vjt_pid)
      :ok = WSPresence.register("admin-vjt", admin_pid)

      assert WSPresence.ws_count("vjt") == 1
      assert WSPresence.ws_count("admin-vjt") == 1

      assert :ok = WSPresence.reset_for_user("vjt")

      assert WSPresence.ws_count("vjt") == 0
      assert WSPresence.ws_count("admin-vjt") == 1

      Process.exit(vjt_pid, :kill)
      Process.exit(admin_pid, :kill)
    end

    test "is idempotent when user_name has no entries" do
      :ok = WSPresence.reset_for_test()
      assert :ok = WSPresence.reset_for_user("ghost-user")
    end
  end
end
