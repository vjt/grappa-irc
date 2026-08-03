defmodule Grappa.Repo.BusyRetry do
  @moduledoc """
  Shared SQLite busy-retry engine (#523 / #518).

  SQLite is single-writer at the file level. Under WAL with `pool_size >
  1` a transient write-lock contention (a slow writer held past
  `busy_timeout`) or a pool `queue_timeout` raises — and unless the
  caller rides it out, that transient fault escapes as a **500**. The
  retry/classify discipline shipped inside `Grappa.Scrollback` (#336 /
  #340) for the message hot path ONLY; this module extracts it so EVERY
  write path can wrap its op the same way — "implement once, reuse
  everywhere."

  ## Contract

  `run/1` takes a zero-arity `op` returning `{:ok, term()}` or `{:error,
  Ecto.Changeset.t()}` and returns:

    * `{:ok, term()}` — the op succeeded (possibly after retries).
    * `{:error, Ecto.Changeset.t()}` — a validation failure returned by
      the op. Passed straight through, **never retried** (it is not a
      fault).
    * `{:error, :db_unavailable}` — a TRANSIENT fault
      (`DBConnection.ConnectionError` / a busy-or-locked `%Exqlite.Error{}`)
      that persisted for the whole retry budget. A web caller routes this
      through `FallbackController` to a clean **503** (#518) instead of a
      500 raise.

  A **non-transient** `%Exqlite.Error{}` (syntax / corruption) is NOT
  saturation: retrying only spins. It **re-raises** with its original
  stacktrace — a real bug the operator/CI must see as a loud 500, not one
  masked as transient backpressure (CLAUDE.md "no silent-swallow at
  boundaries"). This is the deliberate divergence from
  `Scrollback.with_pool_retry/1`, whose #336 never-crash-the-session
  contract makes it rescue even this and drop the row; a stateless web
  write has no such contract, so the honest surface is the raise.

  The retry loop runs over a wall-clock BUDGET, sleeping a linear backoff
  capped per attempt, so a normal write caught behind a burst is ridden
  out; only sustained saturation degrades.
  """

  require Logger

  @budget_ms Application.compile_env(:grappa, [:busy_retry, :budget_ms], 1_500)
  @backoff_ms Application.compile_env(:grappa, [:busy_retry, :backoff_ms], 25)
  @backoff_cap_ms Application.compile_env(:grappa, [:busy_retry, :backoff_cap_ms], 200)

  @type fault_kind :: :queue_timeout | :busy_locked

  @typedoc """
  Per-contention observer. Called once per RIDDEN-OUT transient attempt with
  `terminal?: false` (attempt strictly increments 1, 2, …) and once on
  budget-exhaustion with `terminal?: true`. `Grappa.Scrollback` passes
  `&Scrollback.Telemetry.contention/3` here, so its #357 contention counters
  are driven straight off this hook (one engine, no forked emitter).
  """
  @type on_contention :: (fault_kind(), pos_integer(), boolean() -> any())

  @doc """
  Runs `op` with bounded retry over transient SQLite write contention.
  See the moduledoc for the full contract.
  """
  @spec run((-> {:ok, result} | {:error, error})) ::
          {:ok, result} | {:error, error | :db_unavailable}
        when result: var, error: var
  def run(op) when is_function(op, 0), do: run(op, [])

  @doc """
  As `run/1`, with `opts`:

    * `:on_contention` — an `t:on_contention/0` observer (see the type).
  """
  @spec run((-> {:ok, result} | {:error, error}), keyword()) ::
          {:ok, result} | {:error, error | :db_unavailable}
        when result: var, error: var
  def run(op, opts) when is_function(op, 0) and is_list(opts) do
    deadline = System.monotonic_time(:millisecond) + @budget_ms
    loop(op, opts, deadline, 1)
  end

  @spec loop((-> {:ok, result} | {:error, error}), keyword(), integer(), pos_integer()) ::
          {:ok, result} | {:error, error | :db_unavailable}
        when result: var, error: var
  defp loop(op, opts, deadline, attempt) do
    maybe_inject_fault()
    op.()
  rescue
    error in [DBConnection.ConnectionError, Exqlite.Error] ->
      cond do
        not transient_fault?(error) ->
          # Syntax / corruption — retrying spins pointlessly. Re-raise with
          # the original stacktrace so it surfaces as a loud 500, not a 503.
          reraise error, __STACKTRACE__

        System.monotonic_time(:millisecond) < deadline ->
          on_contention(opts, fault_kind(error), attempt, false)
          # The backoff sleep runs after the failed checkout was already
          # released, so it holds no connection — bounded backpressure on the
          # flooding caller, not a held-conn leak (#340).
          Process.sleep(min(@backoff_ms * attempt, @backoff_cap_ms))
          loop(op, opts, deadline, attempt + 1)

        true ->
          on_contention(opts, fault_kind(error), attempt, true)

          Logger.warning(
            "db write unavailable: SQLite pool saturated for the full " <>
              "#{@budget_ms}ms retry budget (#{attempt} attempts) — returning :db_unavailable",
            fault: fault_kind(error)
          )

          {:error, :db_unavailable}
      end
  end

  # Invoke the caller's contention observer if one was supplied. Its return is
  # discarded — it is a side-channel (telemetry), not part of the retry result.
  @spec on_contention(keyword(), fault_kind(), pos_integer(), boolean()) :: :ok
  defp on_contention(opts, kind, attempt, terminal?) do
    case Keyword.get(opts, :on_contention) do
      nil -> :ok
      fun when is_function(fun, 3) -> _ = fun.(kind, attempt, terminal?)
    end

    :ok
  end

  @doc """
  Is this caught exception a TRANSIENT write-contention fault (retry) or a
  permanent one (surface at once)? A pool `queue_timeout` is always
  transient; for an `%Exqlite.Error{}` the message text ("busy"/"locked")
  is the only discriminator SQLite gives us. Public so the scrollback
  wrapper reuses the SAME classifier rather than forking one.
  """
  @spec transient_fault?(Exception.t()) :: boolean()
  def transient_fault?(%DBConnection.ConnectionError{}), do: true

  def transient_fault?(%Exqlite.Error{message: message}) when is_binary(message) do
    downcased = String.downcase(message)
    String.contains?(downcased, "busy") or String.contains?(downcased, "locked")
  end

  def transient_fault?(%Exqlite.Error{}), do: false

  # Only reached after `transient_fault?/1` returned true, so an
  # `%Exqlite.Error{}` here is always busy/locked and a `ConnectionError`
  # always a pool queue_timeout.
  @spec fault_kind(DBConnection.ConnectionError.t() | Exqlite.Error.t()) :: fault_kind()
  defp fault_kind(%DBConnection.ConnectionError{}), do: :queue_timeout
  defp fault_kind(%Exqlite.Error{}), do: :busy_locked

  ## ----- Test-only fault injection ------------------------------------
  #
  # The pool_size:1 SQL Sandbox cannot reproduce a real, fast SQLITE_BUSY
  # (busy_timeout 30s, queue_target 5s, a single shared connection = no
  # self-contention), so an end-to-end 503/degrade path (#518) cannot be
  # proven with a genuine fault. This seam lets a test force the next ops in
  # THIS process to raise a transient busy. It is COMPILE-GATED to
  # `Mix.env() == :test`: every other build compiles `maybe_inject_fault/0`
  # to a no-op (dead-code-eliminated), so prod carries no injectable
  # behaviour and pays nothing. Scoped to the calling process's dictionary,
  # so it auto-clears with the test process and cannot leak into a sibling
  # test (unlike a global `:persistent_term`).

  if Mix.env() == :test do
    @fault_pdict_key {__MODULE__, :inject_transient_faults}

    # #594 — cross-process arming lives in a shared ETS table keyed by the
    # TARGET pid. The process-dictionary seam above only reaches work in the
    # caller's own process; a fault that must fire inside a Phoenix Channel,
    # a Session.Server, or a sink GenServer needs to be armed against THAT
    # pid from a test running in a DIFFERENT process. Keyed by the exact
    # target pid, the isolation is identical to the process dictionary's (a
    # concurrent async test operates on its OWN spawned pid and reads `[]`),
    # only externally addressable — so async tests never bleed. The table is
    # created ONCE by the ExUnit runner in `test_helper.exs` (owned by that
    # long-lived process, never created lazily here — that would race
    # `:ets.new` across async tests).
    @fault_ets_table :grappa_busy_retry_cross_process_faults

    @doc false
    @spec inject_transient_faults(non_neg_integer()) :: :ok
    def inject_transient_faults(n) when is_integer(n) and n >= 0 do
      Process.put(@fault_pdict_key, n)
      :ok
    end

    @doc false
    # Arm `n` transient busy faults against `pid`. `fire_on` is 1-indexed and
    # REQUIRED — there is deliberately NO immediate-mode 2-arity: an
    # `arm_faults(pid, n)` whose two args left "WHEN does the fault fire?"
    # implicit is a default argument in disguise, the silent-degradation path
    # CLAUDE.md bans. Making `fire_on:` explicit at every call site is the point
    # (the 40%-doctor-floor artifact #621 is a side effect, not the reason).
    #
    # The fault rides out the first `fire_on - 1` fault-CHECKS in `pid`, then
    # fires from the `fire_on`-th check until `n` is exhausted. A "check" is one
    # `maybe_inject_fault/0` at the top of a `BusyRetry.run/1` attempt — NOT a
    # raw `Repo` call and NOT an operation. `fire_on: 1` fires on the VERY NEXT
    # check (channel / reaper immediate case); a higher value is how #594 pins
    # the query-window auto-open terminal — persist + its preload each make one
    # wrapped call BEFORE the open, so a single per-pid counter cannot otherwise
    # distinguish "fault the open" from "fault the persist". The exact `fire_on`
    # is DETERMINED EMPIRICALLY per flow (see the #594 session test); a change in
    # how many `BusyRetry.run` calls precede the open is MEANT to break it.
    #
    # Callers MUST `on_exit` a `disarm_faults/1` — a fault left armed on a pid
    # that outlives the test is a failure-at-a-distance (the worst kind to
    # diagnose). Stored as a 3-tuple `{pid, remaining, skip}` where `skip`
    # counts down on each pre-fire check.
    @spec arm_faults(pid(), non_neg_integer(), [{:fire_on, pos_integer()}]) :: :ok
    def arm_faults(pid, n, fire_on: fire_on)
        when is_pid(pid) and is_integer(n) and n >= 0 and is_integer(fire_on) and fire_on >= 1 do
      true = :ets.insert(@fault_ets_table, {pid, n, fire_on - 1})
      :ok
    end

    @doc false
    @spec disarm_faults(pid()) :: :ok
    def disarm_faults(pid) when is_pid(pid) do
      true = :ets.delete(@fault_ets_table, pid)
      :ok
    end

    @doc false
    # Create the cross-process fault table. Called ONCE by `test_helper.exs`
    # from the ExUnit runner process so the `:public` table outlives every
    # test. Idempotent (a re-run finds the table already there).
    @spec ensure_fault_table() :: :ok
    def ensure_fault_table do
      case :ets.whereis(@fault_ets_table) do
        :undefined ->
          :ets.new(@fault_ets_table, [:named_table, :public, :set])
          :ok

        _ ->
          :ok
      end
    end

    # pdict FIRST (the existing in-process seam — every already-green test
    # keeps arming through it, untouched), ETS second (the #594 cross-process
    # seam). Both are pid-scoped, so the order is a pure preference, not a
    # correctness requirement.
    defp maybe_inject_fault do
      cond do
        consume_pdict_fault?() -> raise_injected_busy()
        consume_ets_fault?() -> raise_injected_busy()
        true -> :ok
      end
    end

    @spec consume_pdict_fault?() :: boolean()
    defp consume_pdict_fault? do
      case Process.get(@fault_pdict_key, 0) do
        n when n > 0 ->
          Process.put(@fault_pdict_key, n - 1)
          true

        _ ->
          false
      end
    end

    @spec consume_ets_fault?() :: boolean()
    defp consume_ets_fault? do
      case :ets.lookup(@fault_ets_table, self()) do
        # Still inside the pre-fire window: count this check, let it pass.
        [{pid, n, skip}] when skip > 0 ->
          :ets.insert(@fault_ets_table, {pid, n, skip - 1})
          false

        # Fire window reached and faults remain: consume one and raise.
        [{pid, n, 0}] when n > 0 ->
          :ets.insert(@fault_ets_table, {pid, n - 1, 0})
          true

        _ ->
          false
      end
    end

    # "Database busy" is the VERBATIM message a real write-lock SQLITE_BUSY
    # raises through Ecto (proven by `Grappa.Repo.BusyRetryFidelityTest`, and
    # the #523 prod evidence) — so the injected fault is byte-faithful to
    # reality, not a shape we merely know our own classifier accepts.
    @spec raise_injected_busy() :: no_return()
    defp raise_injected_busy do
      raise %Exqlite.Error{message: "Database busy", statement: nil}
    end
  else
    defp maybe_inject_fault, do: :ok
  end
end
