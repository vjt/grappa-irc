defmodule Grappa.DbLatencyTest do
  @moduledoc """
  Singleton GenServer tests for `Grappa.DbLatency` (#357 — SQLite
  write-latency diagnostics + the broader repo query-latency profile).

  `async: false` because the process is registered as `__MODULE__` and
  the aggregate is shared across the suite (CP25 max_cases: 1 singleton
  invariant). No `Grappa.DataCase` / sandbox: the handler does zero Repo
  access — it only folds telemetry measurements into in-memory counters.

  The singleton boots with `attach_telemetry: false` under test
  (`config/test.exs`), so the aggregation describe attaches the handler
  explicitly (mirror of `Grappa.AdminEventsTest`) and drains state via
  the production `reset/0` between tests.
  """
  use ExUnit.Case, async: false

  alias Grappa.DbLatency

  @handler_id "grappa-db-latency"

  # 🔴 An INDEPENDENT copy of the production set, on purpose, and the
  # `attached_events/0` equality assertion below is what keeps it from
  # rotting. Deriving it from `DbLatency.attached_events/0` would make the
  # boot-wiring test tautological; leaving it underived and UNCHECKED is what
  # broke while #1901 was being built — a new emitter reached a new `fold/4`
  # clause, the suite stayed green, and the ring was silently empty because
  # this list never learned about the event.
  @events [
    [:grappa, :repo, :query],
    [:grappa, :scrollback, :persist, :stop],
    [:grappa, :session, :send_privmsg, :stop],
    [:grappa, :scrollback, :persist, :contention],
    [:grappa, :repo, :lock_stall, :detected],
    [:grappa, :repo, :lock_stall, :resolved],
    [:grappa, :repo, :lock_stall, :unattributed],
    [:grappa, :repo, :lock_stall, :nif_census]
  ]

  # Native-unit duration for a whole number of milliseconds, via the
  # production conversion (never hardcode the native tick rate).
  defp ms(n), do: System.convert_time_unit(n, :millisecond, :native)

  defp query_row(snapshot, source, op) do
    Enum.find(snapshot.queries, fn r -> r.source == source and r.op == op end)
  end

  setup do
    DbLatency.reset()
    :ok
  end

  describe "reset/0" do
    test "returns an empty aggregate before anything is recorded" do
      snapshot = DbLatency.snapshot()

      assert snapshot.queries == []
      assert snapshot.send_privmsg.n == 0
      assert snapshot.persist.n == 0
      assert snapshot.contention.n == 0
      assert snapshot.lock_stalls == []
    end
  end

  describe "aggregation via telemetry" do
    setup do
      :ok =
        :telemetry.attach_many(
          @handler_id,
          @events,
          &DbLatency.handle_telemetry/4,
          nil
        )

      on_exit(fn -> :telemetry.detach(@handler_id) end)
      :ok
    end

    test "[:grappa, :repo, :query] folds into a {source, op} bucket" do
      :telemetry.execute(
        [:grappa, :repo, :query],
        %{total_time: ms(10), queue_time: ms(2)},
        %{source: "messages", query: ~s|SELECT m0."id" FROM "messages" AS m0|}
      )

      # snapshot/0 is a call — drains the preceding cast.
      row = query_row(DbLatency.snapshot(), "messages", :select)

      assert row.n == 1
      assert_in_delta row.total_ms, 10.0, 0.5
      assert_in_delta row.queue_ms, 2.0, 0.5
      assert_in_delta row.mean_ms, 10.0, 0.5
    end

    test "SELECT count(...) is classified as :count, distinct from :select" do
      :telemetry.execute(
        [:grappa, :repo, :query],
        %{total_time: ms(30), queue_time: ms(0)},
        %{source: "messages", query: ~s|SELECT count(m0."id") FROM "messages" AS m0|}
      )

      :telemetry.execute(
        [:grappa, :repo, :query],
        %{total_time: ms(5), queue_time: ms(0)},
        %{source: "messages", query: ~s|SELECT m0."id" FROM "messages" AS m0|}
      )

      snapshot = DbLatency.snapshot()

      assert query_row(snapshot, "messages", :count).n == 1
      assert query_row(snapshot, "messages", :select).n == 1
      assert_in_delta query_row(snapshot, "messages", :count).total_ms, 30.0, 0.5
    end

    test "INSERT classified as :insert; repeated inserts accumulate n + mean" do
      for _ <- 1..3 do
        :telemetry.execute(
          [:grappa, :repo, :query],
          %{total_time: ms(6), queue_time: ms(1)},
          %{source: "messages", query: ~s|INSERT INTO "messages" ("body") VALUES (?)|}
        )
      end

      row = query_row(DbLatency.snapshot(), "messages", :insert)

      assert row.n == 3
      assert_in_delta row.total_ms, 18.0, 1.0
      assert_in_delta row.mean_ms, 6.0, 0.5
    end

    test "queries are returned sorted by total_ms descending" do
      :telemetry.execute(
        [:grappa, :repo, :query],
        %{total_time: ms(5)},
        %{source: "read_cursors", query: "SELECT 1"}
      )

      :telemetry.execute(
        [:grappa, :repo, :query],
        %{total_time: ms(50)},
        %{source: "messages", query: "SELECT 1"}
      )

      assert [%{source: "messages"} | _] = DbLatency.snapshot().queries
    end

    test "[:grappa, :scrollback, :persist, :stop] folds into the persist row with outcome counts" do
      :telemetry.execute(
        [:grappa, :scrollback, :persist, :stop],
        %{duration: ms(8)},
        %{channel: "#test", kind: :privmsg, outcome: :ok}
      )

      :telemetry.execute(
        [:grappa, :scrollback, :persist, :stop],
        %{duration: ms(4)},
        %{channel: "#test", kind: :privmsg, outcome: :unavailable}
      )

      persist = DbLatency.snapshot().persist

      assert persist.n == 2
      assert_in_delta persist.total_ms, 12.0, 1.0
      assert persist.outcomes[:ok] == 1
      assert persist.outcomes[:unavailable] == 1
    end

    test "[:grappa, :session, :send_privmsg, :stop] folds into the send row" do
      :telemetry.execute(
        [:grappa, :session, :send_privmsg, :stop],
        %{duration: ms(20)},
        %{network_id: 1, target: "#test", outcome: :ok}
      )

      send_row = DbLatency.snapshot().send_privmsg

      assert send_row.n == 1
      assert_in_delta send_row.total_ms, 20.0, 1.0
      assert send_row.outcomes[:ok] == 1
    end

    test "[:grappa, :scrollback, :persist, :contention] folds into the contention row by fault + dropped" do
      :telemetry.execute(
        [:grappa, :scrollback, :persist, :contention],
        %{attempt: 1},
        %{fault: :busy_locked, dropped: false}
      )

      :telemetry.execute(
        [:grappa, :scrollback, :persist, :contention],
        %{attempt: 2},
        %{fault: :queue_timeout, dropped: true}
      )

      contention = DbLatency.snapshot().contention

      assert contention.n == 2
      assert contention.busy_locked == 1
      assert contention.queue_timeout == 1
      assert contention.dropped == 1
    end

    test "[:grappa, :repo, :lock_stall, :*] folds both brackets of an episode, newest first" do
      :telemetry.execute(
        [:grappa, :repo, :lock_stall, :detected],
        %{held_ms: 2_400, waiter_count: 2},
        %{
          observed_at: "2026-09-01T10:06:57.328000Z",
          holder: %{pid: "#PID<0.111.0>", stacktrace: ["Foo.bar/1"]},
          waiters: [%{pid: "#PID<0.222.0>"}, %{pid: "#PID<0.333.0>"}]
        }
      )

      :telemetry.execute(
        [:grappa, :repo, :lock_stall, :resolved],
        %{held_ms: 30_120},
        %{
          observed_at: "2026-09-01T10:07:28.554000Z",
          holder_pid: "#PID<0.111.0>",
          announced: true,
          caller: %{
            pid: "#PID<0.111.0>",
            initial_call: "Grappa.Session.Server.init/1",
            stacktrace: ["Grappa.Repo.immediate_transaction/1"]
          }
        }
      )

      assert [resolved, detected] = DbLatency.snapshot().lock_stalls

      # Newest first: an operator reading a live incident wants the last
      # thing that happened at the top, not to scroll a boot-long history.
      assert resolved.phase == :resolved
      assert resolved.held_ms == 30_120
      assert resolved.holder == nil

      # #1888 — `holder` stays nil (a `sample()` means "sampled while it
      # stalled", and by release there is no pause site left to sample) while
      # `caller` carries the write path that held the lock. Two different
      # facts, two different keys: folding them would let a release-time stack
      # be read as the frame the holder paused in.
      assert resolved.caller.initial_call == "Grappa.Session.Server.init/1"
      assert resolved.announced == true

      # `waiter_count` is nil, not 0: nothing in a closing bracket counted a
      # queue, and a 0 would assert an empty one was measured.
      assert resolved.waiter_count == nil

      assert detected.phase == :detected
      assert detected.waiter_count == 2
      assert detected.holder.stacktrace == ["Foo.bar/1"]
      assert length(detected.waiters) == 2

      # The instant, on both edges: a ring row that cannot be aligned with
      # `erlang.log` cannot be matched to the freeze it belongs to.
      assert resolved.observed_at == "2026-09-01T10:07:28.554000Z"
      assert detected.observed_at == "2026-09-01T10:06:57.328000Z"
    end

    test "[:grappa, :repo, :lock_stall, :unattributed] folds with an explicit nil where the holder would be" do
      :telemetry.execute(
        [:grappa, :repo, :lock_stall, :unattributed],
        %{waiter_count: 3, longest_wait_ms: 31_303},
        %{
          observed_at: "2026-09-01T10:07:28.554000Z",
          holders_registered: 0,
          waiters: [
            %{pid: "#PID<0.222.0>", elapsed_ms: 31_303, stacktrace: ["Exqlite.Sqlite3NIF.step/2"]},
            %{pid: "#PID<0.333.0>", elapsed_ms: 2_100},
            %{pid: "#PID<0.444.0>", elapsed_ms: 2_050}
          ]
        }
      )

      assert [row] = DbLatency.snapshot().lock_stalls

      assert row.phase == :unattributed
      assert row.waiter_count == 3

      # 🔴 The two nils are the POINT, not an omission. CLAUDE.md's admin rule
      # — an explicit null is the honesty signal, never papered over with a
      # computed field — lands exactly here: a `held_ms: 0` would assert a
      # measured hold of zero, and a synthesised `holder_pid` would name
      # somebody. A mutant that defaults either one dies on these two lines.
      assert row.holder_pid == nil
      assert row.held_ms == nil
      assert row.holder == nil

      # #1888 — the same rule for the two fields the closing bracket adds.
      # Nothing here released a hold, so there is no write path to name and no
      # announcement to report; both stay explicitly absent.
      assert row.caller == nil
      assert row.announced == nil

      # The waiters ARE the payload: they are the only thing this episode can
      # honestly show, and the stack is what separates "blocked on the lock"
      # from "queued for a connection".
      assert length(row.waiters) == 3
      assert hd(row.waiters).stacktrace == ["Exqlite.Sqlite3NIF.step/2"]
    end

    test "[:grappa, :repo, :lock_stall, :nif_census] folds the roster, and names nobody as the holder" do
      :telemetry.execute(
        [:grappa, :repo, :lock_stall, :nif_census],
        %{parked_count: 2, longest_parked_ms: 31_402},
        %{
          observed_at: "2026-09-01T10:07:28.554000Z",
          registered_holders: 0,
          registered_waiters: 1,
          parked: [
            %{
              pid: "#PID<0.222.0>",
              elapsed_ms: 31_402,
              current_function: "Exqlite.Sqlite3NIF.step/2",
              stacktrace: ["Grappa.Scrollback.persist_row/1"]
            },
            %{pid: "#PID<0.333.0>", elapsed_ms: 30_011, current_function: "Exqlite.Sqlite3NIF.execute/2"}
          ]
        }
      )

      assert [row] = DbLatency.snapshot().lock_stalls

      assert row.phase == :nif_census
      assert row.observed_at == "2026-09-01T10:07:28.554000Z"

      # 🔴 `holder_pid: nil` is a STRONGER statement here than on the
      # `:unattributed` row, and a mutant that fills it in — say with the
      # longest-parked pid, which is the plausible guess — dies here. On this
      # phase a holder is certainly among `parked`; the instrument simply
      # cannot say which, because exqlite's busy handler sleeps inside the
      # same dirty-IO NIF the lock holder is executing in.
      assert row.holder_pid == nil
      assert row.held_ms == nil
      assert row.holder == nil
      assert row.caller == nil
      assert row.announced == nil

      # A census counts no QUEUE. `parked_count` is a different measurement
      # and rides the measurements map, exactly as #1687 refused to reuse
      # `held_ms` for a longest WAIT. A mutant that copies `parked_count` in
      # here reports two blocked writers where nobody measured one.
      assert row.waiter_count == nil
      assert row.waiters == []

      # The roster IS the payload, and the counts are what tell an operator
      # whether to widen coverage or to scroll up to a line the other two
      # arms already printed.
      assert length(row.parked) == 2
      assert hd(row.parked).stacktrace == ["Grappa.Scrollback.persist_row/1"]
      assert row.registered_holders == 0
      assert row.registered_waiters == 1
    end

    test "the lock-stall ring is bounded, keeping the newest episodes" do
      for n <- 1..25 do
        :telemetry.execute(
          [:grappa, :repo, :lock_stall, :resolved],
          %{held_ms: n},
          %{
            observed_at: "2026-09-01T10:07:#{String.pad_leading("#{n}", 2, "0")}.000000Z",
            holder_pid: "#PID<0.#{n}.0>",
            announced: false,
            caller: %{pid: "#PID<0.#{n}.0>", initial_call: "unknown", stacktrace: []}
          }
        )
      end

      stalls = DbLatency.snapshot().lock_stalls

      # These rows carry sampled stacktraces; unbounded, they would grow the
      # singleton's heap for as long as the node lives.
      assert length(stalls) == 20
      assert hd(stalls).held_ms == 25
      assert List.last(stalls).held_ms == 6
    end

    test "reset/0 zeroes accumulated state" do
      :telemetry.execute(
        [:grappa, :repo, :query],
        %{total_time: ms(10)},
        %{source: "messages", query: "SELECT 1"}
      )

      # Drain, then reset.
      _ = DbLatency.snapshot()
      :ok = DbLatency.reset()

      assert DbLatency.snapshot().queries == []
    end
  end

  describe "init/1 attach flag (boot wiring)" do
    setup do
      :telemetry.detach(@handler_id)
      on_exit(fn -> :telemetry.detach(@handler_id) end)
      :ok
    end

    test "the production event set and this file's expectation of it have not drifted" do
      # The two failures this catches are asymmetric and BOTH are quiet.
      # A production event with no clause in this file's `@events` never
      # reaches an assertion, so a fold bug ships green; an entry here with no
      # production event makes every test in the aggregation describe fold
      # nothing, which reads as "the emitter is broken" and sends the reader
      # to the wrong module. Naming the difference costs one assertion.
      assert Enum.sort(DbLatency.attached_events()) == Enum.sort(@events)
    end

    test "attach_telemetry: true attaches the handler to every measured event" do
      assert {:ok, _} = DbLatency.init(attach_telemetry: true)

      for event <- @events do
        assert Enum.any?(:telemetry.list_handlers(event), &(&1.id == @handler_id)),
               "expected handler attached for #{inspect(event)}"
      end
    end

    test "attach_telemetry: false attaches nothing" do
      assert {:ok, _} = DbLatency.init(attach_telemetry: false)

      refute Enum.any?(
               :telemetry.list_handlers([:grappa, :repo, :query]),
               &(&1.id == @handler_id)
             )
    end
  end
end
