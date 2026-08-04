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

  # #753 — settle on the DOWN having been PROCESSED, never on the clock.
  #
  # `Process.exit/2` is asynchronous, so the monitor `:DOWN` races every call
  # the test makes next. The old shape bet a fixed 50ms on winning that race
  # and then asserted the post-death state; under load the mailbox has not
  # drained in 50ms and the assertion reads the PRE-death value. That is the
  # alone-green / gate-red class #653 spent four slices removing — and with the
  # sleeps cut to 0 SIX of the nine cases in this file fail, which is the same
  # race arriving early rather than a different bug.
  #
  # Two settles, in order of preference:
  #
  #   1. A settle MESSAGE, where one exists. `:ws_all_hidden` is emitted by the
  #      very `handle_info` that processes the `:DOWN`, so receiving it IS the
  #      barrier — assert it FIRST and the follow-up reads are guaranteed to see
  #      the committed state (our call is queued behind that `handle_info`).
  #   2. This helper, where no message is emitted (that being the point of the
  #      case). The count is the observable the `:DOWN` moves; polling it is not
  #      a longer wait but the SAME assertion, made once the state it describes
  #      has arrived, and it still fails with the real value at the deadline.
  @settle_timeout_ms 500
  @settle_poll_ms 5

  defp assert_ws_count(user_name, expected) do
    assert_ws_count(user_name, expected, System.monotonic_time(:millisecond) + @settle_timeout_ms)
  end

  defp assert_ws_count(user_name, expected, deadline) do
    actual = WSPresence.ws_count(user_name)

    cond do
      actual == expected ->
        :ok

      System.monotonic_time(:millisecond) >= deadline ->
        assert actual == expected

      true ->
        :timer.sleep(@settle_poll_ms)
        assert_ws_count(user_name, expected, deadline)
    end
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

      assert_ws_count("alice", 1)

      send(p2, :stop)
    end

    test "a VISIBLE pid dying fires :ws_all_hidden (last visible device gone)" do
      p = stub_pid()
      :ok = WSPresence.register_with_notify("bob", p, self())
      :ok = WSPresence.set_visibility("bob", p, true)
      assert_receive {:ws_visible, "bob"}, 200

      Process.exit(p, :kill)

      # The message comes from the `handle_info` that processes the `:DOWN`, so
      # it is the barrier — the reads below are then guaranteed post-commit.
      assert_receive {:ws_all_hidden, "bob"}, 200
      assert WSPresence.ws_count("bob") == 0
      refute WSPresence.any_visible?("bob")
    end

    test "a HIDDEN pid dying does NOT fire :ws_all_hidden (was never visible)" do
      p = stub_pid()
      :ok = WSPresence.register_with_notify("bob", p, self())
      # p stays hidden (default)

      Process.exit(p, :kill)

      # No message to wait on — its absence is the point — so settle on the
      # count, which is what makes the refute non-vacuous.
      assert_ws_count("bob", 0)
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

      assert_ws_count("carol", 1)
      assert WSPresence.any_visible?("carol")
      refute_receive {:ws_all_hidden, "carol"}, 100

      send(p2, :stop)
    end

    # Visitor names are `"visitor:" <> id`, so the key space is unbounded and
    # every visitor that ever connected used to leave a permanent empty map
    # behind in a `:permanent` GenServer that never restarts.
    test "the user's entry is dropped when its last socket dies, not left empty" do
      p = stub_pid()
      :ok = WSPresence.register("visitor:mallory", p)
      assert Map.has_key?(:sys.get_state(WSPresence).sockets, "visitor:mallory")

      Process.exit(p, :kill)

      # Settle on the count, then probe the map: the pid removal and the
      # entry-drop decision happen in the same `handle_info`, so a count of 0
      # means the choice between "dropped" and "left empty" has been made —
      # which is the distinction this case exists to pin.
      assert_ws_count("visitor:mallory", 0)
      refute Map.has_key?(:sys.get_state(WSPresence).sockets, "visitor:mallory")
    end

    test "a user keeping one socket alive stays tracked" do
      p1 = stub_pid()
      p2 = stub_pid()
      :ok = WSPresence.register("dave", p1)
      :ok = WSPresence.register("dave", p2)

      Process.exit(p1, :kill)

      assert_ws_count("dave", 1)
      assert Map.has_key?(:sys.get_state(WSPresence).sockets, "dave")

      send(p2, :stop)
    end
  end

  describe "#671 — a STALE :visible pid still arms auto-away (every door)" do
    # #671 — read-time staleness (#318) was scoped to push suppression, but
    # `any_visible_in?/2` (fresh) also sat on the `before?` side of every
    # auto-away transition. So a device that stopped heartbeating (phone
    # asleep, JS timers suspended) aged out silently — and when its socket
    # finally died / closed / reported hidden, `before?` was ALREADY false,
    # the `true → false` flip never happened, `:ws_all_hidden` never fired,
    # and auto-away never armed. The transition predicate now reads RAW
    # `:visible` membership (a reported-visible device is still present for
    # auto-away purposes, however stale its push-suppression view). Push
    # suppression (`any_visible?/1`) stays FRESH — the two invariants below.

    test "a STALE :visible pid dying still fires :ws_all_hidden (arms auto-away)" do
      p = stub_pid()
      :ok = WSPresence.register_with_notify("ivan", p, self())
      :ok = WSPresence.set_visibility("ivan", p, true)
      assert_receive {:ws_visible, "ivan"}, 200

      # Device stops reporting; it ages past @stale_ms with no write.
      :ok = WSPresence.mark_stale_for_test("ivan", p)
      # Push-suppression view discounts it immediately (the #318 contract)...
      refute WSPresence.any_visible?("ivan")

      # ...but its DEATH is still the last reported-visible device leaving.
      Process.exit(p, :kill)

      # Message first: it is emitted by the `handle_info` that handles the
      # `:DOWN`, so it proves the transition ran. Asserting the count ahead of
      # it read a state nothing had promised to have reached yet.
      assert_receive {:ws_all_hidden, "ivan"}, 200
      assert WSPresence.ws_count("ivan") == 0
    end

    test "client_closing on a STALE :visible pid still fires :ws_all_hidden" do
      p = stub_pid()
      :ok = WSPresence.register_with_notify("judy", p, self())
      :ok = WSPresence.set_visibility("judy", p, true)
      assert_receive {:ws_visible, "judy"}, 200

      :ok = WSPresence.mark_stale_for_test("judy", p)
      # pagehide arriving after the pid already went stale.
      :ok = WSPresence.client_closing("judy", p)
      assert_receive {:ws_all_hidden, "judy"}, 200

      send(p, :stop)
    end

    test "set_visibility(false) on a STALE :visible pid still fires :ws_all_hidden" do
      p = stub_pid()
      :ok = WSPresence.register_with_notify("kev", p, self())
      :ok = WSPresence.set_visibility("kev", p, true)
      assert_receive {:ws_visible, "kev"}, 200

      :ok = WSPresence.mark_stale_for_test("kev", p)
      # An explicit hidden report after the pid already aged out.
      :ok = WSPresence.set_visibility("kev", p, false)
      assert_receive {:ws_all_hidden, "kev"}, 200

      send(p, :stop)
    end

    test "one STALE + one fresh visible pid: the fresh one dying does NOT fire :ws_all_hidden" do
      # Guard the other direction — the raw predicate must not over-fire.
      # A stale pid is still raw-visible, so the user is still present when a
      # sibling fresh pid dies.
      stale = stub_pid()
      fresh = stub_pid()
      :ok = WSPresence.register_with_notify("lena", stale, self())
      :ok = WSPresence.register_with_notify("lena", fresh, self())
      :ok = WSPresence.set_visibility("lena", stale, true)
      :ok = WSPresence.set_visibility("lena", fresh, true)
      assert_receive {:ws_visible, "lena"}, 200

      :ok = WSPresence.mark_stale_for_test("lena", stale)

      Process.exit(fresh, :kill)
      # Settle on the fresh pid actually being GONE. The old sleep did not make
      # this case flaky — the 100ms refute absorbed it — it made it VACUOUS:
      # a refute that runs before the `:DOWN` is processed passes for the wrong
      # reason. Now the death is a fact before the absence is asserted.
      assert_ws_count("lena", 1)
      # `stale` is still raw-visible — the user has not gone all-hidden.
      refute_receive {:ws_all_hidden, "lena"}, 100

      send(stale, :stop)
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
      assert_ws_count("grace", 0)
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
