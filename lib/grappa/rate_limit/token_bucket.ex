defmodule Grappa.RateLimit.TokenBucket do
  @moduledoc """
  Per-`(bucket, key)` token-bucket rate limiter — burst-tolerant "N now,
  then M/second" throttling for the inbound message-send path (#340) and
  any future hot-path send/action cap.

  ## Why a token bucket (not DailyQuota / FailureWindow)

  `DailyQuota` is a hard per-calendar-day count; `FailureWindow` is a
  fixed-window failure counter. Neither fits "let a paste-burst of ~10
  lines through, then admit ~2/second sustained." A token bucket does:
  the bucket holds up to `capacity` tokens (the burst), refills at
  `refill_per_sec`, and each `take/4` consumes one. Empty ⇒
  `{:error, :rate_limited}`.

  The #340 use is protecting the USER from an upstream flood-kill: cic
  gets a 429 "slow down" from grappa BEFORE the IRC server (bahamut on
  Azzurra) k-lines the connection for flooding. The configured
  capacity/refill sit at or below the upstream flood allowance so our
  429 always trips first.

  ## Atomic check-and-consume

  Like `DailyQuota.check_and_record/3`, the refill-check-consume is a
  single serialized `GenServer.call` — two concurrent sends for the same
  key can't both slip under an empty bucket. Reads are not lock-free here
  (unlike the failure gates) because a token bucket has no "peek without
  mutate" verb: observing the bucket IS refilling it.

  ## Lazy refill, no timer

  Row shape: `{ {bucket, key}, tokens, last_refill_ms }` (monotonic ms).
  Refill is computed on access — `tokens + elapsed_s * refill_per_sec`,
  capped at `capacity` — so there is no per-bucket timer process. A fresh
  key starts FULL (a new user's first burst is allowed).

  ## Self-bounding

  Keys are `(subject, network)` pairs; visitor subjects churn over a
  long-lived node, so the keyspace is effectively unbounded (like
  `FailureWindow`'s source IPs). On a brand-new key the handler first
  `select_delete`s every row idle past `#{600_000}ms` — such a bucket has
  fully refilled, so deleting it is indistinguishable from it being
  absent. The scan is amortized over first-touches and keeps the table
  bounded by keys with an ACTIVE (non-full) bucket.

  Writes serialize through the GenServer (Backoff / DailyQuota model).
  """
  use GenServer

  @table :rate_limit_token_bucket

  # A bucket idle this long has fully refilled for any sane
  # (capacity, refill) pair, so it is equivalent to an absent (fresh,
  # full) bucket — safe to sweep. Keeps the table bounded by ACTIVE keys.
  @idle_sweep_ms 600_000

  @typep key :: {atom(), term()}

  @doc """
  ETS table atom, single-sourced for substrate checks and tests.
  """
  @spec table_name() :: :rate_limit_token_bucket
  def table_name, do: @table

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  @doc """
  Atomically refill, then try to consume one token for `(bucket, key)`.

  `:ok` when a token was available (and consumed); `{:error,
  :rate_limited}` when the bucket is empty (nothing is consumed — a
  blocked take never drives the count negative). A fresh key starts with
  a full `capacity` burst.

    * `capacity` — max tokens (the burst allowance).
    * `refill_per_sec` — tokens added per second (may be fractional).
  """
  @spec take(atom(), term(), pos_integer(), number()) :: :ok | {:error, :rate_limited}
  def take(bucket, key, capacity, refill_per_sec)
      when is_atom(bucket) and is_integer(capacity) and capacity > 0 and
             is_number(refill_per_sec) and refill_per_sec > 0 do
    take(bucket, key, capacity, refill_per_sec, now_ms())
  end

  @doc """
  Same as `take/4` with an explicit monotonic `now_ms` — the test seam
  for deterministic refill coverage.
  """
  @spec take(atom(), term(), pos_integer(), number(), integer()) ::
          :ok | {:error, :rate_limited}
  def take(bucket, key, capacity, refill_per_sec, now_ms)
      when is_atom(bucket) and is_integer(capacity) and capacity > 0 and
             is_number(refill_per_sec) and refill_per_sec > 0 and is_integer(now_ms) do
    GenServer.call(__MODULE__, {:take, {bucket, key}, capacity, refill_per_sec, now_ms})
  end

  ## GenServer

  @impl GenServer
  def init(_) do
    _ = :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{}}
  end

  @impl GenServer
  def handle_call({:take, key, capacity, refill_per_sec, now_ms}, _, state) do
    tokens = available_tokens(key, capacity, refill_per_sec, now_ms)

    if tokens >= 1.0 do
      true = :ets.insert(@table, {key, tokens - 1.0, now_ms})
      {:reply, :ok, state}
    else
      # Empty: record the refilled (fractional) level + new timestamp so
      # the next call refills from here, but consume nothing.
      true = :ets.insert(@table, {key, tokens, now_ms})
      {:reply, {:error, :rate_limited}, state}
    end
  end

  # Current token level after lazy refill. A brand-new key starts full
  # (and triggers an idle-sweep); an existing key refills from its stored
  # level, capped at capacity.
  @spec available_tokens(key(), pos_integer(), number(), integer()) :: float()
  defp available_tokens(key, capacity, refill_per_sec, now_ms) do
    case :ets.lookup(@table, key) do
      [{^key, tokens, last_ms}] ->
        added = (now_ms - last_ms) * refill_per_sec / 1_000
        min(capacity * 1.0, tokens + added)

      [] ->
        sweep_idle(now_ms)
        capacity * 1.0
    end
  end

  @spec sweep_idle(integer()) :: :ok
  defp sweep_idle(now_ms) do
    match_spec = [
      {{:_, :_, :"$1"}, [{:>=, {:-, now_ms, :"$1"}, @idle_sweep_ms}], [true]}
    ]

    _ = :ets.select_delete(@table, match_spec)
    :ok
  end

  @spec now_ms() :: integer()
  defp now_ms, do: System.monotonic_time(:millisecond)
end
