defmodule Grappa.Health do
  @moduledoc """
  Substrate-readiness signal for `/healthz` (review H26).

  Pre-REV-C `/healthz` returned 200 the moment Phoenix.Endpoint
  answered — completely blind to the supervision tree's actual
  state. A wedged-BEAM scenario (`Phoenix.CodeReloader` accepted a
  reload but the next message crash-loops Bootstrap on a shape
  mismatch; supervisor on restart-cooldown) kept passing healthy
  until the failing message landed. Docker HEALTHCHECK same shape —
  the container stayed marked healthy on a comatose runtime.

  H26 adds three boundary checks at `/healthz` request time:

    1. `ready?/0` — flipped to `true` by Grappa.Application's start
       callback AFTER `Supervisor.start_link/2` returns clean. `false`
       until then. NOTE: `:persistent_term` survives top-supervisor
       restarts within the same BEAM (release-boot crash-loops are a
       separate process), so if the supervision tree later wedges
       (e.g. a sub-tree crash-loop after first-boot success) this
       flag stays `true`. That gap is covered by the Repo + ETS
       checks below — operator chases the specific failed check.
    2. `Repo.query("SELECT 1")` — runtime sqlite + WAL liveness. The
       canonical wedge: pool exhausted, file lock held, sqlite-lib
       upgrade broke the binding.
    3. ETS tables for long-lived singletons present — covers a
       "supervisor restarted but the ETS table init/1 hasn't run"
       race.

  The signal is single-sourced via `:persistent_term`. Lock-free
  read, single boot-time write. Per CLAUDE.md "Application.{put,get}_env:
  boot-time only, runtime banned" — `:persistent_term` is the
  documented analog for "boot-once readonly". Tests opt-in via
  `mark_ready/0` after their own `Application.ensure_all_started`
  cycle (the test env doesn't run Grappa.Application's start-
  callback end-of-init mark — see `config/test.exs`).
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Repo,
      # The ETS singletons whose presence the substrate check verifies.
      # Coupling on each module's public `table_name/0` API (REV-C
      # reviewer LOW-1) — single-sourced, so renaming the @table atom in
      # any of them surfaces a Health check failure on next deploy rather
      # than silently diverging here.
      Grappa.Session,
      Grappa.Admission,
      Grappa.Net.PtrCache
    ]

  @persistent_term_key {__MODULE__, :ready}

  @doc """
  Returns `true` once the supervision tree's first-pass boot has
  completed cleanly. Defaults to `false` (no key in
  `:persistent_term` yet).
  """
  @spec ready?() :: boolean()
  def ready? do
    :persistent_term.get(@persistent_term_key, false)
  end

  @doc """
  Mark the supervision tree as ready. Called by Grappa.Application's
  start callback AFTER `Supervisor.start_link/2` returns ok. Test
  setups MAY call this directly when they exercise the `/healthz`
  controller and don't want a false 503.
  """
  @spec mark_ready() :: :ok
  def mark_ready do
    :persistent_term.put(@persistent_term_key, true)
  end

  @doc """
  Reset the readiness flag. Test-only utility — `unmark` lets a
  controller test exercise the 503 branch without a global state
  leak.
  """
  @spec mark_not_ready() :: :ok
  def mark_not_ready do
    :persistent_term.put(@persistent_term_key, false)
  end

  @typedoc "Per-check result. `:ok` or `{:fail, reason}`."
  @type check :: :ok | {:fail, String.t()}

  @typedoc """
  Aggregate substrate-check result. `:ok` when every check passed;
  `{:fail, failures}` lists each failing check by name.
  """
  @type result :: :ok | {:fail, [{atom(), String.t()}]}

  @doc """
  Run every substrate check. Returns `:ok` if all pass; otherwise
  `{:fail, [{check_name, reason}, ...]}`.

  Checks:

    * `:ready` — `ready?/0` is `true` (Application.start completed)
    * `:repo` — `Repo.query("SELECT 1")` succeeds
    * `:ets` — long-lived ETS tables exist for the singletons that
      own them (`Grappa.Session.Backoff`, `Grappa.Admission.NetworkCircuit`)

  Per `feedback_silent_retry_anti_pattern`: surface the wedge, don't
  paper over it. A failing check returns the specific reason so
  operator can grep `/healthz` failure logs.
  """
  @spec check() :: result()
  def check do
    checks = [
      {:ready, check_ready()},
      {:repo, check_repo()},
      {:ets, check_ets()}
    ]

    failures =
      for {name, {:fail, reason}} <- checks do
        {name, reason}
      end

    case failures do
      [] -> :ok
      _ -> {:fail, failures}
    end
  end

  @spec check_ready() :: check()
  defp check_ready do
    if ready?() do
      :ok
    else
      {:fail, "supervision tree boot not complete"}
    end
  end

  @spec check_repo() :: check()
  defp check_repo do
    case Grappa.Repo.query("SELECT 1") do
      {:ok, _} -> :ok
      {:error, %{message: msg}} -> {:fail, "Repo.query failed: #{msg}"}
      {:error, other} -> {:fail, "Repo.query failed: #{inspect(other)}"}
    end
  rescue
    e -> {:fail, "Repo.query raised: #{Exception.message(e)}"}
  end

  @spec check_ets() :: check()
  defp check_ets do
    # Pull the table atoms from the SoT modules (REV-C reviewer LOW-1:
    # single-source the coupling boundary so a rename of the @table
    # in either module surfaces an ETS check failure on the next
    # deploy rather than silently diverging here).
    required = [
      Grappa.Session.Backoff.table_name(),
      Grappa.Admission.NetworkCircuit.table_name(),
      Grappa.Net.PtrCache.table_name()
    ]

    missing = Enum.reject(required, &table_exists?/1)

    case missing do
      [] -> :ok
      _ -> {:fail, "ETS table missing: #{Enum.map_join(missing, ", ", &inspect/1)}"}
    end
  end

  @spec table_exists?(atom()) :: boolean()
  defp table_exists?(name) do
    case :ets.info(name) do
      :undefined -> false
      _ -> true
    end
  end
end
