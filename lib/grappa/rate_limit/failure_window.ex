defmodule Grappa.RateLimit.FailureWindow do
  @moduledoc """
  Per-`(bucket, key)` failure counter over a fixed time window —
  brute-force friction for the mode-1 (admin) login path (S6, codebase
  review 2026-07-19) and any future "N failures per window per key"
  gate.

  ## Check / record are separate verbs

  Unlike `Grappa.RateLimit.DailyQuota`'s atomic `check_and_record/3`,
  the caller here cannot know at check time whether the attempt will
  fail — the failure is known only after the (expensive) credential
  compare. So `check/3` is a lock-free ETS read gating the request
  BEFORE the bcrypt work, and `record_failure/3` is called only on a
  failed attempt. Successes never advance the counter, so a legitimate
  operator can never lock themselves out. Two concurrent requests can
  both pass `check/3` and both record — the threshold is approximate
  by ±concurrency, which is fine for login friction (the bound matters
  at 10s-to-100s of attempts, not ±2).

  ## Self-resetting, self-bounding

  Row shape: `{ {bucket, key}, window_started_ms, window_ms, count }`
  (monotonic ms; each row carries its own window length so buckets with
  different windows can share the table). A row past its window is
  treated as absent by both verbs — the counter resets with no sweeper
  process. Because keys are caller-controlled (source IPs — unbounded,
  unlike DailyQuota's subject keys), starting a NEW window additionally
  `select_delete`s every expired row: the table scan is amortized over
  first-failures (rare) and keeps table size bounded by keys with a
  LIVE window, not by every key ever seen.

  Writes are serialized through the GenServer (Backoff / DailyQuota
  model); reads are direct ETS.
  """
  use GenServer

  @table :rate_limit_failure_window

  @typep key :: {atom(), term()}

  @doc """
  ETS table atom, single-sourced for substrate checks and tests.
  """
  @spec table_name() :: :rate_limit_failure_window
  def table_name, do: @table

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  @doc """
  Whether `(bucket, key)` is under `limit` failures in its live window.
  `:ok` when under (or no live window); `{:error, :limited}` at/over.
  Lock-free read — call this BEFORE the expensive work it gates.
  """
  @spec check(atom(), term(), pos_integer()) :: :ok | {:error, :limited}
  def check(bucket, key, limit) when is_atom(bucket) and is_integer(limit) and limit > 0 do
    check(bucket, key, limit, now_ms())
  end

  @doc """
  Same as `check/3` with an explicit monotonic `now_ms` — the test seam
  for deterministic window-expiry coverage.
  """
  @spec check(atom(), term(), pos_integer(), integer()) :: :ok | {:error, :limited}
  def check(bucket, key, limit, now_ms)
      when is_atom(bucket) and is_integer(limit) and limit > 0 and is_integer(now_ms) do
    case live_count({bucket, key}, now_ms) do
      count when count >= limit -> {:error, :limited}
      _ -> :ok
    end
  end

  @doc """
  Records one failure for `(bucket, key)`, opening a fresh `window_ms`
  window when none is live. Returns the count within the live window
  AFTER this record — the caller can detect the exact limit-crossing
  (`count == limit`) to emit once-per-window operator signals.
  """
  @spec record_failure(atom(), term(), pos_integer()) :: pos_integer()
  def record_failure(bucket, key, window_ms)
      when is_atom(bucket) and is_integer(window_ms) and window_ms > 0 do
    record_failure(bucket, key, window_ms, now_ms())
  end

  @doc """
  Same as `record_failure/3` with an explicit monotonic `now_ms` (test
  seam).
  """
  @spec record_failure(atom(), term(), pos_integer(), integer()) :: pos_integer()
  def record_failure(bucket, key, window_ms, now_ms)
      when is_atom(bucket) and is_integer(window_ms) and window_ms > 0 and is_integer(now_ms) do
    GenServer.call(__MODULE__, {:record_failure, {bucket, key}, window_ms, now_ms})
  end

  ## GenServer

  @impl GenServer
  def init(_) do
    _ = :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{}}
  end

  @impl GenServer
  def handle_call({:record_failure, key, window_ms, now_ms}, _, state) do
    count =
      case :ets.lookup(@table, key) do
        [{^key, started, row_window, count}] when now_ms - started < row_window ->
          true = :ets.insert(@table, {key, started, row_window, count + 1})
          count + 1

        _ ->
          # New window — sweep every expired row first so the table is
          # bounded by keys with a LIVE window (keys are unbounded IPs).
          sweep_expired(now_ms)
          true = :ets.insert(@table, {key, now_ms, window_ms, 1})
          1
      end

    {:reply, count, state}
  end

  @spec live_count(key(), integer()) :: non_neg_integer()
  defp live_count(key, now_ms) do
    case :ets.lookup(@table, key) do
      [{^key, started, window_ms, count}] when now_ms - started < window_ms -> count
      _ -> 0
    end
  end

  @spec sweep_expired(integer()) :: :ok
  defp sweep_expired(now_ms) do
    match_spec = [
      {{:_, :"$1", :"$2", :_}, [{:>=, {:-, now_ms, :"$1"}, :"$2"}], [true]}
    ]

    _ = :ets.select_delete(@table, match_spec)
    :ok
  end

  @spec now_ms() :: integer()
  defp now_ms, do: System.monotonic_time(:millisecond)
end
