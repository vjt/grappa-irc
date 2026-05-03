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
  alias Grappa.RateLimit.JitteredCooldown

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
          # [:grappa, :admission, :circuit, :close] event with metadata
          # %{reason: :cooldown_expired} per transition. The observed
          # `cooled_at_ms` rides along as an observation token: the cast
          # handler match-spec verifies the ETS row still has the same
          # token, so a re-open between observation and cast handling
          # (different `cooled_at_ms`) cleanly no-ops without emitting
          # a bogus :close. Mailbox serialization + token match guarantee
          # exactly-once delivery for any given open→cooldown→close epoch.
          GenServer.cast(__MODULE__, {:cooldown_expire, network_id, cooled_at_ms})
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

    case :ets.lookup(@table, network_id) do
      [] ->
        # No prior row. Delegating to handle_closed_failure/4 with
        # prior_count=0, prior_start=now keeps the threshold-crossing
        # decision in one place: the `now - prior_start > @window_ms`
        # branch is false (now - now == 0), so logic falls through to
        # `prior_count + 1 >= @threshold` (= `1 >= @threshold`) — opens
        # the circuit immediately when threshold == 1, otherwise writes
        # a fresh count=1 :closed row. Identical semantics to a direct
        # insert without duplicating the threshold check.
        handle_closed_failure(network_id, 0, now, now)
        {:noreply, state}

      [{_, prior_count, prior_start, :closed, _}] ->
        handle_closed_failure(network_id, prior_count, prior_start, now)
        {:noreply, state}

      [{_, _, _, :open, cooled_at_ms}] when now < cooled_at_ms ->
        # Still cooling down. No half-open per moduledoc — drop the
        # failure silently. The :cooldown_expire cast (when it fires)
        # will handle the open→closed transition with correct telemetry.
        {:noreply, state}

      [{_, _, _, :open, _}] ->
        # Cooldown elapsed but the :cooldown_expire cast hasn't been
        # processed yet (or was never observed because no check/1 raced
        # past it). Treat as a fresh window starting now: write a new
        # :closed row with count=1, cooled_at=0. Any deferred
        # :cooldown_expire cast carrying the OLD observed cooled_at_ms
        # will mismatch on the H6 token pin and no-op cleanly.
        handle_closed_failure(network_id, 0, now, now)
        {:noreply, state}
    end
  end

  def handle_cast({:success, network_id}, state) do
    # Emit close event only on a true open→closed transition. A sub-threshold
    # accruing-failures entry (state :closed) being cleared on success is not
    # a circuit close — the circuit was never open. Phase 5 PromEx consumers
    # count transitions; a spurious :close would skew the metric.
    was_open =
      case :ets.lookup(@table, network_id) do
        [{_, _, _, :open, _}] -> true
        _ -> false
      end

    :ets.delete(@table, network_id)

    if was_open do
      Telemetry.circuit_close(network_id, :success)
    end

    {:noreply, state}
  end

  def handle_cast({:cooldown_expire, network_id, observed_cooled_at}, state) do
    # Exactly-once cooldown expiry event, with H6 observation-token guard:
    # the cast carries the `cooled_at_ms` the caller observed in check/1, and
    # this handler match-pins it against the current ETS row. A match means
    # the row hasn't mutated since observation (which by construction was
    # past cooldown) — safe to delete + emit :close. A mismatch means the
    # state moved on (re-opened with a fresh `cooled_at_ms`, cleared by
    # record_success, or already deleted by a sibling cast) — no-op, no
    # spurious telemetry. Token match obviates the now >= cooled_at_ms
    # re-check: if the row still matches the observed token, we already
    # know it was past cooldown.
    case :ets.lookup(@table, network_id) do
      [{_, _, _, :open, ^observed_cooled_at}] ->
        :ets.delete(@table, network_id)
        Telemetry.circuit_close(network_id, :cooldown_expired)

      _ ->
        :ok
    end

    {:noreply, state}
  end

  # Apply the count/window/threshold transition for a :closed (or equivalent
  # fresh-window) prior state. Three branches:
  #
  #   - now - prior_start > @window_ms  → window expired; reset count to 1.
  #   - prior_count + 1 >= @threshold   → threshold crossed; open circuit.
  #   - otherwise                       → bump count, stay :closed.
  @spec handle_closed_failure(integer(), non_neg_integer(), integer(), integer()) :: :ok
  defp handle_closed_failure(network_id, prior_count, prior_start, now) do
    cond do
      now - prior_start > @window_ms ->
        :ets.insert(@table, {network_id, 1, now, :closed, 0})
        :ok

      prior_count + 1 >= @threshold ->
        cooldown = JitteredCooldown.compute(@cooldown_ms, @jitter_pct)
        :ets.insert(@table, {network_id, prior_count + 1, prior_start, :open, now + cooldown})
        Telemetry.circuit_open(network_id, @threshold, @cooldown_ms)
        :ok

      true ->
        :ets.insert(@table, {network_id, prior_count + 1, prior_start, :closed, 0})
        :ok
    end
  end
end
