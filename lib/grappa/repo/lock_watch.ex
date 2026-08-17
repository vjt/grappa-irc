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

  A watchdog tick scans the table and reports only when a holder has held
  for at least `stall_threshold_ms` **AND at least one waiter is queued
  behind it**. A slow-but-uncontended transaction is not a stall, and
  reporting one would bury the signal it exists to find.

  One report per episode (the row's `reported?` flag arms on the first and
  disarms on release) — otherwise a 30 s stall prints 30 times. Release
  emits a second, `:resolved` event carrying the TOTAL hold, so an episode
  has both an opening and a closing bracket.

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

  ## Cost and off-switch

  On the write path: one `:persistent_term` read, one `:ets.whereis/1`, and
  three ETS row operations per write transaction — against a WAL write
  transaction costing milliseconds. `Process.info/2` (which briefly
  suspends its target) runs ONLY once a stall has already been detected,
  on a process that is by definition already stopped.

  Off by default; `config :grappa, :lock_watch, enabled: true` arms it.
  `config/test.exs` leaves it OFF — its own tests arm it explicitly.
  """

  use GenServer

  require Logger

  @table :grappa_repo_lock_watch
  @enabled_key {__MODULE__, :enabled}
  @depth_key {__MODULE__, :depth}
  @stack_frames 12

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

  @typedoc "A detected stall: one holder, the queue behind it."
  @type stall :: %{
          holder: sample(),
          waiters: [sample()],
          waiter_count: non_neg_integer()
        }

  defstruct [:stall_threshold_ms, :tick_ms, :enabled]

  @type t :: %__MODULE__{
          # non_neg, not pos: a threshold of 0 means "report every contended
          # holder at once" — noisy, but a coherent operator choice, and the
          # setting the tests use to take a reading without waiting on a
          # clock. `tick_ms` stays pos: a zero tick is a busy loop.
          stall_threshold_ms: non_neg_integer(),
          tick_ms: pos_integer(),
          enabled: boolean()
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
  @spec acquired() :: :ok
  defp acquired do
    if depth() == 1 and enabled?() do
      :ets.update_element(@table, self(), [{2, :holding}, {3, now_ms()}])
    end

    :ok
  end

  # Transaction over. Closes the episode, and brackets it if it was reported.
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

  @spec close_episode([row()]) :: :ok
  defp close_episode([{_, :holding, since, true}]) do
    held_ms = now_ms() - since

    Logger.warning(
      "db lock stall RESOLVED: holder #{inspect(self())} released RESERVED after #{held_ms}ms",
      held_ms: held_ms
    )

    :telemetry.execute(
      [:grappa, :repo, :lock_stall, :resolved],
      %{held_ms: held_ms},
      %{holder_pid: inspect(self())}
    )
  end

  defp close_episode(_), do: :ok

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

  if Mix.env() == :test do
    @doc false
    # Test seam: arm/disarm the write-path instrumentation. Gated to :test so
    # no other build carries a runtime toggle. Tests MUST disarm on_exit — a
    # flag left armed is failure-at-a-distance for every later test.
    @spec put_test_enabled(boolean()) :: :ok
    def put_test_enabled(enabled?) when is_boolean(enabled?) do
      :persistent_term.put(@enabled_key, enabled?)
    end
  end

  ## ----- GenServer callbacks ------------------------------------------

  @impl GenServer
  def init(opts) do
    state = %__MODULE__{
      stall_threshold_ms: Keyword.fetch!(opts, :stall_threshold_ms),
      tick_ms: Keyword.fetch!(opts, :tick_ms),
      enabled: Keyword.fetch!(opts, :enabled)
    }

    # `:public` because the seam writes from every caller's own process; the
    # table is owned here so a supervisor restart rebuilds it clean.
    _ = :ets.new(@table, [:named_table, :public, :set, write_concurrency: true])
    :persistent_term.put(@enabled_key, state.enabled)

    _ = if state.enabled, do: Process.send_after(self(), :tick, state.tick_ms)

    {:ok, state}
  end

  @impl GenServer
  def handle_info(:tick, state) do
    scan(state.stall_threshold_ms)
    Process.send_after(self(), :tick, state.tick_ms)
    {:noreply, state}
  end

  @impl GenServer
  def terminate(_, _) do
    :persistent_term.put(@enabled_key, false)
    :ok
  end

  ## ----- Detection -----------------------------------------------------

  # A stall is a holder past the threshold WITH a queue behind it. Neither
  # half alone qualifies: a lone slow transaction blocks nobody, and waiters
  # with no holder are the pool's business, not the write lock's.
  @spec detect(integer(), non_neg_integer()) :: :ok
  defp detect(now, threshold_ms) do
    {holders, waiters} = partition(rows(), now)

    stalled = Enum.filter(holders, fn {pid, elapsed} -> elapsed >= threshold_ms and unreported?(pid) end)

    if stalled != [] and waiters != [] do
      waiter_samples = Enum.map(waiters, fn {pid, elapsed} -> sample(pid, elapsed) end)
      Enum.each(stalled, &report(&1, waiter_samples))
    end

    :ok
  end

  @spec report({pid(), non_neg_integer()}, [sample()]) :: :ok
  defp report({pid, elapsed}, waiter_samples) do
    # Arm the flag BEFORE emitting: an emit that raced the next tick would
    # double-report the same episode.
    _ = :ets.update_element(@table, pid, [{4, true}])

    holder = sample(pid, elapsed)

    stall = %{holder: holder, waiters: waiter_samples, waiter_count: length(waiter_samples)}

    Logger.warning(
      "db lock stall: holder #{holder.pid} has held RESERVED for #{holder.elapsed_ms}ms " <>
        "with #{stall.waiter_count} waiter(s) queued — holder at #{holder.current_function}, " <>
        "stack: #{Enum.join(holder.stacktrace, " <- ")}",
      held_ms: holder.elapsed_ms,
      waiters: stall.waiter_count
    )

    :telemetry.execute(
      [:grappa, :repo, :lock_stall, :detected],
      %{held_ms: holder.elapsed_ms, waiter_count: stall.waiter_count},
      stall
    )
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
      {:current_stacktrace, frames} ->
        frames
        |> Enum.take(@stack_frames)
        |> Enum.map(&(&1 |> Exception.format_stacktrace_entry() |> String.trim()))

      nil ->
        []
    end
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

  @spec now_ms() :: integer()
  defp now_ms, do: System.monotonic_time(:millisecond)
end
