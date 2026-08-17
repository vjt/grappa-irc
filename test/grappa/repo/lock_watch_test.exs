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

  alias Grappa.Repo.LockWatch

  defmodule TmpRepo do
    @moduledoc false
    use Ecto.Repo, otp_app: :grappa, adapter: Ecto.Adapters.SQLite3
  end

  @detected [:grappa, :repo, :lock_stall, :detected]

  setup do
    LockWatch.put_test_enabled(true)
    on_exit(fn -> LockWatch.put_test_enabled(false) end)

    handler = "lock-watch-test-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach(
        handler,
        @detected,
        fn _event, measurements, metadata, _ ->
          send(test_pid, {:stall, measurements, metadata})
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

  ## ----- helpers --------------------------------------------------------

  defp start_tmp_repo do
    path = Path.join(System.tmp_dir!(), "lock_watch_#{System.unique_integer([:positive])}.db")
    on_exit(fn -> Enum.each(["", "-wal", "-shm"], &File.rm(path <> &1)) end)

    # busy_timeout is generous on purpose: the waiter must still be WAITING
    # when the scan runs. A short timeout would turn it into an error path
    # and measure `BusyRetry` instead of this module.
    {:ok, repo} =
      TmpRepo.start_link(database: path, pool_size: 2, busy_timeout: 30_000, journal_mode: :wal)

    TmpRepo.query!("CREATE TABLE t(id integer)")

    repo
  end

  # A writer that goes through the SAME `LockWatch.observe/1` production
  # uses — re-implementing the edge sequence here would test a copy of the
  # mechanism rather than the mechanism.
  defp start_writer(id, after_insert) do
    test_pid = self()

    {pid, ref} =
      spawn_monitor(fn ->
        LockWatch.observe(fn acquired ->
          TmpRepo.transaction(
            fn ->
              acquired.()
              TmpRepo.query!("INSERT INTO t VALUES (#{id})")
              send(test_pid, {:holding, self()})
              if after_insert == :park, do: park_until_released()
            end,
            mode: :immediate
          )
        end)
      end)

    # A failing assertion would otherwise leave this process parked inside
    # its transaction, holding both the file lock and a watch-table row, and
    # poison every test that follows.
    on_exit(fn -> Process.exit(pid, :kill) end)

    {pid, ref}
  end

  # Named, and named distinctively, because its frame IS the oracle for the
  # holder-stack assertion.
  defp park_until_released do
    receive do
      :release -> :ok
    end
  end

  defp await_roles(holder, waiters) do
    await_until(
      fn ->
        %{holders: held, waiters: queued} = LockWatch.inspect_lock()

        pids(held) == [inspect(holder)] and Enum.sort(pids(queued)) == Enum.sort(Enum.map(waiters, &inspect/1))
      end,
      300
    )
  end

  defp pids(samples), do: Enum.map(samples, & &1.pid)

  defp await_until(_fun, 0), do: flunk("condition never held: #{inspect(LockWatch.inspect_lock())}")

  defp await_until(fun, attempts) do
    if fun.() do
      :ok
    else
      Process.sleep(10)
      await_until(fun, attempts - 1)
    end
  end
end
