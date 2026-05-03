defmodule Grappa.Admission.NetworkCircuit do
  @moduledoc """
  Per-`network_id` failure circuit-breaker for Login fresh-provision
  fail-fast. ETS-backed so state survives `Grappa.Visitors.Login`
  process churn.

  ## Why

  `Grappa.Session.Backoff` (S20) paces SESSION-LEVEL respawn delays
  per `(subject, network_id)` — but a fresh anon login (case-1) hasn't
  CREATED a subject yet, so per-`(subject, network)` keying can't gate
  the first probe. NetworkCircuit fills that gap: per-`network_id`
  failure window across all subjects. After threshold N failures in a
  rolling window, circuit opens; subsequent Login attempts fail fast
  with a `Retry-After` hint instead of synchronously probing a known-
  bad upstream.

  ## State per network_id

  Stored as ETS row: `{network_id, count, window_start_ms, state, cooled_at_ms}`.

    * `count` — failures in the current window.
    * `window_start_ms` — monotonic time of the window's first failure.
      Window resets when `now - window_start > window_ms`.
    * `state` — `:closed` | `:open`.
    * `cooled_at_ms` — monotonic time at which an open circuit returns
      to closed (= `opened_at + jittered(cooldown_ms)`). Unused when
      state is `:closed`.

  ## API contract

    * `record_failure/1` — bump count; transition to `:open` on
      threshold. Cast (async).
    * `record_success/1` — clear state to `:closed, count=0`. Cast.
    * `check/1` — fast read; direct ETS lookup. Returns `:ok` or
      `{:error, :open, retry_after_seconds}`.
    * `entries/0` — debug helper, full table snapshot.

  Writes funnel through the GenServer for read-modify-write
  consistency under concurrent failures (two visitors crashing
  simultaneously). Reads are direct ETS lookups (`:read_concurrency`)
  so the Login hot path takes no GenServer roundtrip.

  ## Tuning

  Defaults from `config :grappa, :admission`:

    * `network_circuit_threshold` (5) — failures-in-window to open.
    * `network_circuit_window_ms` (60_000) — rolling window size.
    * `network_circuit_cooldown_ms` (300_000) — open-state duration
      before re-allowing probes. ±25% jitter applied per-event.

  No half-open state — after cooldown elapses, circuit is `:closed`
  and probes flow freely; if they fail again, circuit re-opens. Client
  cap (default 1) + CAPTCHA + network-total cap together serialize
  concurrent attempts → no thundering herd risk worth the gating
  complexity of half-open.
  """
  use GenServer

  @table :admission_network_circuit_state
  @jitter_pct 25

  @threshold Application.compile_env(:grappa, [:admission, :network_circuit_threshold], 5)
  @window_ms Application.compile_env(:grappa, [:admission, :network_circuit_window_ms], 60_000)
  @cooldown_ms Application.compile_env(:grappa, [:admission, :network_circuit_cooldown_ms], 300_000)

  @typep entry :: {integer(), non_neg_integer(), integer(), :closed | :open, integer()}

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  ## Internals

  @doc false
  @spec compute_cooldown(non_neg_integer(), non_neg_integer()) :: non_neg_integer()
  def compute_cooldown(base_ms, jitter_pct \\ @jitter_pct) when jitter_pct >= 0 do
    jitter = trunc(base_ms * jitter_pct / 100)

    if jitter == 0 do
      base_ms
    else
      base_ms - jitter + :rand.uniform(2 * jitter + 1) - 1
    end
  end

  @doc false
  @spec threshold() :: pos_integer()
  def threshold, do: @threshold

  @doc false
  @spec window_ms() :: pos_integer()
  def window_ms, do: @window_ms

  @doc false
  @spec cooldown_ms() :: pos_integer()
  def cooldown_ms, do: @cooldown_ms

  @doc false
  @spec entries() :: [entry()]
  def entries, do: :ets.tab2list(@table)

  ## GenServer

  @impl GenServer
  def init(_) do
    _ = :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{}}
  end
end
