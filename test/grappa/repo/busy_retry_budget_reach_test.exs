defmodule Grappa.Repo.BusyRetryBudgetReachTest do
  @moduledoc """
  #1421 — how far the `Grappa.Repo.BusyRetry` retry BUDGET actually reaches,
  measured against a REAL driver `SQLITE_BUSY` rather than a hand-built one.

  ## Why the engine's own suite could not see this

  Every other retry test raises a `%Exqlite.Error{}` WE build, from a
  zero-cost closure. The fault is therefore FREE, and the budget is the only
  thing bounding the loop — which is exactly the regime in which the budget
  looks like it works. Reality charges for the fault: a contending write sits
  inside SQLite's `busy_timeout` before it raises at all.

  The budget is a deadline consulted BETWEEN attempts (`busy_retry.ex`, the
  `System.monotonic_time(:millisecond) < deadline` arm), so it cannot preempt
  an attempt that is already running. Whichever of the two numbers is larger
  decides how many attempts there are — and nothing in the engine can change
  that, because the engine does not own the wait.

  ## What this file measures

  The SAME engine and the SAME budget, varying ONLY `busy_timeout`, over a
  real write-lock contention on a private temp repo (the `pool_size: 1`
  Sandbox cannot contend with itself, which is why the injection seam exists
  in the first place):

    * `busy_timeout` ABOVE the budget → exactly ONE attempt. Production runs
      `30_000` against `1_500`, a ratio of 20; this runs 2, and the collapse
      is a property of the ratio, not of the magnitudes.
    * `busy_timeout` BELOW the budget → many attempts. This is the regime the
      budget was dimensioned for (#340, `config/config.exs`: *"comfortably
      longer than the ~1s pool-saturation window the #336 incident
      measured"*) — a pool `queue_timeout`, whose drop latency DBConnection
      caps near `queue_target` (50 ms doubled to 100 ms by default).

  Tests 1 and 2 are a MEASUREMENT of the status quo and pass on unmodified
  main; they are load-bearing because a mutation of the deadline arm turns
  them red, not because they started red. Test 3 is the one that starts red:
  the terminal line reports the budget it was told instead of the wait it
  observed.
  """
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Grappa.Repo.BusyRetry

  defmodule TmpRepo do
    use Ecto.Repo, otp_app: :grappa, adapter: Ecto.Adapters.SQLite3
  end

  # The very number the engine compiled itself with — never a literal here, or
  # the bench and the engine can drift apart while both stay green.
  @budget_ms Application.compile_env(:grappa, [:busy_retry, :budget_ms], 1_500)

  # Runs one genuinely contended write through the engine and reports what was
  # OBSERVED: the engine's return, the fault kind, the terminal attempt count,
  # the caller's own wall-clock, and the log it emitted. `busy_timeout` is the
  # single independent variable.
  defp measure_contended_write(busy_timeout) do
    path =
      Path.join(System.tmp_dir!(), "busy_retry_budget_#{System.unique_integer([:positive])}.db")

    on_exit(fn -> Enum.each(["", "-wal", "-shm"], &File.rm(path <> &1)) end)

    {:ok, repo} =
      TmpRepo.start_link(
        database: path,
        pool_size: 1,
        busy_timeout: busy_timeout,
        journal_mode: :wal
      )

    TmpRepo.query!("CREATE TABLE t(id integer)")

    # A SEPARATE raw connection holds the file write-lock for the WHOLE
    # measurement, so every attempt the engine makes genuinely contends. Its
    # own busy_timeout is 0 so setting up the hold can never itself wait.
    {:ok, holder} = Exqlite.Sqlite3.open(path)
    :ok = Exqlite.Sqlite3.execute(holder, "PRAGMA busy_timeout=0")
    :ok = Exqlite.Sqlite3.execute(holder, "BEGIN IMMEDIATE")
    :ok = Exqlite.Sqlite3.execute(holder, "INSERT INTO t VALUES (1)")

    {:ok, seen} = Agent.start_link(fn -> [] end)

    started = System.monotonic_time(:millisecond)

    {result, log} =
      with_log(fn ->
        BusyRetry.run(fn -> {:ok, TmpRepo.query!("INSERT INTO t VALUES (2)")} end,
          on_contention: fn kind, attempt, terminal? ->
            Agent.update(seen, &[{kind, attempt, terminal?} | &1])
          end
        )
      end)

    elapsed_ms = System.monotonic_time(:millisecond) - started
    events = Agent.get(seen, &Enum.reverse(&1))

    # Teardown BEFORE any assertion runs, so a red leaves no repo and no held
    # write-lock behind for the next test in this serial file.
    :ok = Exqlite.Sqlite3.close(holder)
    Supervisor.stop(repo)

    {kind, terminal_attempt, true} = List.last(events)

    %{result: result, kind: kind, attempts: terminal_attempt, elapsed_ms: elapsed_ms, log: log}
  end

  # The terminal line, isolated from whatever else Logger carried during the
  # capture.
  defp terminal_line(log) do
    log |> String.split("\n") |> Enum.find("", &(&1 =~ "db write unavailable"))
  end

  # The wall-clock the terminal line CLAIMS, read back out of the line itself.
  # `nil` when it claims none — which is the state test 3 starts in.
  defp reported_wait_ms(log) do
    case Regex.run(~r/db write unavailable:.* for (\d+)ms/, terminal_line(log)) do
      [_, ms] -> String.to_integer(ms)
      nil -> nil
    end
  end

  describe "the budget's reach against a REAL write-lock contention" do
    test "a busy_timeout ABOVE the budget collapses the loop to exactly ONE attempt" do
      busy_timeout = @budget_ms * 2

      observed = measure_contended_write(busy_timeout)

      assert observed.result == {:error, :db_unavailable}
      assert observed.kind == :busy_locked

      # THE defect #1421 names: at this ratio the linear backoff and every
      # attempt after the first are unreachable BY CONSTRUCTION.
      assert observed.attempts == 1

      # ...and the caller waited the busy_timeout, not the budget it was told.
      assert observed.elapsed_ms >= busy_timeout
    end

    test "a busy_timeout BELOW the budget makes the retry loop reachable — many attempts" do
      # The positive control for the loop itself: same engine, same budget,
      # only the fault got cheap. If THIS one collapsed to a single attempt
      # too, the finding above would be about the engine and not about the
      # relationship between the two numbers.
      observed = measure_contended_write(0)

      assert observed.result == {:error, :db_unavailable}
      assert observed.kind == :busy_locked
      assert observed.attempts > 1
      assert observed.elapsed_ms >= @budget_ms
    end
  end

  describe "the terminal line reports the wait it OBSERVED (CLAUDE.md log honesty)" do
    test "it names the elapsed wall-clock, never a budget that did not bound it" do
      busy_timeout = @budget_ms * 2

      observed = measure_contended_write(busy_timeout)
      line = terminal_line(observed.log)

      # The premise of the assertion below: this IS the one-attempt regime.
      assert observed.attempts == 1

      # The line must carry the wait that happened. `is_integer/1` FIRST and
      # separately: Elixir's term order puts every atom above every number, so
      # a `nil >= 600` from a line with no elapsed at all is `true` and the
      # comparison alone passes vacuously. Measured — the first red run of
      # this file failed only on the refute below, with `reported_wait_ms/1`
      # returning nil.
      reported = reported_wait_ms(observed.log)
      assert is_integer(reported), "the terminal line carries no elapsed at all: #{line}"
      assert reported >= busy_timeout

      # ...and must not go on claiming the budget was what ran out, when the
      # budget was overshot by the first attempt on its own.
      refute line =~ "for the full #{@budget_ms}ms retry budget"
    end
  end
end
