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
  alias Grappa.PubSub.Topic

  @telemetry_handler_id "grappa-admin-events"
  @telemetry_events [
    [:grappa, :admission, :circuit, :open],
    [:grappa, :admission, :circuit, :close],
    [:grappa, :admission, :capacity, :reject]
  ]

  setup do
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
end
