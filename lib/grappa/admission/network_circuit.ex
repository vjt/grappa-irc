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

  alias Grappa.Admission.Telemetry

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
  def compute_cooldown(base_ms, jitter_pct)
      when is_integer(base_ms) and base_ms >= 0 and
             is_integer(jitter_pct) and jitter_pct >= 0 and jitter_pct <= 100 do
    jitter = trunc(base_ms * jitter_pct / 100)

    if jitter == 0 do
      base_ms
    else
      base_ms - jitter + :rand.uniform(2 * jitter + 1) - 1
    end
  end

  @doc false
  @spec threshold() :: unquote(@threshold)
  def threshold, do: @threshold

  @doc false
  @spec window_ms() :: unquote(@window_ms)
  def window_ms, do: @window_ms

  @doc false
  @spec cooldown_ms() :: unquote(@cooldown_ms)
  def cooldown_ms, do: @cooldown_ms

  @doc false
  @spec entries() :: [entry()]
  def entries, do: :ets.tab2list(@table)

  @doc """
  Whether the circuit for `network_id` permits a new admission attempt.

  Direct ETS lookup — no GenServer roundtrip. `:ok` if circuit is
  closed OR the recorded cooldown has elapsed; `{:error, :open,
  retry_after_seconds}` if currently open with cooldown remaining.
  """
  @spec check(integer()) :: :ok | {:error, :open, non_neg_integer()}
  def check(network_id) when is_integer(network_id) do
    case :ets.lookup(@table, network_id) do
      [] ->
        :ok

      [{_, _, _, :closed, _}] ->
        :ok

      [{_, _, _, :open, cooled_at_ms}] ->
        now = System.monotonic_time(:millisecond)

        if now >= cooled_at_ms do
          # Cast the expiry notification so the GenServer emits exactly one
          # [:grappa, :admission, :circuit, :close, :cooldown_expired] event per
          # transition. Mailbox serialization + ETS-state recheck inside the
          # cast handler guarantee exactly-once delivery even if concurrent
          # callers all observe the same expired cooldown simultaneously.
          GenServer.cast(__MODULE__, {:cooldown_expire, network_id})
          :ok
        else
          {:error, :open, ceil((cooled_at_ms - now) / 1_000)}
        end
    end
  end

  @doc """
  Record a failed admission attempt against `network_id`. Bumps count
  within the current window; transitions to `:open` when count reaches
  threshold. Async (cast).
  """
  @spec record_failure(integer()) :: :ok
  def record_failure(network_id) when is_integer(network_id) do
    GenServer.cast(__MODULE__, {:failure, network_id})
  end

  @doc """
  Record a successful admission against `network_id` — clears the entry
  to `:closed, count=0`. Called from `Grappa.Visitors.Login` (Plan 2)
  when probe-connect receives `001 RPL_WELCOME`. Async (cast).
  """
  @spec record_success(integer()) :: :ok
  def record_success(network_id) when is_integer(network_id) do
    GenServer.cast(__MODULE__, {:success, network_id})
  end

  ## GenServer

  @impl GenServer
  def init(_) do
    _ = :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{}}
  end

  @impl GenServer
  def handle_cast({:failure, network_id}, state) do
    now = System.monotonic_time(:millisecond)

    {count, window_start, prior_circuit_state} =
      case :ets.lookup(@table, network_id) do
        [] ->
          {1, now, :closed}

        [{_, prior_count, prior_start, prior_state, _}] ->
          if now - prior_start > @window_ms do
            {1, now, :closed}
          else
            {prior_count + 1, prior_start, prior_state}
          end
      end

    {circuit_state, cooled_at} =
      if count >= @threshold do
        {:open, now + compute_cooldown(@cooldown_ms, @jitter_pct)}
      else
        {:closed, 0}
      end

    :ets.insert(@table, {network_id, count, window_start, circuit_state, cooled_at})

    # Emit once on the closed→open transition only. If prior state was already
    # :open, the circuit is already tripped — no duplicate event.
    if circuit_state == :open and prior_circuit_state != :open do
      Telemetry.circuit_open(network_id, @threshold, @cooldown_ms)
    end

    {:noreply, state}
  end

  def handle_cast({:success, network_id}, state) do
    # Emit close event only if there was an ETS entry to clear.
    # A success on a network that never had a circuit entry is a noop w.r.t.
    # telemetry — don't emit a spurious :close event.
    had_entry = :ets.lookup(@table, network_id) != []
    :ets.delete(@table, network_id)

    if had_entry do
      Telemetry.circuit_close(network_id, :success)
    end

    {:noreply, state}
  end

  def handle_cast({:cooldown_expire, network_id}, state) do
    # Exactly-once cooldown expiry event. Multiple concurrent check/1 callers
    # may all cast this message, but only the first one to run finds the ETS
    # entry still present and still past cooldown. Subsequent casts are noops.
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@table, network_id) do
      [{_, _, _, :open, cooled_at_ms}] when now >= cooled_at_ms ->
        :ets.delete(@table, network_id)
        Telemetry.circuit_close(network_id, :cooldown_expired)

      _ ->
        # Entry already gone (cleared by another cast or record_success) or
        # state changed — nothing to do.
        :ok
    end

    {:noreply, state}
  end
end
