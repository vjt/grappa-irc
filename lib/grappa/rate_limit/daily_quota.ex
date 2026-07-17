defmodule Grappa.RateLimit.DailyQuota do
  @moduledoc """
  Per-`(bucket, subject, calendar-day)` creation quota — anti-abuse for
  theme saves/copies (#75, ~5/day) and any future "N per day per subject" cap.

  ETS-backed so a lookup is a direct read, but the read-compare-increment is
  serialized through the GenServer (`check_and_record/3` is a single `call`) so
  concurrent requests can't both slip under the limit. Modelled on
  `Grappa.Session.Backoff` (direct-read ETS owned by an Application-level
  GenServer).

  Row shape: `{ {bucket, subject}, date, count }`. The date is stored IN the
  row rather than pruned: a call on a new `Date.utc_today()` finds a stale-date
  row, treats the count as 0, and overwrites — so the quota self-resets at
  midnight UTC with no sweeper, and the table size is bounded by the number of
  distinct `(bucket, subject)` pairs (never unbounded growth).
  """
  use GenServer

  @table :rate_limit_daily_quota

  @typep key :: {atom(), term()}

  @doc """
  ETS table atom, single-sourced for the `Grappa.Health` `:ets` substrate check.
  """
  @spec table_name() :: :rate_limit_daily_quota
  def table_name, do: @table

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  @doc """
  Atomically check today's quota for `(bucket, subject)` and, if under `limit`,
  record one use.

  Returns `:ok` when the use was recorded, `{:error, :rate_limited}` when the
  limit is already reached (in which case NOTHING is recorded — a blocked call
  never advances the counter).
  """
  @spec check_and_record(atom(), term(), pos_integer()) :: :ok | {:error, :rate_limited}
  def check_and_record(bucket, subject, limit)
      when is_atom(bucket) and is_integer(limit) and limit > 0 do
    check_and_record(bucket, subject, limit, Date.utc_today())
  end

  @doc """
  Same as `check_and_record/3` but with an explicit `date` — used by tests to
  exercise the midnight-rollover reset deterministically.
  """
  @spec check_and_record(atom(), term(), pos_integer(), Date.t()) ::
          :ok | {:error, :rate_limited}
  def check_and_record(bucket, subject, limit, %Date{} = date)
      when is_atom(bucket) and is_integer(limit) and limit > 0 do
    GenServer.call(__MODULE__, {:check_and_record, {bucket, subject}, limit, date})
  end

  ## GenServer

  @impl GenServer
  def init(_) do
    _ = :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{}}
  end

  @impl GenServer
  def handle_call({:check_and_record, key, limit, date}, _, state) do
    count = current_count(key, date)

    if count >= limit do
      {:reply, {:error, :rate_limited}, state}
    else
      true = :ets.insert(@table, {key, date, count + 1})
      {:reply, :ok, state}
    end
  end

  # A row from a previous day (or no row) counts as 0 today — self-resetting.
  @spec current_count(key(), Date.t()) :: non_neg_integer()
  defp current_count(key, date) do
    case :ets.lookup(@table, key) do
      [{^key, ^date, count}] -> count
      _ -> 0
    end
  end
end
