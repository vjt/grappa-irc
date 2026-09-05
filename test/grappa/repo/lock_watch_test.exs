defmodule Grappa.Repo.LockWatchTest do
  @moduledoc """
  #1420 — the write-lock observer, bought with a REAL `SQLITE_BUSY` wait.

  ## Why a private repo and not the Sandbox

  The suite runs `pool_size: 1` under `Ecto.Adapters.SQL.Sandbox`, where
  every process shares one connection: two writers cannot contend, they
  queue. That is exactly why `Grappa.Repo.BusyRetry` carries a fault
  injection seam at all. But an INJECTED busy would prove nothing here —
  the claim under test is that `acquired` fires only once SQLite has
  actually granted `RESERVED`, and a hand-raised exception never grants
  anything. So this file follows `Grappa.Repo.BusyRetryFidelityTest`: a
  private `TmpRepo` on a temp file with `pool_size: 2`, one process parked
  inside a write transaction and a second genuinely blocked in its
  `BEGIN IMMEDIATE`.

  ## Why the detection pass is driven, not awaited

  `LockWatch.scan/1` is called directly instead of waiting for the
  watchdog's tick. A test that sleeps past a tick interval measures the
  scheduler as much as the code; driving the pass makes the assertions
  deterministic under `--repeat-each`. The barrier before each scan is a
  polled CONDITION (both processes visible in their expected roles), never
  a fixed sleep.

  Both processes are `spawn_monitor`'d rather than linked, so a writer that
  dies takes down an assertion with a readable reason instead of the test
  process.
  """
  use Grappa.DataCase, async: false

  import ExUnit.{CaptureIO, CaptureLog}

  alias Grappa.Repo.LockWatch

  defmodule TmpRepo do
    @moduledoc false
    use Ecto.Repo, otp_app: :grappa, adapter: Ecto.Adapters.SQLite3
  end

  @detected [:grappa, :repo, :lock_stall, :detected]
  @unattributed [:grappa, :repo, :lock_stall, :unattributed]
  @resolved [:grappa, :repo, :lock_stall, :resolved]
  @nif_census [:grappa, :repo, :lock_stall, :nif_census]

  # 🔴 TWO CLOCKS BOUND EVERY TEST HERE, AND THEY HAVE TO BE ORDERED.
  #
  # The queued writer stays queued only while SQLite's busy handler keeps
  # waiting for it: `busy_timeout` is a hard wall-clock budget that starts at
  # that writer's `BEGIN IMMEDIATE` and has to cover everything the test does
  # before it releases the holder. ExUnit's own per-test deadline is the other
  # clock. While the budget was the SMALLER of the two, a runner slow enough to
  # push a test past it killed the WAITER first, and the test then reported the
  # consequence — a telemetry message that never arrived, with an unrelated
  # `%Exqlite.Error{message: "database is locked"}` sitting in the mailbox —
  # rather than "this test is too slow" (#1687, CI run 32663241142).
  #
  # Measured on 29bea21d, in this file's own topology: the budget is
  # wall-clock and load-INSENSITIVE (`30_000` configured → 32.9s idle and
  # 32.8s with 32 spinning processes; `500` → 586ms, `2_000` → 4.2s, so it
  # tracks the setting), while every test in this file costs 15–378ms. So the
  # cure is not a bigger guess at the budget: it is the ORDER. Derive the
  # budget FROM the test deadline and no test ExUnit still allows to run can
  # outlive its own waiter — a stalled runner then fails as an ExUnit timeout,
  # which names the test and the line instead of the symptom.
  #
  # This is the same move as `observed_write/3`'s `timeout: :infinity`, one
  # layer out: that one removed the checkout deadline so `busy_timeout` was
  # the only bound left, and this one bounds `busy_timeout` in turn.
  @test_timeout_ms 60_000
  @moduletag timeout: @test_timeout_ms
  @waiter_budget_ms @test_timeout_ms * 2

  # 🔴 THE BARRIER IS A THIRD CLOCK, AND IT HAS TO BE ORDERED TOO (#1747).
  #
  # `await_until/2` used to count 300 ATTEMPTS, which is not a budget in
  # either direction. On a healthy runner it gave up after ~3s — under the
  # roles a slow runner still needs. On a starved one it ran far past ExUnit's
  # deadline, so its own `flunk` became UNREACHABLE and the test died an
  # `ExUnit.TimeoutError` whose stack was sampled from wherever the loop
  # happened to be. Six unrelated PRs went red that way in one night, all six
  # naming a frame that turns out not to be a blocker at all: measured, an
  # `:application.get_application/1` answers in 9µs with the
  # `application_controller` SUSPENDED, and a `Process.info(pid,
  # :current_stacktrace)` against a process inside a dirty NIF answers in
  # 21µs. Neither can park; the stack was an artefact of sampling a busy loop.
  #
  # Same move as the two clocks above, applied to the clock they missed:
  # derive FROM the test deadline, and stay strictly UNDER it so the honest
  # diagnosis is always the one that fires.
  @barrier_budget_ms div(@test_timeout_ms, 2)

  # 🔴 A FOURTH CLOCK, AND THIS ONE OBSERVES THE OTHER THREE (#1767).
  #
  # Seven reds in this file were each reported as ONE stack, sampled by ExUnit
  # at the 60s cut, and four of them named the same frames. That looked like a
  # block in `LockWatch.stacktrace/1` and it is not one. Measured on
  # `c8a0bf4d`, in this file's own topology:
  #
  #   * `Process.info(pid, :current_stacktrace)` against a writer parked
  #     inside `Exqlite.Sqlite3NIF.execute/2` on a contended BEGIN IMMEDIATE
  #     answers in 2-78µs and NEVER blocked — 40 samples at 16 schedulers,
  #     again at 2, and again with 14 parked NIFs against 10 dirty-IO slots,
  #     with the target reading `:running`, `:runnable` AND `:waiting`;
  #   * the WHOLE report path costs 502µs idle and 2 847µs with the dirty-IO
  #     slots saturated threefold, and loads ZERO modules, so #1715's
  #     code-loading mechanism has nothing to bite on here;
  #   * the frame MOVED between occurrences — `Process.info/2` (`:682`) in
  #     CI, `Exception.format_stacktrace_entry/1` (`:686`) in the local
  #     repro. A block stands still in one place; a sample lands wherever the
  #     machine stopped.
  #
  # What the reds share is not a place, it is a RATE. In the one run
  # reproduced locally EVERY test cost 7.7s against 0.19s across 71 green
  # repetitions of the same command on the same tree — the cause is OUTSIDE
  # the test. One frame cannot tell a starved process from a blocked one, so
  # this films the TRAJECTORY instead, and carries `reductions` as the
  # discriminator: reductions that do not advance between two samples are
  # positive evidence that the process was not scheduled, which no stack
  # sample can establish.
  #
  # Derived from the deadline like its three siblings, never chosen: the
  # threshold is a twentieth of it, which is ~15x a healthy test in this file
  # and a twentieth of a budget ExUnit still allows, so a sane run is silent.
  # It does NOT touch the production module, does not move a timeout and does
  # not weaken an assertion — it only reports.
  @film_interval_ms 250
  @film_threshold_ms div(@test_timeout_ms, 20)
  @film_answer_budget_ms 2_000
  @film_stack_frames 3
  @film_max_samples div(@test_timeout_ms, @film_interval_ms) + 10

  setup context do
    start_filmer(context.test)
    LockWatch.put_test_enabled(true)
    on_exit(fn -> LockWatch.put_test_enabled(false) end)

    handler = "lock-watch-test-#{System.unique_integer([:positive])}"
    test_pid = self()

    # Every door on ONE handler, tagged by event: a test that asserts the
    # attributed line fired must also be able to REFUTE the unattributed one
    # (and vice versa). Two separate handlers would let a mutant that emits
    # both pass every assertion in the file. #1888 adds the closing bracket
    # for the same reason — a test that asserts an episode brackets must be
    # able to refute that it brackets when it should not. #1901 adds the NIF
    # census on the same reasoning: it is a THIRD verdict about the same lock,
    # and a mutant routing a seam-attributable stall through it (or the other
    # way round) has to die on a refutation somewhere.
    :ok =
      :telemetry.attach_many(
        handler,
        [@detected, @unattributed, @resolved, @nif_census],
        fn
          @detected, measurements, metadata, _ -> send(test_pid, {:stall, measurements, metadata})
          @unattributed, measurements, metadata, _ -> send(test_pid, {:unattributed, measurements, metadata})
          @resolved, measurements, metadata, _ -> send(test_pid, {:resolved, measurements, metadata})
          @nif_census, measurements, metadata, _ -> send(test_pid, {:nif_census, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler) end)

    :ok
  end

  describe "holder vs waiter under a real BEGIN IMMEDIATE contention" do
    test "names the HOLDER, lists the blocked writer as a waiter, and samples the holder's live stack" do
      repo = start_tmp_repo()

      {holder, holder_ref} = start_writer(1, :park)
      assert_receive {:holding, ^holder}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(holder, [waiter])

      LockWatch.scan(0)

      assert_receive {:stall, measurements, stall}, 1_000

      # M1 — a mutant that reports the longest-queued WAITER as the holder
      # (the two roles are symmetric in the table; only the tag separates
      # them) has to survive both of these to live.
      assert stall.holder.pid == inspect(holder)
      assert [waiter_sample] = stall.waiters
      assert waiter_sample.pid == inspect(waiter)

      # M2 — a mutant that never promotes `:waiting` to `:holding` leaves no
      # holder at all, so there is nothing to report and this never arrives;
      # a mutant that promotes TOO EARLY (before the transaction opens)
      # promotes the blocked writer too, and the waiter count goes to zero.
      assert stall.waiter_count == 1
      assert measurements.waiter_count == 1
      assert is_integer(measurements.held_ms)

      # M4 — a mutant sampling `self()` (the scanning process) instead of
      # the holder's pid still produces a well-formed record, and only the
      # CONTENT of the stack tells the two apart. This frame is the reason
      # the holder is stuck, which is the datum #1420 says is missing.
      assert Enum.any?(stall.holder.stacktrace, &(&1 =~ "park_until_released"))

      # #1687 — the two arms are mutually exclusive by construction. A mutant
      # that emits the unattributed line unconditionally (rather than only
      # when nothing was named) would double-report every real stall, and the
      # operator would learn to ignore both.
      refute_receive {:unattributed, _, _}, 100

      send(holder, :release)
      assert_receive {:DOWN, ^holder_ref, :process, ^holder, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "a holder that has not crossed the threshold is not reported, queue or no queue" do
      repo = start_tmp_repo()

      {holder, holder_ref} = start_writer(1, :park)
      assert_receive {:holding, ^holder}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(holder, [waiter])

      # M5 — a mutant that drops the `elapsed >= threshold` comparison
      # reports immediately and dies here. The holder has been holding for
      # milliseconds, not the ten seconds demanded.
      LockWatch.scan(10_000)

      refute_receive {:stall, _, _}, 300

      send(holder, :release)
      assert_receive {:DOWN, ^holder_ref, :process, ^holder, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "a slow but UNCONTENDED holder is not a stall" do
      repo = start_tmp_repo()

      {holder, holder_ref} = start_writer(1, :park)
      assert_receive {:holding, ^holder}, 5_000

      await_roles(holder, [])

      # M3 — a mutant that emits on a slow holder without checking for a
      # queue behind it fires here. Nobody is blocked: this transaction is
      # slow, and slow is not a stall. Reporting it would bury the signal
      # the instrument exists to find under every long write in the system.
      LockWatch.scan(0)

      refute_receive {:stall, _, _}, 300

      send(holder, :release)
      assert_receive {:DOWN, ^holder_ref, :process, ^holder, :normal}, 5_000

      Supervisor.stop(repo)
    end
  end

  describe "a queue with no attributable holder (#1687)" do
    test "reports the queue instead of staying silent, and says the holder was never attributed" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(nil, [waiter])

      # The LOG is the door that failed in prod: LockWatch was armed through a
      # three-minute episode and put NOT ONE line in `erlang.log.5`, so the
      # #1429 census and the operator both read a healthy system. Pinning the
      # telemetry alone would leave exactly the door that was dark, dark.
      log = capture_log(fn -> LockWatch.scan(0) end)

      assert log =~ "db lock stall UNATTRIBUTED"
      assert log =~ "no holder registered"

      assert_receive {:unattributed, measurements, report}, 1_000

      # M6 — a mutant reporting the holder-less queue with a fabricated holder
      # (the shape the issue's own wording invites) dies here: there is no
      # holder to name, and the record says so rather than guessing.
      assert report.holders_registered == 0

      # M7 — a mutant sampling `self()` (the scanning process) instead of the
      # queued writers still produces a well-formed record; only the pid tells
      # them apart. The waiters ARE the payload here — they are the only thing
      # the instrument can honestly show.
      assert [sample] = report.waiters
      assert sample.pid == inspect(waiter)
      assert is_integer(sample.elapsed_ms)

      assert measurements.waiter_count == 1
      assert is_integer(measurements.longest_wait_ms)

      # M8 — the queue is NOT a named stall. A mutant that routes this through
      # the attributed door would put a `holder` key on a record that has none.
      refute_receive {:stall, _, _}, 100

      send(blind, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "a queue that has not crossed the threshold is not reported either" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(nil, [waiter])

      # M9 — the mirror of M5 on the new arm. A mutant that drops the
      # threshold comparison for waiters turns every transient queue behind
      # every autocommit write into a warning, which on the hot path is a log
      # flood, not a signal.
      LockWatch.scan(10_000)

      refute_receive {:unattributed, _, _}, 300

      send(blind, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "one line per queued cohort, not one per watchdog tick" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(nil, [waiter])

      LockWatch.scan(0)
      assert_receive {:unattributed, _, _}, 1_000

      # M10 — the prod episode ran ~170s at `tick_ms: 1_000`. A mutant that
      # forgets to arm the row's `reported?` flag prints ~170 identical
      # warnings for one episode, which is the same as printing none.
      LockWatch.scan(0)
      refute_receive {:unattributed, _, _}, 300

      send(blind, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "a waiter already reported as unattributed is still reportable once it becomes the holder" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {writer, writer_ref} = start_writer(2, :park)
      await_roles(nil, [writer])

      LockWatch.scan(0)
      assert_receive {:unattributed, _, _}, 1_000

      # The unregistered writer lets go; the pid that was just reported as a
      # WAITER now takes RESERVED itself.
      send(blind, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:holding, ^writer}, 10_000

      {queued, queued_ref} = start_writer(3, :straight_through)
      await_roles(writer, [queued])

      LockWatch.scan(0)

      # 🔴 M11, and it is the whole reason this test exists. `acquired/0`
      # promotes the row's role and restarts its clock but leaves the
      # `reported?` flag exactly where it was, so a pid reported once as a
      # waiter would be permanently unreportable as a HOLDER — the cure for
      # the unattributed blindness having quietly blinded the attributed path
      # that already worked. The flag has to clear on promotion, because the
      # promotion starts a new episode with a new clock.
      assert_receive {:stall, _, stall}, 1_000
      assert stall.holder.pid == inspect(writer)

      send(writer, :release)
      assert_receive {:DOWN, ^writer_ref, :process, ^writer, :normal}, 5_000
      assert_receive {:DOWN, ^queued_ref, :process, ^queued, :normal}, 10_000

      Supervisor.stop(repo)
    end
  end

  # 🔴 THE TOPOLOGY THESE FOUR TESTS BUY, AND WHY IT IS NOT THE ONE ABOVE.
  #
  # Every test up to here drives the watch TABLE: a writer is a holder or a
  # waiter because `observe/1` said so. #1901 is about the writers that never
  # reach `observe/1` at all — `Scrollback.persist_row/1` and its ~120
  # autocommit peers, which the issue measures at 324 679 inserts against
  # thousands for the whole seam. The census reads `Process.list/0` instead,
  # so what it needs from a fixture is a process genuinely parked INSIDE
  # `Exqlite.Sqlite3NIF`, with no row anywhere.
  #
  # `start_unobserved_writer/1` gives exactly that when a holder already owns
  # the file lock: its `BEGIN IMMEDIATE TRANSACTION` reaches
  # `Exqlite.Sqlite3NIF.execute/2` (`deps/exqlite/lib/exqlite/connection.ex:307`
  # -> `sqlite3.ex:175`), which is registered `ERL_NIF_DIRTY_JOB_IO_BOUND`
  # (`c_src/sqlite3_nif.c:2066`), and exqlite's own busy handler sleeps INSIDE
  # that NIF (`c_src/sqlite3_nif.c:332`) rather than returning to Elixir to
  # retry. So the writer sits in the NIF for the whole `busy_timeout` and
  # `current_function` names it for as long as it does.
  #
  # 🔴 The parked HOLDER is the negative control and it is load-bearing: it is
  # parked in `park_until_released/0`, a plain `receive`, so it is NOT inside
  # the NIF and MUST NOT appear. That is the honest limit of this arm stated
  # as an assertion — it sees a writer inside a NIF call, not a transaction
  # parked between statements.
  describe "the NIF census — the writers the seam cannot see (#1901)" do
    test "names a writer parked inside the SQLite NIF that owns no row at the seam" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {unseen, unseen_ref} = start_unobserved_writer(2)
      await_parked_in_nif(unseen)

      # The LOG is the door that was dark through all four #1888 episodes:
      # `grep -h "db lock stall" runtime/log/erlang.log.*` returned 0 while
      # six victims timed out at ~31 s. Pinning the telemetry alone would
      # leave exactly the door that failed, failing.
      log = capture_log(fn -> LockWatch.census(%{}, 0) end)

      assert log =~ "db lock stall NIF CENSUS"
      assert log =~ "none of them registered at the BEGIN IMMEDIATE seam"

      assert_receive {:nif_census, measurements, report}, 1_000

      # N1 — the whole deliverable. A mutant that reads the watch table (as
      # both older arms do) finds nothing here: this writer registered
      # nowhere. Only a reading taken from `Process.list/0` can name it.
      assert inspect(unseen) in pids(report.parked)

      # N2 — the negative control. A mutant that reports every process, or
      # every process with an open transaction, drags the parked holder in.
      # It holds RESERVED and is NOT in a NIF, and this arm must not pretend
      # otherwise.
      refute inspect(blind) in pids(report.parked)
      refute inspect(self()) in pids(report.parked)

      # N3 — the honesty fields. `0` says the seam saw none of these
      # processes at all, which is the #1901 finding in one number. A mutant
      # that synthesises a holder (the shape the acceptance criterion
      # invites) has to put a pid somewhere, and there is no field for one.
      assert report.registered_holders == 0
      assert report.registered_waiters == 0
      refute Map.has_key?(report, :holder)

      # N4 — a mutant sampling `self()` instead of the parked pid still
      # produces a well-formed record; only the CONTENT of the stack tells
      # them apart, and this frame is the reason the writer is stuck.
      assert [sample] = Enum.filter(report.parked, &(&1.pid == inspect(unseen)))
      assert sample.current_function =~ "Exqlite.Sqlite3NIF"
      assert Enum.any?(sample.stacktrace, &(&1 =~ "Exqlite"))

      assert measurements.parked_count == length(report.parked)
      assert is_integer(measurements.longest_parked_ms)

      # N5 — the three arms are distinct verdicts. A mutant that also routes
      # this through either older door would double-report the same episode
      # under two different claims about attribution.
      refute_receive {:stall, _, _}, 100
      refute_receive {:unattributed, _, _}, 100

      # BOTH, and `unseen` before it is even unblocked: the moment `blind`
      # lets go, `unseen` takes RESERVED and parks in `park_until_released/0`
      # exactly as its fixture is written to. A `:release` sent early simply
      # waits in its mailbox, while one sent late never arrives — measured,
      # first cut of these tests: three reds, all of them this.
      send(blind, :release)
      send(unseen, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:DOWN, ^unseen_ref, :process, ^unseen, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "a writer the seam DOES know is counted as such, not as an unseen one" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      # This one goes through `observe/1`, so it owns a `:waiting` row while
      # it blocks in the very same NIF call.
      {waiter, waiter_ref} = start_writer(2, :straight_through)
      await_roles(nil, [waiter])
      await_parked_in_nif(waiter)

      log = capture_log(fn -> LockWatch.census(%{}, 0) end)

      assert_receive {:nif_census, _, report}, 1_000

      # N6 — the counts are the difference between "widen coverage" and
      # "the seam already told you". A mutant that hard-codes them to zero
      # (the shape the first test alone would let live) reports a registered
      # waiter as a writer nobody can see, and an operator reading it would
      # go looking for an instrument that is already there.
      assert inspect(waiter) in pids(report.parked)
      assert report.registered_waiters == 1
      assert report.registered_holders == 0
      assert log =~ "registered at the BEGIN IMMEDIATE seam"
      refute log =~ "none of them registered"

      send(blind, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "a process that has not been in the NIF long enough is not reported" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {unseen, unseen_ref} = start_unobserved_writer(2)
      await_parked_in_nif(unseen)

      # N7 — the mirror of M5/M9 on the third arm. The first pass can only
      # ever see a pid at elapsed 0, so a mutant that drops the threshold
      # comparison turns every millisecond-long insert on the system into a
      # warning at every tick: a log flood, which reads the same as silence.
      seen = LockWatch.census(%{}, 10_000)

      refute_receive {:nif_census, _, _}, 300

      # N8 — and the clock it started has to SURVIVE, or the threshold can
      # never be crossed on any later pass. A mutant that returns a fresh map
      # (or the one it was handed) re-clocks the pid at every tick and the
      # arm is permanently silent — the exact failure #1901 reports, rebuilt
      # inside its own cure.
      assert {since, false} = Map.fetch!(seen, unseen)
      assert is_integer(since)

      # BOTH, and `unseen` before it is even unblocked: the moment `blind`
      # lets go, `unseen` takes RESERVED and parks in `park_until_released/0`
      # exactly as its fixture is written to. A `:release` sent early simply
      # waits in its mailbox, while one sent late never arrives — measured,
      # first cut of these tests: three reds, all of them this.
      send(blind, :release)
      send(unseen, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:DOWN, ^unseen_ref, :process, ^unseen, :normal}, 10_000

      Supervisor.stop(repo)
    end

    test "one line per cohort, not one per watchdog tick" do
      repo = start_tmp_repo()

      {blind, blind_ref} = start_unobserved_writer(1)
      assert_receive {:holding, ^blind}, 5_000

      {unseen, unseen_ref} = start_unobserved_writer(2)
      await_parked_in_nif(unseen)

      {seen, _} = with_log(fn -> LockWatch.census(%{}, 0) end)
      assert_receive {:nif_census, _, _}, 1_000

      # N9 — the #1888 episodes ran ~31 s at `tick_ms: 1_000` and the #1687
      # one ~170 s. A mutant that forgets to carry the reported flag prints
      # one identical warning per tick for the whole freeze, which is how the
      # other two arms would have drowned their own signal.
      LockWatch.census(seen, 0)
      refute_receive {:nif_census, _, _}, 300

      # BOTH, and `unseen` before it is even unblocked: the moment `blind`
      # lets go, `unseen` takes RESERVED and parks in `park_until_released/0`
      # exactly as its fixture is written to. A `:release` sent early simply
      # waits in its mailbox, while one sent late never arrives — measured,
      # first cut of these tests: three reds, all of them this.
      send(blind, :release)
      send(unseen, :release)
      assert_receive {:DOWN, ^blind_ref, :process, ^blind, :normal}, 5_000
      assert_receive {:DOWN, ^unseen_ref, :process, ^unseen, :normal}, 10_000

      Supervisor.stop(repo)
    end
  end

  describe "the production seam" do
    test "Grappa.Repo.immediate_transaction/1 registers its caller as the holder, and clears on exit" do
      me = inspect(self())

      # Pins that the observer is actually WIRED to the production function,
      # in the right place. The tests above drive `LockWatch.observe/1`
      # themselves, so on their own they would still pass if
      # `immediate_transaction/1` had never been instrumented at all.
      #
      # Honest limit: the DataCase sandbox already holds a transaction on
      # this connection, and `Exqlite.Connection.handle_begin/2` emits
      # SAVEPOINT rather than BEGIN IMMEDIATE in that state
      # (deps/exqlite/lib/exqlite/connection.ex:310-315). So this pins the
      # WIRING and the edge ORDER; the real `RESERVED` acquisition is what
      # the TmpRepo tests above measure.
      assert {:ok, %{holders: holders}} =
               Grappa.Repo.immediate_transaction(fn -> LockWatch.inspect_lock() end)

      assert Enum.any?(holders, &(&1.pid == me))

      assert %{holders: [], waiters: []} = LockWatch.inspect_lock()
    end
  end

  describe "the closing bracket, when the watchdog never spoke (#1888)" do
    # The premise these four tests are bought against, and it is the whole
    # reason the bracket had to change: before #1888 `close_episode/1` matched
    # `reported?: true` and NOTHING else, so an episode the watchdog never
    # announced left no trace on either door. That is the exact shape #1888
    # reports from prod — a 31 s freeze with the observer armed and not one
    # line of its own in the log — and it makes the instrument's silence
    # indistinguishable between "no stall happened" and "the stall happened
    # and I could not say so".
    #
    # The threshold is driven to 0 rather than waited out: `stall_threshold_ms`
    # is a wall clock, and a test that sleeps past 2_000ms to cross it measures
    # the runner. 0 is a coherent operator setting (see the `t()` typedoc) and
    # the file's other tests already drive detection rather than await it.
    setup do
      LockWatch.put_test_stall_threshold(0)
      on_exit(fn -> LockWatch.put_test_stall_threshold(nil) end)
      :ok
    end

    test "a hold nobody announced still brackets, and names the write path that held it" do
      # Held from a Task, not from the test process, and that is not
      # incidental. `$initial_call` is written by `proc_lib`, so every holder
      # this instrument meets in prod has one — `Session.Server`, a Phoenix
      # channel, a `Task.Supervisor` child, a reaper — while a bare ExUnit test
      # process does NOT (measured: it reads `unknown`). Holding from the test
      # process would have bought the assertion against the one topology that
      # never occurs.
      # Started INSIDE the capture, not before it: the bracket is emitted by
      # the task's own `released/0`, which runs before the task returns, so a
      # task spawned ahead of `with_log/1` can have logged and finished before
      # the capture handler is even installed.
      {task_pid, log} =
        with_log(fn ->
          task = Task.async(&hold_and_return/0)
          assert {:held, _} = Task.await(task)
          task.pid
        end)

      assert_receive {:resolved, %{held_ms: held_ms}, meta}
      assert is_integer(held_ms) and held_ms >= 0

      # The finding, not a formatting detail: this episode was never announced
      # while it held, and the row has to SAY so — otherwise an operator reads
      # a bracket and assumes the opening line is somewhere above it in a log
      # that never carried one.
      assert meta.announced == false
      assert log =~ "db lock stall RESOLVED"
      assert log =~ "NEVER announced"

      # The identity #1888 asks for. It is the CALLER — who opened the write
      # transaction — and deliberately not a `sample()`: by release time there
      # is no pause site left to sample, and reusing the holder's shape would
      # smuggle back a claim the frame cannot make.
      assert meta.caller.pid == inspect(task_pid)
      assert meta.caller.initial_call == "Grappa.Repo.LockWatchTest.hold_and_return/0"

      # LockWatch's own plumbing is dropped from the stack, so the FIRST frame
      # an operator reads is the write path itself. Without the drop the head
      # is `Process.info/2` under four frames of observer — which is exactly
      # what the first cut of this printed.
      assert [first | _] = meta.caller.stacktrace
      assert first =~ "Grappa.Repo.LockWatchTest.hold_and_return/0"
      refute Enum.any?(meta.caller.stacktrace, &(&1 =~ "lock_watch.ex"))
      refute Enum.any?(meta.caller.stacktrace, &(&1 =~ "Process.info"))
    end

    test "an ANNOUNCED hold brackets exactly as it did before, and says it was announced" do
      # A queue behind the holder is the second half `report_stalls/2`
      # requires. Without it the detection pass walks away and this test would
      # measure the unannounced arm again, passing for the wrong reason.
      waiter = queue_a_waiter()

      log =
        capture_log(fn ->
          LockWatch.observe(fn acquired ->
            acquired.()
            LockWatch.scan(0)
            :ok
          end)
        end)

      release_waiter(waiter)

      assert_receive {:stall, _, _}
      assert_receive {:resolved, _, meta}

      assert meta.announced == true
      assert log =~ "db lock stall RESOLVED"
      refute log =~ "NEVER announced"
    end

    test "a hold UNDER the threshold that nobody announced brackets nothing" do
      # The negative control for the arm above. A bracket on every write
      # transaction would bury the signal in exactly the way `report_stalls/2`
      # refuses to, and would make the ring useless within seconds of boot.
      LockWatch.put_test_stall_threshold(60_000)

      log =
        capture_log(fn ->
          LockWatch.observe(fn acquired ->
            acquired.()
            :ok
          end)
        end)

      refute_receive {:resolved, _, _}, 200
      refute log =~ "db lock stall RESOLVED"
    end

    test "with no threshold published at all, only an announced hold brackets" do
      # The graceful-degradation contract of the `:persistent_term` seam: the
      # watchdog publishes the threshold at `init/1`, so a node where it never
      # booted (or has just been restarted) has no threshold to compare
      # against. Guessing one would invent a verdict; the honest fallback is
      # the pre-#1888 behaviour, which needs no threshold because `reported?`
      # already proves the episode crossed it.
      LockWatch.put_test_stall_threshold(nil)

      LockWatch.observe(fn acquired ->
        acquired.()
        :ok
      end)

      refute_receive {:resolved, _, _}, 200
    end
  end

  describe "the instant an episode was observed (#1888)" do
    test "every phase carries it, so a ring row can be aligned with the log" do
      # `Grappa.DbLatency`'s ring is the door that survives a log that went
      # quiet — but a row with no instant cannot be matched against
      # `erlang.log`, which is the only artefact that dates the freeze. Stamped
      # at EMIT rather than at fold: the fold happens in another process behind
      # a cast, and `recorded_at` would be a different fact wearing this name.
      LockWatch.put_test_stall_threshold(0)
      on_exit(fn -> LockWatch.put_test_stall_threshold(nil) end)

      waiter = queue_a_waiter()

      capture_log(fn ->
        LockWatch.observe(fn acquired ->
          acquired.()
          LockWatch.scan(0)
          :ok
        end)
      end)

      release_waiter(waiter)

      assert_receive {:stall, _, detected}
      assert_receive {:resolved, _, resolved}

      for meta <- [detected, resolved] do
        assert {:ok, %DateTime{}, 0} = DateTime.from_iso8601(meta.observed_at)
      end
    end
  end

  # `:logger_config` caches "may this module log?" under one
  # `persistent_term` key PER MODULE, and writes it the first time that
  # module logs. `allow/2` stores `?PRIMARY_TO_CACHE(get_primary_level())`,
  # so the cached value is the PRIMARY level — the same for every module,
  # and unrelated to the level of the call that happened to arrive first.
  @logger_module_cache {:logger_config, LockWatch}
  @logger_primary_cache {:logger_config, :"$primary_config$"}

  describe "the logger module cache (#1715)" do
    test "init/1 primes it, so no report path pays the first persistent_term:put" do
      # A `persistent_term` write blocks on a thread-progress barrier, and a
      # SQLite busy handler sleeping out its `busy_timeout` on a dirty-IO
      # scheduler holds that barrier. So whichever call site logs FIRST from
      # this module pays a wait of up to the whole `busy_timeout` — and the
      # first line this module ever emits is, by construction, its stall
      # report: the one thing that must not wait on the stall it is
      # reporting. Paying the put at `init/1` moves it to boot, where no
      # write lock is held.
      #
      # Erasing first is what gives the assertion teeth: without it the key
      # is already there from the application's own boot and the test would
      # pass with the priming deleted.
      :persistent_term.erase(@logger_module_cache)
      assert :persistent_term.get(@logger_module_cache, :absent) == :absent

      restart_lock_watch()

      assert :persistent_term.get(@logger_module_cache, :absent) ==
               :persistent_term.get(@logger_primary_cache)
    end
  end

  describe "the barrier itself (#1747)" do
    test "a slow predicate cannot push the barrier past its own budget" do
      # #1747 — six unrelated PRs went red here with a 60 s `ExUnit.TimeoutError`
      # and NEVER with `await_until`'s own `flunk`, which is the diagnosis this
      # helper exists to print. That is arithmetic, not luck: an attempt count
      # is not a budget. Bounded at 300 attempts the helper spends ~3 s on a
      # healthy runner and well past ExUnit's 60 s ceiling on a starved one, so
      # exactly when the failure is interesting the honest message becomes
      # unreachable and the report shows a stack sampled from wherever the loop
      # happened to be.
      #
      # A 30 ms predicate is the starved runner, compressed: under the attempt
      # bound this call costs 200 * (30 + 10) ms = 8 s, under a wall-clock bound
      # it costs the budget.
      budget_ms = 200

      {elapsed_us, _} =
        :timer.tc(fn ->
          assert_raise ExUnit.AssertionError, fn ->
            await_until(
              fn ->
                Process.sleep(30)
                false
              end,
              budget_ms
            )
          end
        end)

      assert div(elapsed_us, 1000) < 10 * budget_ms
    end

    test "lock_roles/0 names the same holders and waiters inspect_lock/0 does" do
      # The barrier compares pid lists and nothing else, but `inspect_lock/0`
      # formats a 12-frame stacktrace per sampled process to answer it. This
      # pins the cheap projection to the expensive one so the barrier can stop
      # paying for a diagnostic it never reads — and so a reimplementation that
      # drifts from `partition/2` reddens here instead of silently disagreeing
      # with the instrument it is supposed to mirror.
      repo = start_tmp_repo()

      {holder, holder_ref} = start_writer(1, :park)
      assert_receive {:holding, ^holder}, 5_000

      {waiter, waiter_ref} = start_writer(2, :straight_through)

      await_roles(holder, [waiter])

      %{holders: held, waiters: queued} = LockWatch.lock_roles()
      %{holders: held_samples, waiters: queued_samples} = LockWatch.inspect_lock()

      assert Enum.map(held, &inspect/1) == pids(held_samples)
      assert Enum.sort(Enum.map(queued, &inspect/1)) == Enum.sort(pids(queued_samples))
      assert held == [holder]
      assert queued == [waiter]

      send(holder, :release)
      assert_receive {:DOWN, ^holder_ref, :process, ^holder, :normal}, 5_000
      assert_receive {:DOWN, ^waiter_ref, :process, ^waiter, :normal}, 10_000

      Supervisor.stop(repo)
    end
  end

  describe "the filmer itself (#1767)" do
    test "the canary proves the sampler reads the stack it claims to read" do
      # The control has to answer in BOTH directions or it proves nothing: a
      # predicate that always says yes would pass the positive half alone.
      canary = spawn_canary()

      assert sampler_reads_stack?(canary)
      refute sampler_reads_stack?(self())

      Process.exit(canary, :kill)
    end

    test "a test under the threshold films silently" do
      assert film_verdict(:under, samples(20, 1_000), 20, true, @film_threshold_ms - 1, nil) == :silent
    end

    test "a test over the threshold reports the trajectory, and names the test" do
      assert {:report, text} = film_verdict(:over, samples(20, 1_000), 20, true, @film_threshold_ms, nil)

      assert text =~ "#1767 FILM"
      assert text =~ "test=:over"
      assert text =~ "elapsed=#{@film_threshold_ms}ms"
      assert text =~ "reductions:"

      # Relative to the first sample: a raw monotonic reading is a 12-digit
      # negative number, and a trajectory whose clock cannot be read is not
      # a trajectory.
      assert text =~ "t=0ms"
      assert text =~ "t=#{@film_interval_ms}ms"
    end

    test "an over-threshold test with no samples says so instead of printing an empty film" do
      # Noisy blindness: a film with nothing in it reads as "the test was
      # idle", which is the one conclusion the filmer must never invite.
      assert {:report, text} = film_verdict(:empty, [], 12, true, @film_threshold_ms, nil)

      assert text =~ "NO SAMPLES"
    end

    test "a broken sampler is reported even under the threshold, and produces no film" do
      # A plausible film from a sampler that cannot read a stack is worse
      # than no film: it would be believed.
      assert {:report, text} = film_verdict(:broken, samples(20, 1_000), 20, false, 0, nil)

      assert text =~ "SAMPLER BROKEN"
      refute text =~ "reductions:"
    end

    test "starvation is read off the filmer's OWN turns, not off what it collected" do
      # 🔴 This case USED to assert the defect. It fed one sample and demanded
      # "SAMPLER STARVED", which is exactly the false line a quiet host printed
      # during a PASSING run of this file: 1 collected / 218 expected over
      # 54718ms, while the body cost 132.8ms. Collected-vs-elapsed compares a
      # numerator bounded by the target's LIFETIME against a denominator
      # spanning setup and teardown too.
      expected = div(@film_threshold_ms, @film_interval_ms)

      # Starved: the filmer itself barely ran. That IS a VM reading.
      assert {:report, starved} = film_verdict(:starved, samples(1, 1_000), 1, true, @film_threshold_ms, nil)
      assert starved =~ "SAMPLER STARVED"
      assert starved =~ "1 of #{expected}"

      # NOT starved: the filmer took every turn it was due and found the target
      # gone for almost all of them. Same single sample, opposite verdict —
      # which is the whole point of splitting the two counters.
      assert {:report, gone} = film_verdict(:gone, samples(1, 1_000), expected, true, @film_threshold_ms, nil)
      refute gone =~ "SAMPLER STARVED"
      assert gone =~ "TARGET GONE"

      assert {:report, full} =
               film_verdict(:full, samples(expected, 1_000), expected, true, @film_threshold_ms, nil)

      refute full =~ "SAMPLER STARVED"
      refute full =~ "TARGET GONE"
    end

    test "a single sample prints no delta, because a derivative needs two points" do
      # The vacuous statistic behind #1767's registered diagnosis: with one
      # sample `hd` and `List.last` are the same element, so the old line read
      # `X -> X (+0)` — indistinguishable from a genuinely frozen process.
      assert {:report, one} = film_verdict(:one, samples(1, 1_000), 1, true, @film_threshold_ms, nil)

      refute one =~ "(+0)"
      refute one =~ "REDUCTIONS DID NOT ADVANCE"
      assert one =~ "one sample — no delta"
    end

    test "reductions that never advance are named, and reductions that do are not" do
      # The discriminator #1767 lacked: a stack sample cannot separate a
      # process blocked inside a call from one that was never scheduled.
      # Reductions can — they are monotonic and local to the process.
      assert {:report, frozen} = film_verdict(:frozen, samples(20, 0), 20, true, @film_threshold_ms, nil)
      assert frozen =~ "REDUCTIONS DID NOT ADVANCE"

      assert {:report, moving} = film_verdict(:moving, samples(20, 1_000), 20, true, @film_threshold_ms, nil)
      refute moving =~ "REDUCTIONS DID NOT ADVANCE"
    end

    test "the filmer collects real samples of the test process, not an empty reel" do
      # The verdict tests above are pure. This one buys the other half: that
      # the loop, the sampler and the ask/answer protocol actually produce a
      # trajectory of THIS process, so a green verdict suite cannot sit on
      # top of a filmer that never films.
      filmer = spawn_filmer()

      Process.sleep(@film_interval_ms * 3)

      assert {:film, true, samples, ticks, nil} = ask_filmer(filmer)
      assert length(samples) >= 2
      assert ticks >= length(samples)

      assert Enum.all?(samples, &(&1.reductions > 0))
      assert List.last(samples).reductions > hd(samples).reductions
      assert Enum.any?(samples, fn s -> Enum.any?(s.stack, &match?({__MODULE__, _, _, _}, &1)) end)

      Process.exit(filmer, :kill)
    end

    test "ticks keep advancing after the target dies, and samples do not" do
      # The other half of the tick/sample split, bought against the REAL loop
      # rather than the pure verdict: the pure tests could all pass over a loop
      # that still counted a dead target's ticks as collections.
      #
      # This is the shape every timed-out test in this file takes — ExUnit kills
      # the test process and then runs `on_exit` in another one — so what the
      # filmer sees here is what it saw on the 54718ms green run that started
      # this pass.
      target = spawn(fn -> Process.sleep(:infinity) end)
      filmer = spawn_filmer_at(target)

      Process.sleep(@film_interval_ms * 3)
      assert {:film, true, alive_samples, alive_ticks, nil} = ask_filmer(filmer)
      assert alive_samples != []

      # Monitor BEFORE the kill: established afterwards it fires `:noproc`
      # against an already-dead pid, which asserts the wrong fact.
      ref = Process.monitor(target)
      Process.exit(target, :kill)
      assert_receive {:DOWN, ^ref, :process, ^target, :killed}, 5_000

      Process.sleep(@film_interval_ms * 4)
      assert {:film, true, dead_samples, dead_ticks, _} = ask_filmer(filmer)

      # The filmer kept taking its turns…
      assert dead_ticks > alive_ticks
      # …and collected nothing more, because there was nothing alive to sample.
      assert length(dead_samples) == length(alive_samples)

      Process.exit(filmer, :kill)
    end

    test "the filmer stamps the instant its target died, and carries nil until then" do
      # The clock the 54718ms reading was missing. `elapsed_ms` runs from
      # `start_filmer/1` in `setup` to the printing hook in `on_exit`, so it
      # spans setup, body AND teardown in one number — and the body of every
      # test in this file costs 15-378ms, which means the interesting part is
      # whichever of the other two it is. `TARGET GONE` already says the time
      # is outside the body, but it says it from a RATIO of ticks to samples;
      # a ratio cannot be subtracted from a wall clock. Monitoring the target
      # turns that heuristic into a measurement.
      target = spawn(fn -> Process.sleep(:infinity) end)
      filmer = spawn_filmer_at(target)

      Process.sleep(@film_interval_ms * 2)
      assert {:film, true, _, _, nil} = ask_filmer(filmer)

      # Monitor BEFORE the kill, for the reason the sibling test above states.
      ref = Process.monitor(target)
      Process.exit(target, :kill)
      assert_receive {:DOWN, ^ref, :process, ^target, :killed}, 5_000

      Process.sleep(@film_interval_ms)
      assert {:film, true, _, _, down_at} = ask_filmer(filmer)
      assert is_integer(down_at)

      Process.exit(filmer, :kill)
    end

    test "the report splits the wall clock into setup+body and teardown" do
      assert {:report, text} =
               film_verdict(
                 :split,
                 samples(3, 1_000),
                 40,
                 true,
                 @film_threshold_ms * 3,
                 @film_threshold_ms
               )

      assert text =~ "setup+body #{@film_threshold_ms}ms"
      assert text =~ "teardown #{@film_threshold_ms * 2}ms"
    end

    test "a truncated film does not report its own cap as a dead target" do
      # 🔴 Measured on a real 129406ms run: `TARGET GONE for 257 of 507 ticks`
      # printed alongside `teardown 15ms` in the SAME report. Past
      # `@film_max_samples` every further tick collects nothing however alive
      # the target is, so the collected-vs-ticks ratio fires unconditionally
      # once ticks exceed twice the cap. The clock is the one that was right.
      ticks = @film_max_samples * 3

      assert {:report, text} =
               film_verdict(
                 :capped,
                 samples(@film_max_samples, 1_000),
                 ticks,
                 true,
                 @film_threshold_ms,
                 0
               )

      assert text =~ "FILM TRUNCATED"
      refute text =~ "TARGET GONE"
    end

    test "a starved filmer declares that its own split was read late" do
      # The stamp is taken when the filmer HANDLES the DOWN. A filmer that was
      # not scheduled reads the boundary late, so teardown is understated —
      # and a number that is quietly a lower bound is the same kind of lie the
      # rest of this pass removed.
      assert {:report, starved} =
               film_verdict(:starved, samples(1, 1_000), 1, true, @film_threshold_ms, 10)

      assert starved =~ "LOWER bound"

      assert {:report, fed} =
               film_verdict(
                 :fed,
                 samples(12, 1_000),
                 div(@film_threshold_ms, @film_interval_ms),
                 true,
                 @film_threshold_ms,
                 10
               )

      refute fed =~ "LOWER bound"
    end

    test "a target still alive when the film prints is said to be, not given a zero teardown" do
      # A missing stamp and a zero teardown are different facts, and printing
      # the second for the first is the same class of lie as the `(+0)`
      # derivative: a reader would place the whole wall clock in the body.
      assert {:report, text} =
               film_verdict(:alive, samples(3, 1_000), 40, true, @film_threshold_ms, nil)

      assert text =~ "STILL ALIVE"
      refute text =~ "teardown"
    end

    test "the printing door emits over the threshold and stays quiet under it" do
      filmer = spawn_filmer()
      Process.sleep(@film_interval_ms * 2)

      over = capture_io(fn -> print_film(filmer, :over, started_ms_ago(@film_threshold_ms)) end)
      under = capture_io(fn -> print_film(filmer, :under, started_ms_ago(0)) end)

      assert over =~ "#1767 FILM test=:over"
      assert under == ""

      Process.exit(filmer, :kill)
    end

    test "a filmer that cannot answer is reported as UNAVAILABLE, never as silence" do
      # The failure this file is built around is a test ExUnit KILLED. If the
      # filmer is gone too, the honest output is that there is no trajectory
      # — silence here would read exactly like a healthy run.
      dead = spawn(fn -> :ok end)
      ref = Process.monitor(dead)
      assert_receive {:DOWN, ^ref, :process, ^dead, :normal}, 5_000

      output = capture_io(fn -> print_film(dead, :gone, started_ms_ago(@film_threshold_ms)) end)

      assert output =~ "#1767 FILM UNAVAILABLE"
      assert output =~ "test=:gone"
    end

    test "a film longer than the printable window declares what it dropped" do
      # No silent caps: a window that quietly discards the middle of the
      # trajectory reads as a complete film of a shorter run.
      assert {:report, text} =
               film_verdict(
                 :long,
                 samples(@film_max_samples, 1_000),
                 @film_max_samples,
                 true,
                 @film_threshold_ms,
                 nil
               )

      assert text =~ "sample(s) omitted"
    end
  end

  ## ----- helpers --------------------------------------------------------

  # A run of samples derived from a REAL one, so every field carries the
  # shape `film_sample/1` actually produces rather than a hand-written
  # stand-in that could not fail the way the real thing does.
  defp samples(count, reductions_step) do
    base = film_sample(self())

    Enum.map(0..(count - 1), fn i ->
      %{base | at_ms: i * @film_interval_ms, reductions: base.reductions + i * reductions_step}
    end)
  end

  defp spawn_canary do
    me = self()
    canary = spawn(fn -> film_canary(me) end)

    receive do
      {:canary_parked, ^canary} -> canary
    after
      @film_answer_budget_ms -> flunk("the filmer canary never parked")
    end
  end

  # A filmer aimed at THIS process but without `start_filmer/1`'s `on_exit`
  # printing hook, so a test can drive the reel and assert on it directly.
  defp spawn_filmer do
    test_pid = self()
    spawn_filmer_at(test_pid)
  end

  # Aimed at a pid the caller chooses, so a test can point the reel at a
  # process it is about to KILL — the only way to buy the tick/sample split
  # against the real loop instead of against the pure verdict function.
  defp spawn_filmer_at(pid), do: spawn_film_loop(pid, true)

  # The monitor is established INSIDE the filmer, so the stamp belongs to the
  # process that reports it. An already-dead target answers `:noproc`
  # immediately, which stamps at once — the honest reading, not an error.
  defp spawn_film_loop(pid, sampler_ok?) do
    spawn(fn ->
      Process.monitor(pid)
      film_loop(pid, sampler_ok?, [], 0, nil)
    end)
  end

  defp ask_filmer(filmer) do
    send(filmer, {:film, self()})

    receive do
      {:film, _, _, _, _} = answer -> answer
    after
      @film_answer_budget_ms -> flunk("the filmer never answered")
    end
  end

  # `print_film/3` takes the START of the window rather than its length, so
  # that one clock reads both the whole span and the split inside it. A test
  # that wants a span of N therefore has to name a start, not a duration.
  defp started_ms_ago(ms), do: System.monotonic_time(:millisecond) - ms

  ## ----- the filmer (#1767) ---------------------------------------------

  # Unlinked on purpose: the film is worth most for a test ExUnit KILLS, and
  # a linked filmer would die with it carrying the only record of what
  # happened. The `on_exit` hook is the printing door rather than the filmer
  # itself, so the output is ordered with the runner instead of racing it,
  # and it runs for a killed test too.
  defp start_filmer(test_name) do
    test_pid = self()
    started_at = System.monotonic_time(:millisecond)
    filmer = spawn_film_loop(test_pid, film_sampler_ok?())

    on_exit(fn ->
      print_film(filmer, test_name, started_at)
      Process.exit(filmer, :kill)
    end)
  end

  # The known-answer control, INSIDE the tool and run in the filmer's own
  # process, so what it certifies is the sampler that will actually shoot.
  # A canary parked in a distinctively named function is the same oracle
  # `park_until_released/0` is for the holder-stack assertion above.
  defp film_sampler_ok? do
    me = self()
    canary = spawn(fn -> film_canary(me) end)

    ok? =
      receive do
        {:canary_parked, ^canary} -> sampler_reads_stack?(canary)
      after
        @film_answer_budget_ms -> false
      end

    Process.exit(canary, :kill)
    ok?
  end

  defp film_canary(parent) do
    send(parent, {:canary_parked, self()})

    receive do
      :never -> :ok
    end
  end

  defp sampler_reads_stack?(pid) do
    case film_sample(pid) do
      nil -> false
      %{stack: stack} -> Enum.any?(stack, &match?({__MODULE__, :film_canary, _, _}, &1))
    end
  end

  # Answering does NOT end the reel. A filmer that died on its first answer
  # would turn any second read into `FILM UNAVAILABLE` — an honest message
  # about the wrong thing, and the exact shape of report this issue is
  # trying to stop producing.
  # 🔴 `ticks` and `samples` COUNT DIFFERENT THINGS, and conflating them is
  # what made this filmer lie (#1767, second pass). A tick is the filmer being
  # SCHEDULED; a sample is the tick finding the target ALIVE. They diverge for
  # a reason that has nothing to do with the VM: ExUnit runs `on_exit` in a
  # SEPARATE process, so from the moment the test body ends the target pid is
  # dead, `Process.info/2` answers nil and `film_collect/2` can only return the
  # accumulator unchanged. Every tick of the teardown is therefore uncollectable
  # BY CONSTRUCTION.
  #
  # Measured on a QUIET host with a GREEN suite: a test whose body costs 132.8ms
  # (`--trace`) reported `1 collected / 218 expected` over 54718ms and printed
  # "the VM was not scheduling the FILMER either", which was false. Counting the
  # filmer's own turns is the only way to say anything true about the filmer.
  #
  # 🔴 THE STAMP IS A THIRD THING AGAIN, AND IT IS A CLOCK RATHER THAN A COUNT.
  # `TARGET GONE` can say the time was spent outside the body, because a tick
  # that finds nothing alive proves the target was gone. It cannot say HOW
  # MUCH, because a ratio of ticks to samples is not a duration. The DOWN
  # stamp is: subtracted from the window's start it gives setup+body, and the
  # remainder is teardown. That is the split the 54718ms reading needed and
  # did not have — a number nobody could place is a number nobody can act on.
  defp film_loop(test_pid, sampler_ok?, samples, ticks, down_at) do
    receive do
      {:film, from} ->
        send(from, {:film, sampler_ok?, Enum.reverse(samples), ticks, down_at})
        film_loop(test_pid, sampler_ok?, samples, ticks, down_at)

      {:DOWN, _, :process, ^test_pid, _} ->
        film_loop(test_pid, sampler_ok?, samples, ticks, System.monotonic_time(:millisecond))
    after
      @film_interval_ms ->
        film_loop(test_pid, sampler_ok?, film_collect(test_pid, samples), ticks + 1, down_at)
    end
  end

  defp film_collect(test_pid, samples) do
    cond do
      length(samples) >= @film_max_samples -> samples
      sample = film_sample(test_pid) -> [sample | samples]
      true -> samples
    end
  end

  # `reductions` is the field the seven reds were missing. `status` alone
  # cannot separate "blocked in a call" from "never scheduled": both read
  # `:running` often enough to be useless. Reductions are monotonic and
  # local, so their DERIVATIVE answers it.
  defp film_sample(pid) do
    case Process.info(pid, [:status, :reductions, :current_function, :current_stacktrace]) do
      nil ->
        nil

      info ->
        %{
          at_ms: System.monotonic_time(:millisecond),
          status: Keyword.get(info, :status),
          reductions: Keyword.get(info, :reductions),
          current_function: Keyword.get(info, :current_function),
          stack: info |> Keyword.get(:current_stacktrace, []) |> Enum.take(@film_stack_frames)
        }
    end
  end

  # Takes the START of the window, never a precomputed length: the split below
  # and the total have to come off ONE clock, or they can disagree.
  defp print_film(filmer, test_name, started_at) do
    send(filmer, {:film, self()})

    receive do
      {:film, sampler_ok?, samples, ticks, down_at} ->
        elapsed_ms = System.monotonic_time(:millisecond) - started_at
        body_ms = down_at && down_at - started_at

        emit_film(film_verdict(test_name, samples, ticks, sampler_ok?, elapsed_ms, body_ms))
    after
      @film_answer_budget_ms ->
        IO.puts(
          "#1767 FILM UNAVAILABLE: test=#{inspect(test_name)} " <>
            "elapsed=#{System.monotonic_time(:millisecond) - started_at}ms — the filmer " <>
            "did not answer within #{@film_answer_budget_ms}ms, so this run has NO trajectory"
        )
    end
  end

  defp emit_film(:silent), do: :ok
  defp emit_film({:report, text}), do: IO.puts(text)

  # Pure, so every branch below is a test above rather than something only a
  # real 60s red could exercise.
  defp film_verdict(test_name, _, _, false, elapsed_ms, _) do
    {:report,
     "#1767 FILM SAMPLER BROKEN: test=#{inspect(test_name)} elapsed=#{elapsed_ms}ms — the canary's own " <>
       "frame was absent from the stack the sampler read, so NO film is produced: a plausible " <>
       "trajectory from a sampler that cannot read a stack would be believed"}
  end

  defp film_verdict(_, _, _, true, elapsed_ms, _) when elapsed_ms < @film_threshold_ms do
    :silent
  end

  defp film_verdict(test_name, [], ticks, true, elapsed_ms, body_ms) do
    {:report,
     "#1767 FILM NO SAMPLES: test=#{inspect(test_name)} elapsed=#{elapsed_ms}ms over a #{@film_interval_ms}ms " <>
       "tick — the filmer was alive and collected nothing, which is a reading about the VM, not an idle test" <>
       "\n" <> clock_split_line(elapsed_ms, body_ms, starved?(ticks, div(elapsed_ms, @film_interval_ms)))}
  end

  defp film_verdict(test_name, samples, ticks, true, elapsed_ms, body_ms) do
    collected = length(samples)
    expected = div(elapsed_ms, @film_interval_ms)

    lines =
      [
        "#1767 FILM test=#{inspect(test_name)} elapsed=#{elapsed_ms}ms threshold=#{@film_threshold_ms}ms",
        clock_split_line(elapsed_ms, body_ms, starved?(ticks, expected)),
        "  ticks: #{ticks} taken / #{expected} due at #{@film_interval_ms}ms  (filmer scheduling)",
        "  samples: #{collected} collected of those #{ticks} ticks  (target alive)",
        reductions_line(samples),
        starved_line(ticks, expected),
        target_gone_line(collected, ticks),
        frozen_line(samples, elapsed_ms),
        truncated_line(collected)
      ] ++ film_frames(samples, hd(samples).at_ms)

    {:report, lines |> Enum.reject(&(&1 == "")) |> Enum.join("\n")}
  end

  # The whole point of the DOWN stamp, rendered. Without a stamp the target
  # outlived the film, so there IS no teardown to name and saying `teardown
  # 0ms` would put the entire wall clock in the body — a reader would go
  # looking for a slow assertion that does not exist.
  defp clock_split_line(_, nil, _) do
    "  clock: the target was STILL ALIVE when the film printed — no split available"
  end

  # 🔴 THE STAMP IS TAKEN WHEN THE FILMER HANDLES THE DOWN, NOT WHEN IT
  # ARRIVES, so a starved filmer reads the boundary LATE: setup+body comes out
  # too big and teardown too small, by however long the filmer sat unscheduled
  # with the message already in its mailbox. There is no in-VM clock that
  # escapes this — a stall wide enough to starve the filmer starves whatever
  # would time it — so the bias is DECLARED rather than engineered away. Under
  # starvation the split is a lower bound on teardown, and saying so is the
  # difference between a measurement and a number.
  defp clock_split_line(elapsed_ms, body_ms, starved?) do
    caveat =
      if starved?,
        do: " — the filmer was starved, so this boundary was read LATE: teardown is a LOWER bound",
        else: ""

    "  clock: setup+body #{body_ms}ms | teardown #{elapsed_ms - body_ms}ms  " <>
      "(ExUnit runs on_exit in another process, so only the first half is the test)" <> caveat
  end

  # One predicate, so the caveat above and the STARVED line below can never
  # disagree about whether the filmer got its turns.
  defp starved?(ticks, expected), do: ticks * 2 < expected

  # 🔴 A DERIVATIVE NEEDS TWO POINTS. With one sample `hd` and `List.last` are
  # the SAME element, so the old unconditional line printed `X -> X (+0)` — a
  # value differenced against itself, rendered in the exact notation a reader
  # uses for "this process ran no code". The registered diagnosis of #1767
  # rested on one of those, and a green quiet-host run of this very file
  # produced `reductions: 9255 -> 9255 (+0)` from a single sample.
  defp reductions_line([_]), do: "  reductions: one sample — no delta (a derivative needs two)"

  defp reductions_line(samples) do
    advanced = List.last(samples).reductions - hd(samples).reductions

    "  reductions: #{hd(samples).reductions} -> #{List.last(samples).reductions} (+#{advanced})"
  end

  # The filmer missing its OWN TURNS is a reading about the VM. Counted from
  # the ticks the loop actually took, never from the samples it managed to
  # collect: a tick that finds the target dead is not a missed tick, and
  # measuring the second while claiming the first is what made this line fire
  # on a quiet host during a passing test.
  defp starved_line(ticks, expected) do
    if starved?(ticks, expected) do
      "  ⚠ SAMPLER STARVED: the filmer took #{ticks} of #{expected} turns it was due — " <>
        "the VM was not scheduling the FILMER either, so this is not only the test"
    else
      ""
    end
  end

  # The other half of the split, and the common case: the filmer was scheduled
  # fine and found nothing to sample because the test process was already gone.
  # That is a statement about WHERE the wall-clock went — setup and teardown
  # rather than the body — and it is the opposite of a VM reading.
  # 🔴 TRUNCATION IS NOT ABSENCE, and it took the clock above to notice.
  # `film_collect/2` stops appending at `@film_max_samples`, so past the cap
  # every further tick collects nothing — for a target that is alive and
  # working. The ratio below cannot tell that apart from a dead one, and past
  # `2 * @film_max_samples` ticks it fires unconditionally. Measured: a real
  # 129406ms run reported `TARGET GONE for 257 of 507 ticks` while the same
  # report's split read `teardown 15ms`. The two lines contradicted each other
  # and the ratio was the one that was wrong.
  defp target_gone_line(collected, _) when collected >= @film_max_samples, do: ""

  defp target_gone_line(collected, ticks) when collected * 2 < ticks do
    "  ⚠ TARGET GONE for #{ticks - collected} of #{ticks} ticks — the test process was not alive " <>
      "to be sampled, so that time is OUTSIDE the test body (ExUnit runs on_exit in another process)"
  end

  defp target_gone_line(_, _), do: ""

  # Takes the SAMPLES, not a precomputed delta: the guard that keeps this
  # honest (two points or nothing) then cannot be satisfied by a caller that
  # computed the delta wrongly, which is exactly how the `(+0)` above survived.
  defp frozen_line([_ | _] = samples, elapsed_ms) when length(samples) > 1 do
    collected = length(samples)

    case List.last(samples).reductions - hd(samples).reductions do
      0 ->
        "  ⚠ REDUCTIONS DID NOT ADVANCE across #{collected} samples spanning #{elapsed_ms}ms — the test " <>
          "process ran no code at all, so any frame below is where it STOPPED, not where it is working"

      _ ->
        ""
    end
  end

  defp frozen_line(_, _), do: ""

  defp truncated_line(collected) when collected >= @film_max_samples do
    "  ⚠ FILM TRUNCATED: the filmer stopped collecting at #{@film_max_samples} samples"
  end

  defp truncated_line(_), do: ""

  # A window, declared. Printing 250 lines per slow test buries the report
  # it exists to deliver, and dropping the middle silently would read as a
  # complete film of a shorter run.
  defp film_frames(samples, origin_ms) when length(samples) <= 25 do
    Enum.map(samples, &film_frame(&1, origin_ms))
  end

  defp film_frames(samples, origin_ms) do
    {head, rest} = Enum.split(samples, 5)
    tail = Enum.take(rest, -20)
    omitted = length(samples) - length(head) - length(tail)

    Enum.map(head, &film_frame(&1, origin_ms)) ++
      ["  ... #{omitted} sample(s) omitted ..."] ++ Enum.map(tail, &film_frame(&1, origin_ms))
  end

  # `t` is relative to the FIRST sample. A raw monotonic reading is a
  # 12-digit negative number that says nothing about a trajectory.
  defp film_frame(sample, origin_ms) do
    top =
      Enum.map_join(sample.stack, " <- ", &(&1 |> Exception.format_stacktrace_entry() |> String.trim()))

    "  t=#{sample.at_ms - origin_ms}ms #{sample.status} reds=#{sample.reductions} " <>
      "#{format_current(sample.current_function)} | #{top}"
  end

  defp format_current({m, f, a}), do: Exception.format_mfa(m, f, a)
  defp format_current(_), do: "unknown"

  # Drives the REAL `init/1` — the only way to prove the priming is wired
  # into it rather than merely available as a function. Calling `init/1`
  # directly is not an option: it creates a `:named_table`, which the live
  # child already owns.
  #
  # A child left stopped would poison every test after this one, so the
  # restore is registered BEFORE the terminate, and tolerates the child
  # already running — the happy path restarts it here, in the test body,
  # where a failure is attributable.
  defp restart_lock_watch do
    on_exit(fn ->
      case Supervisor.restart_child(Grappa.Supervisor, LockWatch) do
        {:ok, _} -> :ok
        {:error, :running} -> :ok
      end
    end)

    :ok = Supervisor.terminate_child(Grappa.Supervisor, LockWatch)
    {:ok, _} = Supervisor.restart_child(Grappa.Supervisor, LockWatch)

    :ok
  end

  defp start_tmp_repo do
    path = Path.join(System.tmp_dir!(), "lock_watch_#{System.unique_integer([:positive])}.db")
    on_exit(fn -> Enum.each(["", "-wal", "-shm"], &File.rm(path <> &1)) end)

    # busy_timeout is the waiter's whole life: it must still be WAITING when
    # the scan runs, and a short timeout would turn it into an error path and
    # measure `BusyRetry` instead of this module. The value is DERIVED from the
    # test deadline rather than chosen — see `@waiter_budget_ms` for why the
    # two clocks have to be ordered and what a mis-order looks like.
    #
    # It is NOT the only wait on that writer, and on its own it does not
    # govern — see `observed_write/3`.
    {:ok, repo} =
      TmpRepo.start_link(
        database: path,
        pool_size: 2,
        busy_timeout: @waiter_budget_ms,
        journal_mode: :wal
      )

    TmpRepo.query!("CREATE TABLE t(id integer)")

    repo
  end

  # A writer that goes through the SAME `LockWatch.observe/1` production
  # uses — re-implementing the edge sequence here would test a copy of the
  # mechanism rather than the mechanism.
  defp start_writer(id, after_insert) do
    test_pid = self()

    {pid, ref} = spawn_monitor(fn -> observed_write(id, after_insert, test_pid) end)

    # A failing assertion would otherwise leave this process parked inside
    # its transaction, holding both the file lock and a watch-table row, and
    # poison every test that follows.
    on_exit(fn -> Process.exit(pid, :kill) end)

    {pid, ref}
  end

  # Split out of `start_writer/2` so no body nests deeper than two levels.
  # `observe/1` is production's own wrapper — the point is that the test
  # drives the real edge sequence rather than a hand-written copy of it.
  #
  # 🔴 `timeout: :infinity` is load-bearing, and it is what makes
  # `start_tmp_repo/0`'s `busy_timeout: @waiter_budget_ms` mean what that
  # comment says it means. Without it both writers inherit Ecto's DEFAULT
  # `:timeout` of 15_000 (`ecto_sql/lib/ecto/adapters/sql.ex`), which
  # DBConnection arms as a checkout deadline covering the WHOLE transaction
  # — queue, statements and the holder's park alike. So the real wait was
  # `min(15_000, the budget)` — cited by anchor because #1687 moved that
  # budget off its literal and the number here would have rotted with it —
  # the smaller number was never written down anywhere, and once a loaded
  # runner pushed the window past 15s the pool disconnected BOTH
  # connections: the parked holder mid-park, and the waiter mid-`BEGIN
  # IMMEDIATE`. exqlite's busy handler answers a cancellation with plain
  # SQLITE_BUSY, so the waiter died `%Exqlite.Error{message: "database is
  # locked"}` instead of exiting `:normal` — a red naming this file's
  # waiter assertion, on a machine slow enough, with nothing in the source
  # to point at. #1657b measured that ordering (deadline caps busy_timeout,
  # and the cap is invisible by error CLASS); this is the same finding
  # landing on the harness that assumed otherwise.
  #
  # Measured, on `29bea21d` with a 16s delay injected before the release:
  # without this option the waiter dies `database is locked` and the
  # waiter-DOWN assertion fails; with it, 4 tests / 0 failures, assertions
  # untouched. `busy_timeout` is now the only wait bounding the waiter,
  # which is what this file was always documented to be testing.
  defp observed_write(id, after_insert, test_pid) do
    LockWatch.observe(fn acquired ->
      TmpRepo.transaction(fn -> insert_then(id, after_insert, test_pid, acquired) end,
        mode: :immediate,
        timeout: :infinity
      )
    end)
  end

  # #1687 — a writer that takes RESERVED WITHOUT going through
  # `LockWatch.observe/1`: it holds the file lock and owns no row in the watch
  # table. That is the production blindness in person.
  #
  # Honest limit, and it is why this is not literally `TmpRepo.insert/2`: the
  # production writer is a bare autocommit statement
  # (`Scrollback.persist_row/1` -> `Repo.insert/2`,
  # `lib/grappa/scrollback.ex:227`), and an autocommit statement cannot be
  # held open from outside — it commits the moment it returns, so it cannot be
  # parked while a second writer queues behind it. An un-observed
  # `mode: :immediate` transaction CAN be parked, and the state `detect/2`
  # actually reads is byte-identical between the two: RESERVED held, zero rows
  # in the watch table. This harness reproduces the OBSERVABLE state, not the
  # statement shape.
  defp start_unobserved_writer(id) do
    test_pid = self()

    {pid, ref} = spawn_monitor(fn -> unobserved_write(id, test_pid) end)

    on_exit(fn -> Process.exit(pid, :kill) end)

    {pid, ref}
  end

  # `timeout: :infinity` for the same reason `observed_write/3` carries it —
  # see the 🔴 note there. Without it the park is capped at Ecto's default
  # 15_000 checkout deadline rather than by this test's own release message.
  defp unobserved_write(id, test_pid) do
    TmpRepo.transaction(
      fn ->
        TmpRepo.query!("INSERT INTO t VALUES (?)", [id])
        send(test_pid, {:holding, self()})
        park_until_released()
      end,
      mode: :immediate,
      timeout: :infinity
    )
  end

  defp insert_then(id, after_insert, test_pid, acquired) do
    acquired.()
    TmpRepo.query!("INSERT INTO t VALUES (?)", [id])
    send(test_pid, {:holding, self()})
    if after_insert == :park, do: park_until_released()
  end

  # Named, and named distinctively, because its frame IS the oracle for the
  # holder-stack assertion.
  defp park_until_released do
    receive do
      :release -> :ok
    end
  end

  # #1888 — a NAMED write path, so the bracket has a caller frame to name.
  #
  # 🔴 The trailing tuple is load-bearing and not decoration: with
  # `observe/1` in tail position the BEAM elides this function's frame
  # entirely, and the stack the bracket captures starts at
  # `Task.Supervised.invoke_mfa/2` — measured, first cut of this test. A
  # non-tail call keeps the frame, which is what makes "the head of the stack
  # is the write path" assertable at all.
  defp hold_and_return do
    result = LockWatch.observe(fn acquired -> acquired.() end)
    {:held, result}
  end

  # #1888 — a process parked inside `observe/1` BEFORE it reaches `acquired`,
  # i.e. a genuine `:waiting` row, which is the second half `report_stalls/2`
  # requires. It touches no SQLite: those tests measure the CLOSING bracket,
  # and the real `RESERVED` acquisition is what the TmpRepo tests above buy.
  #
  # The pid comes back so the caller can release it INSIDE the same test. This
  # file is `async: false` but its tests share one ETS table, so a waiter left
  # parked would queue itself behind the next test's holder and turn an
  # unattributed assertion into an attributed one at a distance.
  defp queue_a_waiter do
    pid = spawn(fn -> LockWatch.observe(fn _ -> park_until_released() end) end)

    await_roles(nil, [pid])
    pid
  end

  # Released and AWAITED, not just signalled: the row is deleted by the
  # waiter's own `released/0`, so returning before it has run would leak the
  # very row the helper exists to clean up.
  defp release_waiter(pid) do
    ref = Process.monitor(pid)
    send(pid, :release)

    assert_receive {:DOWN, ^ref, :process, ^pid, _}
    await_roles(nil, [])
  end

  # `holder` is `nil` for the #1687 topology — a queue whose holder owns no
  # row, so the barrier is "holders is EMPTY and these pids are queued".
  # Reads the PID-ONLY projection, not `inspect_lock/0`: this predicate
  # compares pid lists and discards everything else, while `inspect_lock/0`
  # runs `Process.info/2` plus twelve frames through
  # `Exception.format_stacktrace_entry/1` per process, on every turn (#1747).
  defp await_roles(holder, waiters) do
    await_until(
      fn ->
        %{holders: held, waiters: queued} = LockWatch.lock_roles()

        held == expected_holders(holder) and Enum.sort(queued) == Enum.sort(waiters)
      end,
      @barrier_budget_ms
    )
  end

  defp expected_holders(nil), do: []
  defp expected_holders(holder), do: [holder]

  # #1901 — the census barrier. A writer reaches `Exqlite.Sqlite3NIF` a
  # scheduling moment AFTER it is spawned, and `start_unobserved_writer/1`
  # cannot send a "now blocked" message: the whole point of that fixture is
  # that it is stuck before its first statement runs. So the condition is
  # polled on the ONE fact the census itself reads, and on the same wall-clock
  # budget as `await_roles/2` — see `@barrier_budget_ms` for why an attempt
  # count is not a budget.
  #
  # The `flunk` names the function it DID find, because the two ways this can
  # fail read identically from the outside: a runner too slow to schedule the
  # writer at all, and a writer that reached SQLite by some path that does not
  # park in the NIF. Only the observed frame separates them.
  # The one-line `match?` is a FIXTURE PRECONDITION, not a copy of the logic
  # under test: it asserts this writer reached the state the census exists to
  # find. The census's own predicate runs over `Process.list/0` and is what the
  # assertions in the body buy.
  defp await_parked_in_nif(pid) do
    await_until(
      fn -> match?({:current_function, {Exqlite.Sqlite3NIF, _, _}}, Process.info(pid, :current_function)) end,
      @barrier_budget_ms
    )
  rescue
    error in ExUnit.AssertionError ->
      flunk("#{error.message} — #{inspect(pid)} is at #{inspect(Process.info(pid, :current_function))}")
  end

  defp pids(samples), do: Enum.map(samples, & &1.pid)

  # A WALL CLOCK. See `@barrier_budget_ms` for why an attempt count was not
  # one. The full `inspect_lock/0` is paid HERE and only here — on the failure
  # path, where the stacktraces are the diagnosis rather than overhead.
  defp await_until(fun, budget_ms) do
    await_until(fun, budget_ms, System.monotonic_time(:millisecond) + budget_ms)
  end

  defp await_until(fun, budget_ms, deadline) do
    cond do
      fun.() ->
        :ok

      System.monotonic_time(:millisecond) >= deadline ->
        flunk("condition never held within #{budget_ms}ms: #{inspect(LockWatch.inspect_lock())}")

      true ->
        Process.sleep(10)
        await_until(fun, budget_ms, deadline)
    end
  end
end
