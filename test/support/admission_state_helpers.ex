defmodule Grappa.AdmissionStateHelpers do
  @moduledoc """
  Cross-test reset helpers for the application-singleton ETS tables that
  Cluster T31's admission gate relies on.

  ## Why this exists (no-silent-drops B6.8 HIGH-12)

  `Grappa.Admission.NetworkCircuit` + `Grappa.Session.Backoff` are
  application-supervised singletons backed by named ETS tables. Their
  state survives `Ecto.Adapters.SQL.Sandbox` checkout/checkin AND
  `mix test` boundary across container runs (the table is reborn on
  supervisor restart but a stale-from-prior-run row in the live BEAM
  shares its `network_id` with whatever sqlite auto-increment serves
  the next test, producing intermittent `{:network_circuit_open, _}`
  rejections in `BootstrapTest` + `SpawnOrchestratorTest` whose
  surface line/file does not predict the offending pair.

  Five test modules previously inlined the same `for {key, _, _, _, _}
  <- NetworkCircuit.entries(), do: :ets.delete(...)` block. This module
  promotes the cleanup to a reusable verb so adding the equivalent
  block to `BootstrapTest` + `SpawnOrchestratorTest` (the missing
  callers documented in `project_network_circuit_ets_leak`) is a
  one-liner — and the next time the table grows a column the cleanup
  follows the schema instead of needing five surgical edits.

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

  @doc """
  Clear every per-`network_id` row from the `NetworkCircuit` ETS table
  AND every per-`(subject, network_id)` row from the `Backoff` ETS
  table. Idempotent; safe to call from `setup` even when the tables
  hold no entries. The named tables themselves are NOT torn down —
  they're owned by the application-supervised GenServers and would
  crash the suite if removed under their owners.
  """
  @spec reset_all() :: :ok
  def reset_all do
    reset_network_circuit()
    reset_backoff()
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
end
