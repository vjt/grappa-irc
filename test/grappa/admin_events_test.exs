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

  alias Grappa.{AdminEvents, Repo}
  alias Grappa.AdminEvents.Wire
  alias Grappa.Networks.Network
  alias Grappa.PubSub.Topic
  alias Grappa.Session.Server, as: SessionServer

  @telemetry_handler_id "grappa-admin-events"
  @telemetry_events [
    [:grappa, :admission, :circuit, :open],
    [:grappa, :admission, :circuit, :close],
    [:grappa, :admission, :capacity, :reject],
    [:grappa, :session, :lifecycle, :spawned],
    [:grappa, :session, :lifecycle, :terminated]
  ]

  setup do
    # Drain stale `{:session, _, _}` entries from prior tests' fake
    # registrations. `register_fake_session/2` registers under the
    # test pid; on test exit, Registry cleans entries via monitor-DOWN
    # which is ASYNC. Next test's Network row gets `id = 1` again
    # (sandbox transactional rollback), so prior-test stale entries
    # on network_id=1 inflate `live_counts_for_network/1` and
    # `:cap_counts_changed` broadcasts assert wrong counts. `on_exit`
    # cannot help: `Registry.unregister/2` only unregisters the
    # CALLER's entries, and on_exit runs in a fresh pid. Drain at
    # setup makes each test self-defending.
    wait_for_empty_session_registry!()

    # AdminEvents is started by Grappa.Application; clear buffer state
    # per-test by record-then-snapshot-then-drop. Since record/1 is a
    # cast, drain via call/2 to force serialization.
    :sys.replace_state(AdminEvents, fn _ -> %AdminEvents{buffer: []} end)

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
        %{flow: :visitor, error: :network_cap_exceeded, network_id: 9999, client_id: "abc"}
      )

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :capacity_reject, flow: :visitor, client_id: "abc"}
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
    key = SessionServer.registry_key(subject, network_id)
    {:ok, _} = Registry.register(Grappa.SessionRegistry, key, nil)
    on_exit(fn -> _ = Registry.unregister(Grappa.SessionRegistry, key) end)
  end

  # Setup-time drain. Registry-monitor-DOWN cleanup of dead test pids
  # is asynchronous; without this, sibling-test stale entries on the
  # same auto-incremented `network_id` survive into the next test and
  # inflate `live_counts_for_network/1`. Poll the match-spec used by
  # admission until empty; bounded so a true hang surfaces as a clear
  # test crash instead of a timeout deep inside `assert_receive`.
  #
  # GREEN-CI batch 2 (2026-05-23): bumped budget from 50×10ms (500ms)
  # to 200×10ms (2s). CI runner under load consistently shows 4 stale
  # entries surviving the original 500ms window — the issue is genuine
  # cleanup latency (Registry monitor-DOWN ASYNC cleanup of dead pids
  # under CI ETS contention), not a bug. 2s is still tight enough that
  # a true hang surfaces clearly.
  defp wait_for_empty_session_registry!, do: wait_for_empty_session_registry!(200)

  defp wait_for_empty_session_registry!(0) do
    leftover =
      Registry.select(Grappa.SessionRegistry, [
        {{{:session, :_, :_}, :_, :_}, [], [{{:"$_"}}]}
      ])

    flunk("SessionRegistry never drained — stale entries: #{inspect(leftover)}")
  end

  defp wait_for_empty_session_registry!(remaining) do
    case Registry.count_select(Grappa.SessionRegistry, [
           {{{:session, :_, :_}, :_, :_}, [], [true]}
         ]) do
      0 ->
        :ok

      _ ->
        Process.sleep(10)
        wait_for_empty_session_registry!(remaining - 1)
    end
  end
end
