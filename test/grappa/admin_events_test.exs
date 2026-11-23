defmodule Grappa.AdminEventsTest do
  @moduledoc """
  Singleton GenServer tests for `Grappa.AdminEvents`. `async: false`
  because the process is registered as `__MODULE__` and the ring
  buffer is shared across the suite (CP25 max_cases: 1 singleton
  invariant).

  Each test resets the buffer state via the test-only `reset/0`
  helper introduced below — production code path is record/1 +
  telemetry, no reset.
  """
  use Grappa.DataCase, async: false

  alias Grappa.{AdminEvents, AdmissionStateHelpers, Repo, Session}
  alias Grappa.AdminEvents.{Event, Wire}
  alias Grappa.Networks.Network
  alias Grappa.PubSub.Topic

  @telemetry_handler_id "grappa-admin-events"
  @telemetry_events [
    [:grappa, :admission, :circuit, :open],
    [:grappa, :admission, :circuit, :close],
    [:grappa, :admission, :capacity, :reject],
    [:grappa, :session, :lifecycle, :spawned],
    [:grappa, :session, :lifecycle, :terminated]
  ]

  setup context do
    # #1546 — registered FIRST so ExUnit's reverse-registration (LIFO)
    # order runs it LAST: it reads the state the restore below left
    # behind. Registering it any later would observe the singleton
    # BEFORE the restore and prove nothing.
    maybe_watch_for_escaping_dirt(context)

    # Drain stale `Session.registry_key/2` entries left by prior tests.
    # `AdmissionStateHelpers.reset_session_supervisor/0` is the canonical
    # purge — it walks `DynamicSupervisor.which_children/1` and calls
    # `terminate_child/2` (atomic: removes the child AND prevents
    # restart, so `:transient` workers in a `:connect_failed` respawn
    # loop are killed for good), then sweeps the Registry for any
    # leaked pids (`GenServer.stop/3` with a 2s budget per pid),
    # then polls until `Registry.count` reaches 0 (15s budget).
    #
    # Pre-fix this setup re-implemented the drain inline via
    # `Registry.select` + `Session.stop_session/2` — but that walks
    # the Registry, which can race the DynamicSupervisor's restart of
    # a `:transient` worker whose Client just crashed on
    # `:tcp_closed` (window between `whereis → nil` and the new pid
    # registering itself). The canonical helper goes through the
    # supervisor directly, sidestepping the race entirely.
    #
    # The other half of this fix is `AuthFixtures.start_session_for/2`
    # + `start_visitor_session_for/2` now register an `on_exit`
    # callback that calls `DynamicSupervisor.terminate_child/2` for
    # the spawned pid — that prevents the leak at the source so
    # this setup-time drain is empty in the steady-state case.
    AdmissionStateHelpers.reset_session_supervisor()

    # AdminEvents is started by Grappa.Application and outlives every
    # sandbox checkout, so the ring goes back to a booted struct per test.
    AdmissionStateHelpers.reset_admin_events()

    # #1546 — and back to a booted struct AFTERWARDS too. This file is
    # the only writer of the singleton's `persist` / `retention` in all
    # of `test/`, so this one registration is what makes the dirt
    # unable to reach any other file. As an `on_exit` it is off the
    # happy path: a test that fails before its own inline restore
    # (two such windows were censused on #1546) still leaves the
    # singleton clean. Cleanup belongs in `on_exit`, never in a test
    # body — same shape as `session_log_persistence_test.exs:90`.
    on_exit(&AdmissionStateHelpers.reset_admin_events/0)

    # M-11: AdminEvents boots with `attach_telemetry: false` under
    # `config :grappa, :attach_admin_telemetry, false` in test env
    # (see `config/test.exs` rationale). Telemetry-adapter tests
    # explicitly attach + allow the sandbox so the GenServer's
    # `Wire.lookup_slug/1` Repo call can complete.
    :ok =
      :telemetry.attach_many(
        @telemetry_handler_id,
        @telemetry_events,
        &AdminEvents.handle_telemetry/4,
        nil
      )

    Ecto.Adapters.SQL.Sandbox.allow(Repo, self(), Process.whereis(AdminEvents))

    on_exit(fn -> :telemetry.detach(@telemetry_handler_id) end)

    :ok
  end

  # #1546 — the leak witness. Only armed for `@tag :dirt_probe`, so one
  # mutant (dropping the restore) kills exactly one assertion instead of
  # reddening every test in the file.
  #
  # A `raise` inside an `on_exit` callback reddens the test it belongs
  # to (ExUnit.OnExitHandler.exec_callback/1) — that is the observation
  # point, and the stacktrace names it.
  defp maybe_watch_for_escaping_dirt(context) do
    if context[:dirt_probe], do: on_exit(&refute_escaping_dirt/0)

    :ok
  end

  defp refute_escaping_dirt do
    defaults = %AdminEvents{}
    left = :sys.get_state(AdminEvents)

    if {left.persist, left.retention} != {defaults.persist, defaults.retention} do
      raise "AdminEvents config dirt escaped the test: " <>
              "persist=#{inspect(left.persist)} retention=#{inspect(left.retention)} " <>
              "(defaults persist=#{inspect(defaults.persist)} " <>
              "retention=#{inspect(defaults.retention)})"
    end

    :ok
  end

  describe "record/1 + snapshot/0" do
    test "broadcasts on Topic.admin_events/0 + prepends to buffer" do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      event = Wire.reaper_swept(3)
      :ok = AdminEvents.record(event)

      assert_receive %Phoenix.Socket.Broadcast{
        topic: "grappa:admin:events",
        event: "event",
        payload: %{kind: :reaper_swept, count: 3}
      }

      assert [%{kind: :reaper_swept, count: 3}] = AdminEvents.snapshot()
    end

    test "newest event is first in the buffer" do
      :ok = AdminEvents.record(Wire.reaper_swept(1))
      :ok = AdminEvents.record(Wire.reaper_swept(2))
      :ok = AdminEvents.record(Wire.reaper_swept(3))

      # Force mailbox drain.
      _ = AdminEvents.snapshot()

      assert [%{count: 3}, %{count: 2}, %{count: 1}] = AdminEvents.snapshot()
    end

    test "buffer is capped at 200 events" do
      Enum.each(1..205, fn n -> AdminEvents.record(Wire.reaper_swept(n)) end)
      _ = AdminEvents.snapshot()

      snapshot = AdminEvents.snapshot()
      assert length(snapshot) == 200
      # Newest preserved, oldest evicted.
      assert hd(snapshot).count == 205
      assert List.last(snapshot).count == 6
    end
  end

  describe "the per-test singleton reset (#1397 bucket H characterization)" do
    # Seven test files open `setup` with the same byte-identical line:
    #
    #     :sys.replace_state(AdminEvents, fn _ -> %AdminEvents{buffer: []} end)
    #
    # It reads as "empty the ring", but it REBUILDS the struct, so it also
    # returns `persist` and `retention` to their `defstruct` defaults
    # whatever they were. That clobber is the part a shared helper must
    # preserve, and the part nothing asserted before this test.
    test "rebuilds the struct whole: buffer emptied AND persist/retention back to defaults" do
      defaults = %AdminEvents{}

      :ok = AdminEvents.record(Wire.reaper_swept(1))
      _ = AdminEvents.snapshot()

      :sys.replace_state(AdminEvents, fn s ->
        %{s | persist: not defaults.persist, retention: defaults.retention + 1}
      end)

      # Assert the pre-state, or the post-state assertions below pass
      # against a singleton that was already at the defaults.
      pre = :sys.get_state(AdminEvents)
      assert pre.buffer != []
      assert pre.persist != defaults.persist
      assert pre.retention != defaults.retention

      :sys.replace_state(AdminEvents, fn _ -> %AdminEvents{buffer: []} end)

      post = :sys.get_state(AdminEvents)
      assert post.buffer == []
      assert post.persist == defaults.persist
      assert post.retention == defaults.retention
    end

    test "reset_admin_events/0 lands the state the inline gesture landed" do
      defaults = %AdminEvents{}

      dirty = fn ->
        :ok = AdminEvents.record(Wire.reaper_swept(1))
        _ = AdminEvents.snapshot()

        :sys.replace_state(AdminEvents, fn s ->
          %{s | persist: not defaults.persist, retention: defaults.retention + 1}
        end)
      end

      dirty.()
      :sys.replace_state(AdminEvents, fn _ -> %AdminEvents{buffer: []} end)
      inline = :sys.get_state(AdminEvents)

      # Re-dirty, or the comparison below is between two clean states and
      # would hold for a helper that did nothing at all.
      dirty.()
      assert :sys.get_state(AdminEvents) != inline

      AdmissionStateHelpers.reset_admin_events()
      assert :sys.get_state(AdminEvents) == inline
    end
  end

  describe "config dirt cannot outlive the test that made it (#1546)" do
    # `Grappa.AdminEvents` is a singleton started by `Grappa.Application`;
    # it outlives every sandbox checkout, so `persist` / `retention`
    # written by one test are still there for the next FILE unless
    # something puts them back. This file is the only place in `test/`
    # that writes them (pinned by `AdminEventsDirtSourcesTest`).
    #
    # Before #1546 the restores were straight-line statements in the test
    # bodies, so a failing assertion ABOVE one skipped it. Two such
    # windows were censused. `persist: true` escaping makes the singleton
    # write to the Repo from its own pid, which is not `Sandbox.allow`ed
    # outside this file — the singleton then dies inside an unrelated
    # file's setup, which is a cascade with no relation to the real
    # failure.
    #
    # The cure is that the restore is an `on_exit`, registered in setup,
    # so it is off the happy path entirely: it runs on pass, on failure
    # and on raise alike. This test IS the failing-assert path minus the
    # failure — it dirties and deliberately never restores.
    @tag :dirt_probe
    test "a test that dirties persist/retention and never restores leaves the singleton clean" do
      defaults = %AdminEvents{}

      :sys.replace_state(AdminEvents, fn s ->
        %{s | persist: not defaults.persist, retention: defaults.retention + 1}
      end)

      # Assert the pre-state, or the watcher's verdict is about a
      # singleton that was never dirtied in the first place.
      dirty = :sys.get_state(AdminEvents)
      assert dirty.persist != defaults.persist
      assert dirty.retention != defaults.retention

      # NO inline restore. The verdict is `maybe_watch_for_escaping_dirt/1`'s
      # `on_exit`, which runs after this body returns.
    end
  end

  describe "disk-backing (#215 Option B)" do
    # The singleton boots persist:false in test env (config); flip it on +
    # rely on the setup's Sandbox.allow so the pid's Repo writes land in
    # this test's transaction. Restore on exit so other suites see the
    # in-memory-only steady state.
    setup do
      Repo.delete_all(Event)
      :sys.replace_state(AdminEvents, fn s -> %{s | persist: true, retention: 200} end)

      # #1546 — no restore here. The file-wide `on_exit` in the outer
      # setup lands the identical state (`%AdminEvents{buffer: []}` IS
      # `persist: false, retention: 200, buffer: []`), and one restore
      # for one invariant is the point of the fix: a second copy is the
      # duplication that drifts.
      :ok
    end

    test "record persists the event to admin_events" do
      :ok = AdminEvents.record(Wire.reaper_swept(5))
      _ = AdminEvents.snapshot()

      assert [row] = Repo.all(Event)
      assert row.kind == "reaper_swept"
      assert row.payload["count"] == 5
    end

    test "load_recent/1 returns persisted events newest-first (survives restart)" do
      :ok = AdminEvents.record(Wire.reaper_swept(1))
      :ok = AdminEvents.record(Wire.reaper_swept(2))
      _ = AdminEvents.snapshot()

      # Reload path init/1 runs on boot; the decoded (string-keyed) JSON
      # round-trip is byte-identical over the wire to a fresh event.
      assert [%{"kind" => "reaper_swept", "count" => 2}, %{"kind" => "reaper_swept", "count" => 1}] =
               AdminEvents.load_recent(10)
    end

    test "prune keeps only the newest `retention` rows on disk" do
      :sys.replace_state(AdminEvents, fn s -> %{s | retention: 2} end)
      for n <- 1..4, do: AdminEvents.record(Wire.reaper_swept(n))
      _ = AdminEvents.snapshot()

      assert Repo.aggregate(Event, :count) == 2
    end
  end

  describe "telemetry adapter" do
    test "translates [:grappa, :admission, :circuit, :open] → :circuit_open event" do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      :telemetry.execute(
        [:grappa, :admission, :circuit, :open],
        %{},
        %{network_id: 9999, threshold: 3, cooldown_ms: 60_000}
      )

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :circuit_open, network_id: 9999, threshold: 3}
                     },
                     500
    end

    test "skips :circuit, :close :operator_reset (synthetic-only path)" do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      :telemetry.execute(
        [:grappa, :admission, :circuit, :close],
        %{},
        %{network_id: 9999, reason: :operator_reset}
      )

      # The :operator_reset path is intentionally :skip — operator-driven
      # reset emits a synthetic :circuit_reset event via record/1 with
      # actor attribution. Telemetry-side :operator_reset must NOT
      # double-emit.
      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :circuit_close}}, 200

      _ = AdminEvents.snapshot()
      assert [] == AdminEvents.snapshot()
    end

    test "translates :capacity, :reject" do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      :telemetry.execute(
        [:grappa, :admission, :capacity, :reject],
        %{},
        %{flow: :visitor, error: :network_cap_exceeded, network_id: 9999, source_ip: "203.0.113.5"}
      )

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :capacity_reject, flow: :visitor, source_ip: "203.0.113.5"}
                     },
                     500
    end
  end

  describe "session-lifecycle adapter (U-5)" do
    setup do
      Ecto.Adapters.SQL.Sandbox.allow(Repo, self(), Process.whereis(AdminEvents))

      {:ok, net} =
        Repo.insert(%Network{
          slug: "u5-net-#{System.unique_integer([:positive])}",
          max_concurrent_visitor_sessions: 3,
          max_concurrent_user_sessions: 5,
          inserted_at: DateTime.utc_now(),
          updated_at: DateTime.utc_now()
        })

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())
      %{network: net}
    end

    test ":spawned synthesizes :cap_counts_changed with post-transition counts + caps",
         %{network: net} do
      # Two live visitor sessions + one live user session on this network.
      register_fake_session({:visitor, "v1"}, net.id)
      register_fake_session({:visitor, "v2"}, net.id)
      register_fake_session({:user, "u1"}, net.id)

      :telemetry.execute(
        [:grappa, :session, :lifecycle, :spawned],
        %{},
        %{network_id: net.id, subject_kind: :visitor}
      )

      # Pin network_id: the admin_events topic is shared across the suite,
      # and a Session.Server elsewhere terminating mid-test would bleed
      # into this mailbox via the same broadcast. Pinning isolates this
      # test's network row from sibling-suite noise.
      net_id = net.id

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{
                         kind: :cap_counts_changed,
                         network_id: ^net_id,
                         network_slug: slug,
                         visitors: 2,
                         users: 1,
                         max_concurrent_visitor_sessions: 3,
                         max_concurrent_user_sessions: 5
                       }
                     },
                     500

      assert slug == net.slug
    end

    test ":terminated subtracts self from its subject_kind bucket",
         %{network: net} do
      # The dying pid is still registered when terminate fires.
      register_fake_session({:visitor, "v1"}, net.id)
      register_fake_session({:user, "u1"}, net.id)

      # Simulate user session terminating: Registry still reports 1 user,
      # but the wire MUST surface 0 users (subtract self).
      :telemetry.execute(
        [:grappa, :session, :lifecycle, :terminated],
        %{},
        %{network_id: net.id, subject_kind: :user}
      )

      net_id = net.id

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{
                         kind: :cap_counts_changed,
                         network_id: ^net_id,
                         visitors: 1,
                         users: 0
                       }
                     },
                     500
    end

    test "skips broadcast entirely when network row was deleted between lifecycle + lookup (S2 of U-5 review)" do
      ghost_id = 9_999_999
      register_fake_session({:visitor, "v1"}, ghost_id)

      :telemetry.execute(
        [:grappa, :session, :lifecycle, :spawned],
        %{},
        %{network_id: ghost_id, subject_kind: :visitor}
      )

      # Phantom event would lie about caps (collapse to nil/∞). The
      # admission row is gone; the next /admin/networks fetch drops the
      # row entirely. No broadcast is the honest signal.
      #
      # Pin ghost_id so unrelated suite-wide lifecycle events on other
      # networks don't trip the refute.
      refute_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :cap_counts_changed, network_id: ^ghost_id}
                     },
                     200
    end

    test "broadcasts but does NOT enter the snapshot ring buffer", %{network: net} do
      register_fake_session({:visitor, "v1"}, net.id)

      :telemetry.execute(
        [:grappa, :session, :lifecycle, :spawned],
        %{},
        %{network_id: net.id, subject_kind: :visitor}
      )

      net_id = net.id

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :cap_counts_changed, network_id: ^net_id}
                     },
                     500

      # Drain mailbox via call. cap_counts_changed is broadcast-only —
      # the audit ring would saturate on session lifecycle churn; cic
      # consumes the live projection via a separate signal.
      _ = AdminEvents.snapshot()
      assert [] = AdminEvents.snapshot()
    end
  end

  # Register a fake-session key under the current test pid for
  # Admission.live_counts_for_network/1 to observe; auto-unregister
  # on test exit so sibling tests see a clean registry.
  defp register_fake_session(subject, network_id) do
    key = Session.registry_key(subject, network_id)
    {:ok, _} = Registry.register(Grappa.SessionRegistry, key, nil)
    on_exit(fn -> _ = Registry.unregister(Grappa.SessionRegistry, key) end)
  end
end
