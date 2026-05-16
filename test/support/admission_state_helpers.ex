defmodule Grappa.AdmissionStateHelpers do
  @moduledoc """
  Cross-test reset helpers for the application-singleton ETS tables AND
  `Grappa.SessionSupervisor` Registry that Cluster T31's admission gate
  reads from.

  ## Why this exists (no-silent-drops B6.8 HIGH-12 + T-3 prelude)

  Three application-wide singletons survive `Ecto.Adapters.SQL.Sandbox`
  checkout/checkin AND `mix test` boundary across container runs:

    * `Grappa.Admission.NetworkCircuit` — ETS table `:admission_network_circuit_state`
    * `Grappa.Session.Backoff` — ETS table `:session_backoff_state`
    * `Grappa.SessionSupervisor` + `Grappa.SessionRegistry` — DynamicSupervisor
      children, indexed by `{:session, subject, network_id}`

  All three carry rows keyed by `network_id`. sqlite recycles
  auto-increment rowids per fresh sandbox transaction, so the next
  test's freshly-created network gets the same id as a prior test's
  leftover row → intermittent `{:network_circuit_open, _}` /
  `:visitor_cap_exceeded` / `:user_cap_exceeded` rejections whose
  surface line/file does not predict the offending pair.

  Bootstrap-cap test failure mode (T-2-fix CI red on commit 82096a1,
  2026-05-16): a prior test's Session.Server still registered under
  the same `network_id` as the cap test's fresh row → Admission's
  `count_live_sessions(network_id, _)` returned >= cap → all spawn
  attempts skipped → `{spawned: 0, capacity_rejected: 3}` instead of
  the intended `{spawned: 2, capacity_rejected: 1}`. Per-test-file
  `clear_registry_for(network_id)` polling helpers silently exhausted
  their 500ms budget under CI load (returned `:ok` with zombies still
  present). Loud raise + setup-time global reset is the durable fix.

  ## Usage

      use Grappa.DataCase, async: false

      setup do
        Grappa.AdmissionStateHelpers.reset_all()
        :ok
      end

  Or for granular control:

      setup do
        Grappa.AdmissionStateHelpers.reset_network_circuit()
        :ok
      end
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Admission, Grappa.Session]

  alias Grappa.Admission.NetworkCircuit
  alias Grappa.Session.Backoff

  # 15s budget for the registry-drain loop. The DOWN-after-terminate
  # race is fast locally (~ms) but CI runners are slow + load-burdened;
  # 5s (pre-CP35) was tight enough that interactions between
  # `GrappaChannelTest` (which spawns sessions without on_exit cleanup)
  # AND the BootstrapTest setup that follows tipped over under CI load
  # ~33% of the time. Bumping to 15s costs nothing on the fast path
  # (this loop only iterates until count == 0) and gives the slow CI
  # path enough headroom. Root cause (per-channel-test cleanup) is a
  # separate cluster scope; this is the load-tolerance knob.
  @reset_registry_attempts 600
  @reset_registry_poll_ms 25

  @doc """
  Clear every per-`network_id` row from the `NetworkCircuit` ETS table,
  every per-`(subject, network_id)` row from the `Backoff` ETS table,
  AND terminate every `Grappa.Session.Server` registered under
  `Grappa.SessionSupervisor`. Waits until `Grappa.SessionRegistry`
  observes the cleanup; raises on timeout (loud — silent zombie
  registry rows have already caused intermittent CI failures).
  Idempotent; safe to call from `setup` even when the tables/registry
  hold no entries.
  """
  @spec reset_all() :: :ok
  def reset_all do
    reset_network_circuit()
    reset_backoff()
    reset_session_supervisor()
    :ok
  end

  @doc """
  Clear every row from the `Grappa.Admission.NetworkCircuit` ETS table.
  Reads via the `entries/0` snapshot so a concurrent insert during
  cleanup is not silently skipped (the snapshot is the suite-time
  serial truth).
  """
  @spec reset_network_circuit() :: :ok
  def reset_network_circuit do
    for {network_id, _, _, _, _} <- NetworkCircuit.entries() do
      :ets.delete(:admission_network_circuit_state, network_id)
    end

    :ok
  end

  @doc """
  Clear every row from the `Grappa.Session.Backoff` ETS table. Same
  snapshot semantics as `reset_network_circuit/0`.
  """
  @spec reset_backoff() :: :ok
  def reset_backoff do
    for {key, _, _} <- Backoff.entries() do
      :ets.delete(:session_backoff_state, key)
    end

    :ok
  end

  @doc """
  Terminate every `Grappa.Session.Server` currently under
  `Grappa.SessionSupervisor` (DynamicSupervisor) AND every pid
  still registered under `Grappa.SessionRegistry`. Blocks until
  `Grappa.SessionRegistry` observes the cleanup; raises on timeout
  (loud — silent leak is what made `BootstrapTest:468` intermittent
  under CI load; see `project_network_circuit_ets_leak`).

  Two-step purge: (1) terminate every supervised child via
  `DynamicSupervisor.terminate_child/2`, then (2) sweep the
  Registry separately and `Process.exit(pid, :shutdown)` any
  pid that's still registered. The Registry sweep catches the
  race where a Session.Server died but Registry's link-based
  cleanup hasn't propagated yet — without it the registry-clear
  wait blocks past 15s on CI runners even though all pids are
  long-dead.

  Idempotent: returns `:ok` immediately when both surfaces are clean.
  """
  @spec reset_session_supervisor() :: :ok
  def reset_session_supervisor do
    for {_, pid, _, _} <- DynamicSupervisor.which_children(Grappa.SessionSupervisor),
        is_pid(pid) do
      ref = Process.monitor(pid)
      _ = DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)

      receive do
        {:DOWN, ^ref, :process, ^pid, _} -> :ok
      after
        2_000 ->
          Process.demonitor(ref, [:flush])

          raise "AdmissionStateHelpers.reset_session_supervisor: " <>
                  "Session.Server #{inspect(pid)} did not terminate within 2s"
      end
    end

    # Registry sweep — catches Session.Servers that crashed unsupervised
    # OR whose Registry link cleanup hasn't propagated yet. Send
    # `:shutdown` rather than `:kill` so terminate/2 still runs if the
    # pid is alive; if dead, no-op.
    leftover_pids = Registry.select(Grappa.SessionRegistry, [{{:_, :"$1", :_}, [], [:"$1"]}])

    Enum.each(leftover_pids, fn pid ->
      if Process.alive?(pid) do
        ref = Process.monitor(pid)
        Process.exit(pid, :shutdown)

        receive do
          {:DOWN, ^ref, :process, ^pid, _} -> :ok
        after
          2_000 -> Process.demonitor(ref, [:flush])
        end
      end
    end)

    wait_until_registry_clear!(@reset_registry_attempts)
  end

  defp wait_until_registry_clear!(0) do
    count = Registry.count(Grappa.SessionRegistry)

    raise "AdmissionStateHelpers.reset_session_supervisor: " <>
            "Grappa.SessionRegistry still has #{count} entries after " <>
            "#{@reset_registry_attempts * @reset_registry_poll_ms}ms"
  end

  defp wait_until_registry_clear!(attempts) do
    if Registry.count(Grappa.SessionRegistry) == 0 do
      :ok
    else
      Process.sleep(@reset_registry_poll_ms)
      wait_until_registry_clear!(attempts - 1)
    end
  end
end
