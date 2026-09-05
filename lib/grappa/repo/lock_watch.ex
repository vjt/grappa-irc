defmodule Grappa.Repo.LockWatch do
  @moduledoc """
  Holder-vs-waiter observer for SQLite's single write lock (#1420).

  ## Why a new signal, and not another handler on the old ones

  Every DB signal grappa already emits is **completion-driven**, so all of
  them measure the VICTIM by construction:

    * `[:grappa, :repo, :query]` fires when a query FINISHES. A process that
      opens `BEGIN IMMEDIATE` and then sits still emits nothing at all while
      it sits; the only rows that reach the log are the 30-second `begin`s
      and `SELECT`s of everybody stuck BEHIND it.
    * `Grappa.Repo.BusyRetry`'s `:on_contention` hook fires inside a
      `rescue` — it counts, by definition, whoever caught the exception.
    * The #1429 CI census greps container logs after the fact: it sees the
      silence, never who caused it.

  The #1420 census hit that wall six times: `db30=4`, `dropped=2`,
  `saturated=2`, every gap exactly 30.1 s (the `busy_timeout: 30_000` of the
  WAITERS), and the issue's own "Not established" section names the missing
  datum — *"why the holder itself pauses [...] separating the two needs a
  running stack."*

  This module produces that running stack.

  ## The state machine

  `Grappa.Repo.immediate_transaction/1` is the ONLY producer of
  `BEGIN IMMEDIATE` in the tree, so there is exactly one seam to instrument.

  The split is free because of an ordering READ IN THE DEPENDENCIES, not
  assumed: `DBConnection.transaction/3` evaluates `begin/3` and only enters
  `run_transaction/5` on `{:ok, _}` (`db_connection.ex:1103-1107`), and
  `Exqlite.Connection.handle_begin/2` emits `"BEGIN IMMEDIATE TRANSACTION"`
  for `mode: :immediate` on an idle connection (`connection.ex:307`). So by
  the time the transaction fun runs, SQLite has already granted `RESERVED`:

      waiting()   -->  inside the `begin`, lock NOT yet held  ==> WAITER
      acquired()  -->  first statement of the fun, RESERVED held  ==> HOLDER
      released()  -->  transaction over

  The same reading gives the failure case for free: when `begin` raises
  (busy past `busy_timeout`) the fun never runs, so `acquired/0` never
  fires and a writer that timed out is never mislabelled a holder — the
  `after` simply drops its waiter row.

  It also gives the nesting case: on a connection already in a transaction,
  `handle_begin/2` emits `SAVEPOINT` instead (`connection.ex:310-315`),
  which is why the depth counter below exists — an inner release must not
  erase an outer holder.

  A waiter is a waiter whether it is blocked on SQLite's `busy_timeout` or
  queued on a DBConnection checkout — the two candidate topologies #1420
  names. Its sampled stack says which, so the instrument does not have to
  guess between them.

  ## What it reports, and when

  A watchdog tick scans the table and reports a NAMED stall only when a
  holder has held for at least `stall_threshold_ms` **AND at least one
  waiter is queued behind it**. A slow-but-uncontended transaction is not a
  stall, and reporting one would bury the signal it exists to find.

  ### The unattributed arm (#1687)

  A queue past the threshold that named nobody is reported too, as its own
  line. This arm exists because the first one is blind by construction:
  `observe/1` has a single producer, so ONLY a writer that went through
  `Grappa.Repo.immediate_transaction/1` can ever be tagged `:holding`. Every
  autocommit single-statement write — `Grappa.Scrollback.persist_row/1`
  (`lib/grappa/scrollback.ex:227`) and its ~120 peers — takes the same file
  lock and owns no row here at all.

  This code used to answer that case with silence, on the reasoning that
  *"waiters with no holder are the pool's business, not the write lock's."*
  🔴 **Measured in prod on 2026-08-22 (grappa 1.3.1, `erlang.log.5`), that
  reasoning was half right and the conclusion was wrong.** Half right: the
  pool IS a real component — victims' `elapsed` decomposes as ~31 s of
  DBConnection checkout plus ~31 s of `busy_timeout`, which is the whole of
  the "62 s" that opened #1687. Wrong: through a ~170 s episode, with this
  observer ARMED at `stall_threshold_ms: 2_000` and 23 `busy_locked`
  terminals in the log, it emitted **zero** lines. A long unattributed stall
  was indistinguishable from a healthy system, so the one thing the operator
  learned from the instrument was nothing.

  🔴 **The line states what was OBSERVED and stops there.** It does NOT say
  the write lock is held by an unregistered writer — that is an inference,
  and the same prod episode shows pool queueing is an equally live cause.
  What it can vouch for is exactly: N registered writers have been queued
  past the threshold, and this many holders are registered (usually none).
  The two candidate causes are separated by the WAITERS' OWN STACKS, which
  it samples and carries — a waiter parked in `Exqlite.Sqlite3NIF` is
  blocked on the lock, one inside `DBConnection.Holder` is queued for a
  connection. Asserting a cause the frame never measured is the exact defect
  `terminal_message/3` in `Grappa.Repo.BusyRetry` was twice rewritten to
  stop committing (#1420, #1421); this arm does not re-commit it here.

  ### One report per episode, on either arm

  The row's `reported?` flag arms on the first report and disarms on release
  — otherwise a 30 s stall prints 30 times. Release emits a second,
  `:resolved` event carrying the TOTAL hold, so a NAMED episode has both an
  opening and a closing bracket.

  ### The bracket that speaks when the opening line never did (#1888)

  🔴 That closing bracket used to require `reported?: true`, which made it
  useless in the one case it is now for. **Measured in prod on 2026-09-01
  (grappa 1.4.1, jail `grappa-new`): a 31 s freeze — no request served, on any
  network — with this observer ARMED (`enabled: true` in `config/config.exs`,
  overridden nowhere) and not one line of its own between 12:06:57.328 and
  12:07:28.554.** Whatever kept the detection pass from speaking, the episode
  then closed in TOTAL silence too: no log line, no telemetry, no ring row.
  An instrument whose silence means both *"nothing happened"* and *"something
  happened and I could not say so"* has stopped reporting.

  So a hold past `stall_threshold_ms` now brackets whether or not it was ever
  announced, and the line SAYS which — an announced episode has an opening
  line above it carrying the holder's sampled stack, an unannounced one is the
  only record that episode left, and an operator needs to know which they are
  holding. The bracket is also where the ambiguity is cheapest to remove: by
  then the lock is RELEASED, so nothing on this path can be blocked by the
  stall it describes, which is exactly the trap the detection path lives in
  (#1715).

  What it carries is a `t:caller/0` and NOT a `t:sample/0` — see that type for
  why the two must not be folded together.

  Both arms share that one flag, and the unattributed arm arms it on WAITER
  rows rather than a holder's. So `acquired/0` CLEARS it on promotion: a pid
  reported once while queued would otherwise carry an armed flag into its own
  hold and never be reportable as the holder it went on to become. An
  unattributed episode gets no closing bracket — there was no hold to total,
  and inventing one is the claim this arm exists to avoid.

  ### The NIF census (#1901)

  🔴 **Both arms above read the watch TABLE, and the table has one producer,
  so between them they observe the RARE tail of this system's write load.**
  Measured on the live node (`Grappa.Operator.db_latency_text!/0`, cumulative
  since boot): `messages insert` — `Grappa.Scrollback.persist_row/1`, an
  autocommit single statement — is **324 679** writes, while every source the
  seam does cover (auth, settings, themes, push, reap) is in the thousands.
  The dominant writer of this system has never owned a row here.

  So the third arm does not read the table at all. At each tick it walks
  `Process.list/0` and keeps the processes whose `current_function` is inside
  `Exqlite.Sqlite3NIF`, timing them from the first tick that saw them there.
  That reaches any writer, registered or not, because the property it reads is
  physical: `execute/2` and `step/2` are declared
  `ERL_NIF_DIRTY_JOB_IO_BOUND` (`deps/exqlite/c_src/sqlite3_nif.c:2066,2077`)
  and exqlite's own busy handler SLEEPS INSIDE the NIF rather than returning
  to Elixir to retry (`:332`), so a writer blocked on the file lock stays
  visible in `current_function` for the whole `busy_timeout`.

  🔴 **What it cannot do, and the line says so rather than guessing.** The
  same physics that makes the cohort visible makes it INDIVISIBLE: the writer
  holding the lock and the writers blocked behind it are all inside
  `Exqlite.Sqlite3NIF`, all reading `status: :running`, and nothing
  BEAM-visible separates them. This arm therefore reports the COHORT — every
  parked process, its elapsed, its `current_function` and the longest one's
  stack — plus how many of them the seam already knows as holders and as
  waiters. Naming the holder outright is what registering the autocommit
  writes (#1901 axis 2, deliberately deferred) would buy, and asserting it
  from here is the class of claim `terminal_message/3` in
  `Grappa.Repo.BusyRetry` was twice rewritten to stop making.

  Two further limits, stated so a later reader does not have to rediscover
  them:

    * a transaction parked BETWEEN statements is not inside a NIF, so this
      arm cannot see it. That case is the FIRST arm's, and it is covered
      exactly when the writer went through the seam;
    * `elapsed` is measured from the first TICK that saw the process there,
      never from its real entry into the NIF, so it is a LOWER bound
      understated by up to one `tick_ms`. A census that wanted the true
      instant would have to instrument the write path, which is the cost this
      arm exists to avoid.

  Readers park in the same NIF, so a slow `SELECT` is in the cohort too. That
  is deliberate: the arm reports what it observed, and a reader holding a long
  read transaction is a real participant in the contention.

  ## Deriving the holder's identity instead of storing it

  No caller label is stored, and `immediate_transaction/1` grows no label
  argument. When the watchdog fires, the holder is still INSIDE the
  transaction, so its `:current_stacktrace` already contains the
  `immediate_transaction` frame and every caller frame above it. The
  identity is derived at report time and costs the hot path nothing.

  ## Doors

  `Logger.warning` (the door that reaches CI container logs, which is where
  #1420's evidence lives) plus a `:telemetry` event that `Grappa.DbLatency`
  folds into a bounded ring — so `GET /admin/db_latency` and
  `bin/grappa db-latency` both inherit the data with no new noun.

  The warning carries the holder's scheduler `status` next to its
  `current_function`, because the two are one answer and only together do
  they name a cause. Measured on #1420's own stalls: a holder genuinely
  blocked inside `Exqlite.Sqlite3NIF.execute/2` on a contended
  `BEGIN IMMEDIATE` reads `:running` (so the write is slow), one that is
  merely queued and not being scheduled reads `:runnable` (so nothing about
  SQLite is slow), and a parked one reads `:waiting`. `sample/2` has always
  collected the byte; for four days the only door that reaches an artefact
  threw it away, and the two diagnoses stayed indistinguishable.
  `message_queue_len` is deliberately NOT in the line — it rides the
  telemetry door, which carries the whole sample, and the log line stays the
  two fields that answer the question.

  ## Cost and off-switch

  On the write path: one `:persistent_term` read, one `:ets.whereis/1`, and
  three ETS row operations per write transaction — against a WAL write
  transaction costing milliseconds. `Process.info/2` (which briefly
  suspends its target) runs ONLY once a stall has already been detected,
  on a process that is by definition already stopped.

  🔴 #1901's census breaks that last sentence and it is the one cost in this
  module that is paid when nothing is wrong: one `Process.list/0` plus one
  `Process.info(pid, :current_function)` per process, per tick, unconditionally.
  Measured on this repo's dev image, warm, 20 passes per point:

      500 procs   1 057us/pass      2 000 procs   1 550us/pass
      1 000 procs 1 036us/pass      4 000 procs   3 042us/pass
                                    8 000 procs   5 237us/pass

  i.e. ~0.7-2us per process, so at `tick_ms: 1_000` a 2 000-process node
  spends **0.16 % of one scheduler** on it. Nothing about that scales with
  write VOLUME, which is the property that makes it cheaper than the
  alternative it replaces: axis 2 of #1901 would put three ETS operations on
  every one of those 324 679 inserts. Sampling only the crossed processes
  keeps the expensive half — `sample/2` and its twelve formatted frames —
  behind the threshold, exactly as the other two arms do.

  #1888 adds ONE more `:persistent_term` read per write-transaction RELEASE
  (the threshold the bracket compares against). It is a read and not a write
  on purpose: a `persistent_term` WRITE is the thing that blocks on a
  thread-progress barrier (#1715), and the only write is the one `init/1`
  pays at boot. Everything else the bracket does — the caller's
  `$initial_call`, its own stack — runs only once the hold has already crossed
  the threshold, and reads the releasing process's OWN state, so it neither
  signals nor suspends anybody.

  Off by default; `config :grappa, :lock_watch, enabled: true` arms it.
  `config/test.exs` leaves it OFF — its own tests arm it explicitly.
  """

  use GenServer

  require Logger

  @table :grappa_repo_lock_watch
  @enabled_key {__MODULE__, :enabled}
  @threshold_key {__MODULE__, :stall_threshold_ms}
  @depth_key {__MODULE__, :depth}
  @stack_frames 12

  # #1901 — the module every SQLite call in this system passes through, and
  # the census's whole discriminator. A literal and not a config knob: it is
  # not an operator choice, it is which driver `Grappa.Repo` is built on, and
  # a wrong value here fails silently (an empty census reads exactly like a
  # healthy node). It is referenced only as an atom in a pattern, so it adds
  # no call edge for the Boundary checker to see.
  @nif_module Exqlite.Sqlite3NIF

  @typedoc "Role of a row in the watch table."
  @type role :: :waiting | :holding

  @typedoc "One watch-table row: who, in which role, since when, already reported?"
  @type row :: {pid(), role(), integer(), boolean()}

  @typedoc """
  Handed to the transactor by `observe/1`, to be invoked as the FIRST
  statement inside the transaction body — the moment `BEGIN IMMEDIATE`
  has returned and `RESERVED` is held.
  """
  @type acquired_fun :: (-> :ok)

  @typedoc """
  One sampled process. `pid` is `inspect/1`-formatted and the stacktrace is
  pre-formatted because this rides telemetry into a JSON admin response —
  every field must be JSON-encodable at the point it is built, not later.
  """
  @type sample :: %{
          pid: String.t(),
          elapsed_ms: non_neg_integer(),
          current_function: String.t(),
          status: atom() | nil,
          message_queue_len: non_neg_integer() | nil,
          initial_call: String.t(),
          stacktrace: [String.t()]
        }

  @typedoc """
  Who held the lock, read from the holder's OWN process at release (#1888).

  🔴 Deliberately NOT a `t:sample/0`, and the distinction is the whole point.
  A sample is taken while the holder is still parked, so `current_function`
  and `status` name the frame it paused IN. By release there is no pause site
  left, and reusing that shape would let a release-time stack be read as the
  place the writer stalled — a claim this frame cannot make. What does survive
  release is the write PATH: which caller opened the transaction. That is all
  this carries, and it is what #1888 asks for ("pid + stacktrace or a label
  for the operation").
  """
  @type caller :: %{
          pid: String.t(),
          initial_call: String.t(),
          stacktrace: [String.t()]
        }

  @typedoc """
  A detected stall: one holder, the queue behind it, and the instant it was
  observed (#1888 — the ring row it becomes is otherwise impossible to line up
  against `erlang.log`, which is the only artefact that dates a freeze).
  """
  @type stall :: %{
          observed_at: String.t(),
          holder: sample(),
          waiters: [sample()],
          waiter_count: non_neg_integer()
        }

  @typedoc """
  A queue nobody can be blamed for (#1687): writers past the threshold with
  no holder this instrument can name. `holders_registered` is the honesty
  field — `0` says the seam saw no holder at all (the autocommit case),
  a positive value says one is registered but has not crossed the
  threshold. There is deliberately no `holder` key: a record cannot carry a
  field for a thing that was never observed.
  """
  @type unattributed :: %{
          observed_at: String.t(),
          waiters: [sample()],
          holders_registered: non_neg_integer()
        }

  @typedoc """
  A census of the processes parked INSIDE `Exqlite.Sqlite3NIF` past the
  threshold (#1901) — the arm that reaches the autocommit writers the seam
  cannot see.

  🔴 There is deliberately no `holder` key, and the reason is stronger than
  the one `t:unattributed/0` gives for its own absence. There, no holder was
  observed. Here one certainly IS in `parked`, and the instrument cannot say
  WHICH: exqlite's busy handler sleeps inside the same dirty-IO NIF the writer
  holding the lock is executing in, so the holder and its victims are one
  indistinguishable cohort from the BEAM's side. `registered_holders` and
  `registered_waiters` are the honesty fields — how many of these the seam
  could already name — and the remainder is the population #1901 is about.
  """
  @type nif_census :: %{
          observed_at: String.t(),
          parked: [sample()],
          registered_holders: non_neg_integer(),
          registered_waiters: non_neg_integer()
        }

  @typedoc """
  The census's carry-forward clock: for each process currently inside
  `Exqlite.Sqlite3NIF`, the instant a tick FIRST saw it there and whether this
  episode has already been reported.

  Rebuilt from `Process.list/0` on every pass rather than maintained, so a
  process that leaves the NIF drops out with no housekeeping and no reaper —
  the parallel-structure-that-drifts this design is required to avoid. It
  lives in the watchdog's own state and NOT in the ETS table: the table is
  written by every caller's own process at the seam, and a per-tick observer's
  scratch space has no business being public, nor of being read by a
  `released/0` running in somebody else's process.
  """
  @type nif_watch :: %{pid() => {integer(), boolean()}}

  defstruct [:stall_threshold_ms, :tick_ms, :enabled, :nif_watch]

  @type t :: %__MODULE__{
          # non_neg, not pos: a threshold of 0 means "report every contended
          # holder at once" — noisy, but a coherent operator choice, and the
          # setting the tests use to take a reading without waiting on a
          # clock. `tick_ms` stays pos: a zero tick is a busy loop.
          stall_threshold_ms: non_neg_integer(),
          tick_ms: pos_integer(),
          enabled: boolean(),
          nif_watch: nif_watch()
        }

  ## ----- Write-path seam ----------------------------------------------

  @doc """
  Runs `transactor` under observation, handing it the callback to invoke at
  the exact moment the write lock is held.

  This is the whole seam, in one function, with ONE caller in production
  (`Grappa.Repo.immediate_transaction/1`) — the three edges are private
  because their ORDER is the measurement. Calling `acquired` anywhere other
  than the first statement inside the transaction body would classify
  waiters as holders, which is precisely the confusion the instrument
  exists to resolve, so the ordering is not left to call sites.

  `try/after` guarantees the episode closes on a raise or a
  `Repo.rollback/1` throw, and the transactor's return value passes through
  untouched: observing a transaction must not change it.
  """
  @spec observe((acquired_fun() -> result)) :: result when result: var
  def observe(transactor) when is_function(transactor, 1) do
    waiting()

    try do
      transactor.(&acquired/0)
    after
      released()
    end
  end

  @doc """
  One detection pass at the given threshold. The watchdog's tick calls this;
  it is public so an operator (or a test) can take the reading on demand
  instead of waiting for a tick.
  """
  @spec scan(non_neg_integer()) :: :ok
  def scan(stall_threshold_ms) when is_integer(stall_threshold_ms) and stall_threshold_ms >= 0 do
    detect(now_ms(), stall_threshold_ms)
  end

  @doc """
  One NIF-census pass (#1901): report the processes that have been inside
  `Exqlite.Sqlite3NIF` for at least `stall_threshold_ms`, and return the clock
  to hand the NEXT pass.

  Public for the same reason `scan/1` is — an operator, or a test, can take
  the reading on demand instead of waiting for a tick — but unlike `scan/1` it
  is not idempotent in its argument: the returned map IS the elapsed
  measurement. Calling it with a fresh `%{}` every time restarts every clock
  at zero, so nothing can ever cross a non-zero threshold. The watchdog
  threads it through `handle_info/2`; a caller driving it by hand must thread
  it too.
  """
  @spec census(nif_watch(), non_neg_integer()) :: nif_watch()
  def census(seen, stall_threshold_ms)
      when is_map(seen) and is_integer(stall_threshold_ms) and stall_threshold_ms >= 0 do
    now = now_ms()

    # `Map.get(seen, pid, {now, false})` is the whole state machine: a pid
    # already being watched keeps its original instant AND its reported flag,
    # a new one starts its clock now, and a pid that has left the NIF is
    # simply absent from the rebuilt map. No deletion path, so none to leak.
    carried = Map.new(parked_in_nif(), &{&1, Map.get(seen, &1, {now, false})})

    due =
      for {pid, {since, false}} <- carried, now - since >= stall_threshold_ms, do: {pid, now - since}

    report_nif_census(due)

    Enum.reduce(due, carried, fn {pid, _}, acc ->
      Map.update!(acc, pid, fn {since, _} -> {since, true} end)
    end)
  end

  # Entering `BEGIN IMMEDIATE`. The caller is a WAITER until `acquired/0`.
  #
  # The depth bookkeeping is deliberately NOT gated on `enabled?/0`, while
  # the ETS work is. Gating both would let the counter leak: if the flag (or
  # the table) goes away between this call and `released/0` — a watchdog
  # restart is enough — the decrement is skipped and a long-lived process
  # such as a `Session.Server` keeps a non-zero depth for the rest of its
  # life, permanently invisible to the instrument. A process-dictionary read
  # and write cost nanoseconds; a silently blinded observer costs the whole
  # investigation.
  @spec waiting() :: :ok
  defp waiting do
    depth = depth()
    Process.put(@depth_key, depth + 1)

    # Only the OUTERMOST transaction owns the row. A nested
    # `immediate_transaction/1` collapses to a SAVEPOINT on the same
    # connection, so an inner `released/0` deleting the row would erase a
    # holder that is still holding — an instrument lying about the very
    # thing it measures.
    if depth == 0 and enabled?() do
      :ets.insert(@table, {self(), :waiting, now_ms(), false})
    end

    :ok
  end

  # `BEGIN IMMEDIATE` returned: the caller now HOLDS `RESERVED`.
  #
  # Runs as the first statement inside the transaction fun, so it must never
  # raise — a raise here would abort a caller's write transaction, which is
  # precisely the semantic change this instrument is forbidden to make.
  # `enabled?/0` proves the table exists and `:ets.update_element/3` answers
  # `false` (never raises) for an absent key.
  #
  # 🔴 The `reported?` reset is load-bearing since #1687 gave the flag a
  # second writer. The unattributed arm arms it on WAITER rows, and this
  # update rewrites the role and restarts the clock in place — so without
  # `{4, false}` a pid reported once while queued would carry an armed flag
  # into its own hold and `unreported?/1` would suppress it forever. Clearing
  # it here is not defensive: the promotion IS a new episode, with a new
  # clock, and a new episode has not been reported.
  @spec acquired() :: :ok
  defp acquired do
    if depth() == 1 and enabled?() do
      :ets.update_element(@table, self(), [{2, :holding}, {3, now_ms()}, {4, false}])
    end

    :ok
  end

  # Transaction over. Closes the episode, and brackets it if it earned one.
  @spec released() :: :ok
  defp released do
    case depth() do
      depth when depth > 1 ->
        Process.put(@depth_key, depth - 1)

      _ ->
        Process.delete(@depth_key)
        if enabled?(), do: close_episode(:ets.take(@table, self()))
    end

    :ok
  end

  # 🔴 #1888 widened WHAT earns a bracket, and the widening is the deliverable.
  # Until then the only clause that spoke required `reported?: true`, so an
  # episode the watchdog never announced closed in TOTAL silence — no log line,
  # no telemetry, no ring row. That is the shape #1888 reports from prod: this
  # observer armed (`enabled: true` in `config/config.exs`, unoverridden), a
  # 31 s freeze, and not one line of its own on either door. An instrument
  # whose silence means BOTH "nothing happened" and "something happened and I
  # could not say so" is not reporting.
  #
  # The bracket is where that ambiguity is cheapest to remove, because by the
  # time this runs the lock is already RELEASED — so nothing this frame does
  # can be blocked by the stall it is describing, which is precisely the trap
  # the detection path lives in (#1715).
  @spec close_episode([row()]) :: :ok
  defp close_episode([{_, :holding, since, announced}]) do
    held_ms = now_ms() - since

    if announced or past_threshold?(held_ms) do
      report_resolved(held_ms, announced)
    end

    :ok
  end

  defp close_episode(_), do: :ok

  # The threshold is published by the watchdog at `init/1`, so a release that
  # lands on a node where it never booted — or inside a supervisor restart —
  # has none to compare against. `:unknown` answers FALSE rather than guessing
  # one, which is exactly the pre-#1888 behaviour: an announced episode still
  # brackets, because `reported?` already proves it crossed a threshold. A
  # literal default here would either bracket every write transaction on the
  # node or none of them, and both are wrong silently.
  @spec past_threshold?(non_neg_integer()) :: boolean()
  defp past_threshold?(held_ms) do
    case :persistent_term.get(@threshold_key, :unknown) do
      threshold_ms when is_integer(threshold_ms) -> held_ms >= threshold_ms
      :unknown -> false
    end
  end

  # 🔴 The `db lock stall RESOLVED:` prefix is LOAD-BEARING and unchanged. The
  # #1429 census counts `lockstall_resolved` off it (`scripts/log-gap-scan.awk`)
  # and `test/scripts/log_gap_scan_test.bats` pins the phrase verbatim, so
  # everything #1888 adds rides in the TAIL and both keep counting with no edit
  # — the same discipline `terminal_message/3` in `Grappa.Repo.BusyRetry`
  # states for its own prose.
  @spec report_resolved(non_neg_integer(), boolean()) :: :ok
  defp report_resolved(held_ms, announced) do
    caller = caller_identity()

    Logger.warning(
      "db lock stall RESOLVED: holder #{caller.pid} released RESERVED after #{held_ms}ms — " <>
        "#{announced_clause(announced)}; write path #{caller.initial_call}, " <>
        "stack: #{Enum.join(caller.stacktrace, " <- ")}",
      held_ms: held_ms
    )

    :telemetry.execute(
      [:grappa, :repo, :lock_stall, :resolved],
      %{held_ms: held_ms},
      %{observed_at: now_iso8601(), holder_pid: caller.pid, caller: caller, announced: announced}
    )
  end

  # Which of the two an operator is reading decides where they look next: an
  # announced episode has an opening line above it carrying the holder's
  # SAMPLED stack, while an unannounced one is the only record that episode
  # ever left. The clause is the difference between "scroll up" and "there is
  # nothing up there to find".
  @spec announced_clause(boolean()) :: String.t()
  defp announced_clause(true), do: "announced while it held"
  defp announced_clause(false), do: "NEVER announced while it held"

  ## ----- Public API ---------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc """
  Current holder + waiters, sampled now. The live read behind the watchdog,
  exposed so an operator can ask the question mid-incident rather than
  waiting for a tick.
  """
  @spec inspect_lock() :: %{holders: [sample()], waiters: [sample()]}
  def inspect_lock do
    now = now_ms()
    {holders, waiters} = partition(rows(), now)

    %{
      holders: Enum.map(holders, fn {pid, elapsed} -> sample(pid, elapsed) end),
      waiters: Enum.map(waiters, fn {pid, elapsed} -> sample(pid, elapsed) end)
    }
  end

  @doc """
  The same partition `inspect_lock/0` reports, as bare pids.

  For a caller that wants to know WHO holds and WHO queues and nothing else.
  `inspect_lock/0` answers that too, but it pays `sample/2` for every process
  — `Process.info/2` plus `@stack_frames` frames run through
  `Exception.format_stacktrace_entry/1` — and a caller polling in a loop pays
  that on every turn for an answer it discards (#1747).

  Shares `rows/0` and `partition/2` with `inspect_lock/0` rather than reading
  the table again: the reaping of dead rows lives in `rows/0`, so a second
  reader that skipped it would leave corpses behind for the instrument to
  report.
  """
  @spec lock_roles() :: %{holders: [pid()], waiters: [pid()]}
  def lock_roles do
    {holders, waiters} = partition(rows(), now_ms())

    %{holders: Enum.map(holders, &elem(&1, 0)), waiters: Enum.map(waiters, &elem(&1, 0))}
  end

  if Mix.env() == :test do
    @doc false
    # Test seam: arm/disarm the write-path instrumentation. Gated to :test so
    # no other build carries a runtime toggle. Tests MUST disarm on_exit — a
    # flag left armed is failure-at-a-distance for every later test.
    @spec put_test_enabled(boolean()) :: :ok
    def put_test_enabled(enabled?) when is_boolean(enabled?) do
      :persistent_term.put(@enabled_key, enabled?)
    end

    @doc false
    # #1888 — publish (or WITHDRAW) the threshold the closing bracket compares
    # against, without restarting the watchdog. `nil` erases the key, which is
    # the only way to reach `past_threshold?/1`'s `:unknown` arm: the arm that
    # keeps a node whose watchdog never booted on the pre-#1888 behaviour. A
    # test that could not reach it would leave that arm unbought.
    #
    # Gated to :test beside `put_test_enabled/1`, and tests MUST withdraw
    # `on_exit` for the same reason — a threshold left published is
    # failure-at-a-distance for every later test.
    @spec put_test_stall_threshold(non_neg_integer() | nil) :: :ok
    def put_test_stall_threshold(nil) do
      _ = :persistent_term.erase(@threshold_key)
      :ok
    end

    def put_test_stall_threshold(ms) when is_integer(ms) and ms >= 0 do
      :persistent_term.put(@threshold_key, ms)
    end
  end

  ## ----- GenServer callbacks ------------------------------------------

  @impl GenServer
  def init(opts) do
    state = %__MODULE__{
      stall_threshold_ms: Keyword.fetch!(opts, :stall_threshold_ms),
      tick_ms: Keyword.fetch!(opts, :tick_ms),
      enabled: Keyword.fetch!(opts, :enabled),
      # #1901 — empty, never seeded from a first pass here: a boot-time
      # census would time every process from BEFORE the Repo exists and
      # report the pool's first statements as a stall.
      nif_watch: %{}
    }

    # Before anything else: buy this module's Logger cache key while no
    # write lock is held. See `prime_logger_module_cache/0`.
    prime_logger_module_cache()

    # `:public` because the seam writes from every caller's own process; the
    # table is owned here so a supervisor restart rebuilds it clean.
    _ = :ets.new(@table, [:named_table, :public, :set, write_concurrency: true])
    :persistent_term.put(@enabled_key, state.enabled)

    # #1888 — the closing bracket runs in the RELEASING caller's process, not
    # here, so it cannot read `state`. Published once at boot for the same
    # reason `@enabled_key` is: a `:persistent_term` read is lock-free and
    # cheap, while the WRITE is the thing that blocks on a thread-progress
    # barrier (#1715) — and this is the only write.
    :persistent_term.put(@threshold_key, state.stall_threshold_ms)

    _ = if state.enabled, do: Process.send_after(self(), :tick, state.tick_ms)

    {:ok, state}
  end

  # `scan/1` FIRST, and the order is not cosmetic: it is the arm that can NAME
  # a holder, and a pid it reports in this tick is one the census then counts
  # as already-registered rather than as a writer nobody can see. Running the
  # census first would report the same episode as unattributable one tick
  # before the instrument attributed it.
  @impl GenServer
  def handle_info(:tick, state) do
    scan(state.stall_threshold_ms)
    nif_watch = census(state.nif_watch, state.stall_threshold_ms)
    Process.send_after(self(), :tick, state.tick_ms)
    {:noreply, %{state | nif_watch: nif_watch}}
  end

  @impl GenServer
  def terminate(_, _) do
    :persistent_term.put(@enabled_key, false)
    :ok
  end

  # #1715 — pay this module's ONE lazy `persistent_term:put` here, at boot,
  # where nothing is holding the SQLite write lock. That is not a hope: this
  # child starts BEFORE `Grappa.Repo` (see `application.ex`), so at prime
  # time the tree holds no SQLite connection at all and the prime cannot
  # wait on the very thing it exists to step around.
  #
  # `Logger.__should_log__/2` calls `:logger_config.allow/2` at every call
  # site unconditionally, and `allow/2` writes `{logger_config, Module}` the
  # FIRST time a given module logs. A `persistent_term` write blocks on a
  # thread-progress barrier, and SQLite's busy handler sleeps out its
  # `busy_timeout` inside a dirty-IO NIF, which holds that barrier for the
  # whole sleep. So a module's first log line during a lock wait waits for
  # the lock wait — and THIS module's first line is its own stall report,
  # i.e. precisely the line that must not wait on the stall it reports.
  # Measured: `busy_timeout` halved, stall halved (133 s → 66.7/67.4/66.1,
  # ratio 1.99).
  #
  # `debug` is deliberate and emits nothing: `allow/2` caches
  # `?PRIMARY_TO_CACHE(get_primary_level())`, i.e. the PRIMARY level, so
  # `debug` writes the same key with the same value `warning` would while
  # staying below the bar itself.
  #
  # 🔴 What this does NOT cover, so a later stall here is not read as a
  # regression of a cure that never claimed the ground. It is ONE of the
  # three mechanisms measured, and 6 of the 9 measured victims:
  #
  #   * `logger_config:set/3` — a CONFIG write, with no module key to prime;
  #   * `code:ensure_loaded/1` — module LOADING, a different serialisation
  #     point entirely;
  #   * the first log line of EVERY other module — measured on a booted dev
  #     node, 7 modules hold a cache key against 597 loaded — and in
  #     particular a CRASH REPORT, which is by definition the first line
  #     from whichever module just died;
  #   * the coupling itself, which is untouched.
  #
  # 🔴 And priming every module is not a bigger cure, it is a bigger bug:
  # `logger_config:set/3` on a PRIMARY level change does one
  # `persistent_term:put` per CACHED module (the flush loop), so
  # `Logger.configure(level: …)` would go from today's 7 waits to one per
  # loaded module.
  @spec prime_logger_module_cache() :: :ok
  defp prime_logger_module_cache, do: Logger.debug(fn -> "" end)

  ## ----- Detection -----------------------------------------------------

  # A NAMED stall is a holder past the threshold WITH a queue behind it.
  # Neither half alone qualifies: a lone slow transaction blocks nobody.
  #
  # The `else` is the #1687 arm, and it is a fallback rather than a second
  # independent test on purpose — the two are mutually exclusive, so a real
  # stall is reported once, by its own name, and never also as an anonymous
  # queue. It fires in both shapes the first arm walks away from: no holder
  # registered at all (the autocommit case that produced the prod episode),
  # and a holder registered but still under the threshold while the queue
  # behind it is already past it. Both are the same defect — writers
  # demonstrably stuck, instrument silent — so they get the same cure and one
  # metadata field tells them apart.
  @spec detect(integer(), non_neg_integer()) :: :ok
  defp detect(now, threshold_ms) do
    {holders, waiters} = partition(rows(), now)

    # 🔴 The fork is ATTRIBUTABLE, not "did we print something". Splitting on
    # the reportable set instead would make an already-announced episode fall
    # through to the second arm on the very next tick and print "none past
    # the threshold" about a holder that is past it — the instrument lying in
    # the act of being more talkative. Nameable-at-all and
    # not-yet-named-this-episode are two different questions, and only the
    # first one chooses the arm.
    if attributable(holders, threshold_ms) == [] do
      report_unattributed(unreported_past(waiters, threshold_ms), length(holders))
    else
      report_stalls(unreported_past(holders, threshold_ms), waiters)
    end

    :ok
  end

  # Holders past the threshold, whether or not this episode already named
  # them. This is the "can anyone be blamed at all?" question.
  @spec attributable([{pid(), non_neg_integer()}], non_neg_integer()) :: [{pid(), non_neg_integer()}]
  defp attributable(holders, threshold_ms) do
    Enum.filter(holders, fn {_, elapsed} -> elapsed >= threshold_ms end)
  end

  # Rows past the threshold that this episode has not reported yet — the
  # "what is left to say?" question. Shared by both arms so they cannot
  # drift on either half of the predicate.
  @spec unreported_past([{pid(), non_neg_integer()}], non_neg_integer()) :: [{pid(), non_neg_integer()}]
  defp unreported_past(rows, threshold_ms) do
    Enum.filter(rows, fn {pid, elapsed} -> elapsed >= threshold_ms and unreported?(pid) end)
  end

  @spec report_stalls([{pid(), non_neg_integer()}], [{pid(), non_neg_integer()}]) :: :ok
  defp report_stalls([], _), do: :ok
  defp report_stalls(_, []), do: :ok

  defp report_stalls(stalled, waiters) do
    waiter_samples = Enum.map(waiters, fn {pid, elapsed} -> sample(pid, elapsed) end)
    Enum.each(stalled, &report(&1, waiter_samples))
  end

  @spec report({pid(), non_neg_integer()}, [sample()]) :: :ok
  defp report({pid, elapsed}, waiter_samples) do
    # Arm the flag BEFORE emitting: an emit that raced the next tick would
    # double-report the same episode.
    _ = :ets.update_element(@table, pid, [{4, true}])

    holder = sample(pid, elapsed)

    stall = %{
      observed_at: now_iso8601(),
      holder: holder,
      waiters: waiter_samples,
      waiter_count: length(waiter_samples)
    }

    # `status` rides in the PROSE, next to `current_function`, and not in the
    # metadata beside `held_ms`/`waiters`: those two are measurements an
    # operator aggregates, while these two are one answer split in half —
    # WHERE the holder is, and whether it is running there at all. Separating
    # them across the message/metadata line is what made the reading hard.
    Logger.warning(
      "db lock stall: holder #{holder.pid} has held RESERVED for #{holder.elapsed_ms}ms " <>
        "with #{stall.waiter_count} waiter(s) queued — holder status=#{inspect(holder.status)} " <>
        "at #{holder.current_function}, stack: #{Enum.join(holder.stacktrace, " <- ")}",
      held_ms: holder.elapsed_ms,
      waiters: stall.waiter_count
    )

    :telemetry.execute(
      [:grappa, :repo, :lock_stall, :detected],
      %{held_ms: holder.elapsed_ms, waiter_count: stall.waiter_count},
      stall
    )
  end

  # #1687 — the queue nobody can be blamed for. Same two doors as `report/2`,
  # and deliberately the same SHAPE of line, so an operator scanning the log
  # reads them as one instrument with two verdicts rather than two tools.
  #
  # It carries the LONGEST waiter's stack for the same reason `report/2`
  # carries the holder's: it is the one frame that says which of the two
  # topologies this is. The measurement is named `longest_wait_ms` and not
  # `held_ms` — nothing here observed a hold, and reusing the hold field
  # would smuggle the claim back in through the schema after the prose had
  # been careful to leave it out.
  @spec report_unattributed([{pid(), non_neg_integer()}], non_neg_integer()) :: :ok
  defp report_unattributed([], _), do: :ok

  defp report_unattributed(queued, holders_registered) do
    # Arm BEFORE emitting, exactly as `report/2` does: a 170-second prod
    # episode at `tick_ms: 1_000` would otherwise print the same warning ~170
    # times, which an operator reads the same way as never printing it.
    Enum.each(queued, fn {pid, _} -> :ets.update_element(@table, pid, [{4, true}]) end)

    samples = Enum.map(queued, fn {pid, elapsed} -> sample(pid, elapsed) end)
    longest = Enum.max_by(samples, & &1.elapsed_ms)
    report = %{observed_at: now_iso8601(), waiters: samples, holders_registered: holders_registered}

    Logger.warning(
      "db lock stall UNATTRIBUTED: #{length(samples)} writer(s) queued past the threshold, " <>
        "longest #{longest.elapsed_ms}ms — #{holder_clause(holders_registered)}, so the holder is " <>
        "NOT attributable at the BEGIN IMMEDIATE seam; longest waiter #{longest.pid} " <>
        "status=#{inspect(longest.status)} at #{longest.current_function}, " <>
        "stack: #{Enum.join(longest.stacktrace, " <- ")}",
      waiters: length(samples),
      longest_wait_ms: longest.elapsed_ms
    )

    :telemetry.execute(
      [:grappa, :repo, :lock_stall, :unattributed],
      %{waiter_count: length(samples), longest_wait_ms: longest.elapsed_ms},
      report
    )
  end

  # The two sub-cases, named apart because they call for different next
  # moves: `0` means the writer holding the lock never passed the seam (widen
  # coverage, or accept the blindness knowingly), while a positive count
  # means the seam DID see a holder and the queue is simply older than it.
  @spec holder_clause(non_neg_integer()) :: String.t()
  defp holder_clause(0), do: "no holder registered"
  defp holder_clause(n), do: "#{n} holder(s) registered, none past the threshold"

  ## ----- The NIF census (#1901) -----------------------------------------

  # Every process currently executing inside the SQLite driver's NIF. The
  # discriminator is `current_function` and NOT `:status` or
  # `:current_stacktrace` (#1888): a dirty NIF reads `:running` whether it is
  # doing work or sleeping out a busy handler, and a stacktrace costs the
  # twelve-frame format this pass runs over EVERY process on the node.
  #
  # `Process.info/2` does not block on a process parked in a dirty NIF —
  # measured at 2-78us across four topologies in `lock_watch_test.exs`
  # (#1767) — which is what makes an unconditional per-tick sweep affordable
  # at all. `nil` for a pid that died between `Process.list/0` and here is a
  # real outcome and simply fails the match.
  @spec parked_in_nif() :: [pid()]
  defp parked_in_nif do
    for pid <- Process.list(),
        match?({:current_function, {@nif_module, _, _}}, Process.info(pid, :current_function)),
        do: pid
  end

  # Same two doors and the same SHAPE of line as the other two arms, so an
  # operator scanning `erlang.log` reads three verdicts from one instrument
  # rather than three tools. The prefix is `db lock stall NIF CENSUS:` and it
  # is LOAD-BEARING for the same reason theirs are: `scripts/log-gap-scan.awk`
  # counts the #1429 census off these literals and
  # `test/scripts/log_gap_scan_test.bats` pins them verbatim.
  #
  # 🔴 The ROSTER is why this line is longer than its siblings, and it is the
  # deliverable rather than verbosity. #1901's acceptance test is that the log
  # NAMES the process holding the lock; this arm cannot label which of the
  # cohort that is, so it names every one of them — pid, elapsed and frame —
  # and pays the full twelve-frame stack only for the longest. An operator who
  # has the roster can cross it against the `fault=busy_locked` terminals the
  # victims emit and read the holder off the difference; an operator with one
  # sample cannot.
  @spec report_nif_census([{pid(), non_neg_integer()}]) :: :ok
  defp report_nif_census([]), do: :ok

  defp report_nif_census(due) do
    samples =
      due |> Enum.map(fn {pid, elapsed} -> sample(pid, elapsed) end) |> Enum.sort_by(& &1.elapsed_ms, :desc)

    longest = hd(samples)
    %{holders: holders, waiters: waiters} = lock_roles()
    due_pids = MapSet.new(due, &elem(&1, 0))
    registered_holders = Enum.count(holders, &MapSet.member?(due_pids, &1))
    registered_waiters = Enum.count(waiters, &MapSet.member?(due_pids, &1))

    report = %{
      observed_at: now_iso8601(),
      parked: samples,
      registered_holders: registered_holders,
      registered_waiters: registered_waiters
    }

    Logger.warning(
      "db lock stall NIF CENSUS: #{length(samples)} process(es) parked inside " <>
        "#{inspect(@nif_module)} past the threshold, longest #{longest.elapsed_ms}ms — " <>
        "#{seam_clause(registered_holders, registered_waiters, length(samples))}; " <>
        "roster: #{roster(samples)}; longest #{longest.pid} status=#{inspect(longest.status)} " <>
        "at #{longest.current_function}, stack: #{Enum.join(longest.stacktrace, " <- ")}",
      parked: length(samples),
      longest_parked_ms: longest.elapsed_ms
    )

    :telemetry.execute(
      [:grappa, :repo, :lock_stall, :nif_census],
      %{parked_count: length(samples), longest_parked_ms: longest.elapsed_ms},
      report
    )
  end

  # The two sub-cases, named apart because they call for different next moves
  # — the same split `holder_clause/1` makes one arm up. All-zero is the #1901
  # finding in one phrase: this system's dominant writer holds the file lock
  # without ever touching the seam, so widening coverage (axis 2) is the only
  # thing that would name it. A positive count says the seam DID see some of
  # them, and the remainder is what it missed.
  @spec seam_clause(non_neg_integer(), non_neg_integer(), pos_integer()) :: String.t()
  defp seam_clause(0, 0, total) do
    "none of them registered at the BEGIN IMMEDIATE seam, so all #{total} are writers it cannot name"
  end

  defp seam_clause(holders, waiters, total) do
    "#{holders} holder(s) and #{waiters} waiter(s) of them registered at the BEGIN IMMEDIATE " <>
      "seam, #{total - holders - waiters} not"
  end

  # Pid, elapsed and frame for every parked process — no stacks, which ride
  # the telemetry door in full. The frame is in because it is the one field
  # that separates a writer blocked acquiring a transaction
  # (`Exqlite.Sqlite3NIF.execute/2`, under `handle_begin/2`) from one already
  # executing a statement (`step/2`), and that reading costs nothing here.
  @spec roster([sample()]) :: String.t()
  defp roster(samples) do
    Enum.map_join(samples, ", ", &"#{&1.pid} #{&1.elapsed_ms}ms #{&1.current_function}")
  end

  ## ----- Sampling -------------------------------------------------------

  # Reaps dead rows as it reads. A process killed mid-transaction never runs
  # `released/0`, so its row would otherwise sit in the table forever and be
  # re-reported as an eternal holder — the instrument accusing a corpse while
  # the real contention goes unnamed. Reaping happens here, off the write
  # path, because only the scan side cares.
  @spec rows() :: [row()]
  defp rows do
    case :ets.whereis(@table) do
      :undefined -> []
      _ -> Enum.filter(:ets.tab2list(@table), &alive?/1)
    end
  end

  @spec alive?(row()) :: boolean()
  defp alive?({pid, _, _, _}) do
    if Process.alive?(pid) do
      true
    else
      :ets.delete(@table, pid)
      false
    end
  end

  @spec partition([row()], integer()) :: {[{pid(), non_neg_integer()}], [{pid(), non_neg_integer()}]}
  defp partition(rows, now) do
    {holding, waiting} = Enum.split_with(rows, fn {_, role, _, _} -> role == :holding end)

    {Enum.map(holding, fn {pid, _, since, _} -> {pid, now - since} end),
     Enum.map(waiting, fn {pid, _, since, _} -> {pid, now - since} end)}
  end

  @spec unreported?(pid()) :: boolean()
  defp unreported?(pid) do
    case :ets.lookup(@table, pid) do
      [{_, _, _, reported?}] -> not reported?
      [] -> false
    end
  end

  # The whole point of the instrument: WHERE is this process, right now.
  # `Process.info/2` returns nil for a dead pid, which is a real outcome
  # here (the holder can die between the scan and the sample), so it folds
  # to an explicit empty sample rather than crashing the watchdog.
  @spec sample(pid(), non_neg_integer()) :: sample()
  defp sample(pid, elapsed_ms) do
    info = Process.info(pid, [:current_function, :status, :message_queue_len, :dictionary])

    %{
      pid: inspect(pid),
      elapsed_ms: elapsed_ms,
      current_function: format_mfa(info && Keyword.get(info, :current_function)),
      status: info && Keyword.get(info, :status),
      message_queue_len: info && Keyword.get(info, :message_queue_len),
      initial_call: format_mfa(initial_call(info)),
      stacktrace: stacktrace(pid)
    }
  end

  @spec initial_call(keyword() | nil) :: mfa() | nil
  defp initial_call(nil), do: nil

  defp initial_call(info) do
    info |> Keyword.get(:dictionary, []) |> Keyword.get(:"$initial_call")
  end

  @spec stacktrace(pid()) :: [String.t()]
  defp stacktrace(pid) do
    case Process.info(pid, :current_stacktrace) do
      {:current_stacktrace, frames} -> format_frames(frames)
      nil -> []
    end
  end

  # #1888 — the release-time identity, read from the releasing process's OWN
  # state. That is what makes it cheap enough to sit on the release path at
  # all: `Process.get/1` is a local dictionary read and
  # `Process.info(self(), …)` needs no signal and suspends nobody, unlike
  # `sample/2`, which crosses to another process. Both still run ONLY past the
  # threshold — see `close_episode/1`.
  @spec caller_identity() :: caller()
  defp caller_identity do
    %{
      pid: inspect(self()),
      initial_call: format_mfa(Process.get(:"$initial_call")),
      stacktrace: caller_frames()
    }
  end

  # The head of a release-time stack is the observer's own plumbing —
  # `Process.info/2` under `caller_frames/0` under `report_resolved/2` under
  # `close_episode/1` under `released/0` under `observe/1` — and an operator
  # who has to read six frames of observer before the first frame of the thing
  # observed reads none of them. What survives is everything ABOVE the
  # outermost `__MODULE__` frame, which puts `Repo.immediate_transaction/1` at
  # the head: both the seam and the proof that this was a WRITE transaction.
  #
  # 🔴 Dropping WHILE the frame is `__MODULE__` does not do this, measured: the
  # innermost frame is `Process.info/2`, which belongs to `Process`, so the
  # drop stops on the very first frame and keeps the whole observer. Taking
  # from the END until the last `__MODULE__` frame needs no module allowlist
  # and cannot rot as the private call chain changes shape.
  @spec caller_frames() :: [String.t()]
  defp caller_frames do
    case Process.info(self(), :current_stacktrace) do
      {:current_stacktrace, frames} ->
        frames
        |> Enum.reverse()
        |> Enum.take_while(&(not match?({__MODULE__, _, _, _}, &1)))
        |> Enum.reverse()
        |> format_frames()

      nil ->
        []
    end
  end

  # Capped and pre-formatted: these strings ride telemetry into a JSON admin
  # response, so every frame must be JSON-encodable at the point it is built,
  # not later.
  @spec format_frames([tuple()]) :: [String.t()]
  defp format_frames(frames) do
    frames
    |> Enum.take(@stack_frames)
    |> Enum.map(&(&1 |> Exception.format_stacktrace_entry() |> String.trim()))
  end

  @spec format_mfa(mfa() | nil) :: String.t()
  defp format_mfa({module, function, arity}), do: Exception.format_mfa(module, function, arity)
  defp format_mfa(_), do: "unknown"

  ## ----- Helpers --------------------------------------------------------

  # The table check is not defensive noise: the watchdog owns the table, so a
  # supervisor restart briefly removes it. Without this, `acquired/0` would
  # raise INSIDE a caller's transaction and abort a write that had nothing to
  # do with the instrument.
  @spec enabled?() :: boolean()
  defp enabled? do
    :persistent_term.get(@enabled_key, false) and :ets.whereis(@table) != :undefined
  end

  @spec depth() :: non_neg_integer()
  defp depth, do: Process.get(@depth_key, 0)

  # #1888 — stamped at EMIT, never at fold. `Grappa.DbLatency` folds behind a
  # cast in another process, so a stamp taken there would be "when the
  # aggregator got round to it" — a different fact wearing the same name, and
  # skewed by exactly the load an incident produces. An ISO8601 STRING and not
  # a `DateTime`: like every other field here it rides telemetry into a JSON
  # admin response and must be encodable where it is built.
  @spec now_iso8601() :: String.t()
  defp now_iso8601, do: DateTime.to_iso8601(DateTime.utc_now())

  @spec now_ms() :: integer()
  defp now_ms, do: System.monotonic_time(:millisecond)
end
