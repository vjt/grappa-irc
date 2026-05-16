defmodule Grappa.Admission.NetworkCircuit.AdminWire do
  @moduledoc """
  Operator-facing JSON projection for `Grappa.Admission.NetworkCircuit`
  ETS entries (M-cluster M-5 `GET /admin/networks`,
  `POST /admin/circuit/:network_id/reset`).

  ## Why a wire module

  NetworkCircuit stores per-network state as a 5-tuple
  `{network_id, count, window_start_ms, state, cooled_at_ms}` keyed
  on monotonic time — operator-meaningful but raw. The wire shape
  flattens the tuple to a map + derives `retry_after_seconds`
  (`ceil((cooled_at_ms - now) / 1_000)` for `:open`, else `0`) so the
  cic admin pane renders directly without re-implementing the
  derivation.

  `entry_to_admin_json/2` takes `now_ms` injected so tests don't have
  to freeze `System.monotonic_time/1` — single derivation site, no
  drift risk.

  ## `nil`-vs-:closed semantics

  `nil` IN means "no ETS row for this network_id" — visually distinct
  from "had failures, then cleared". The cic side renders `nil` as
  "—" and a populated entry as a state badge. Caller
  (`Networks.AdminWire`) maps `nil` ETS lookup to `nil` here; we do
  not synthesize a `:closed` shape for missing rows.
  """

  alias Grappa.Admission.NetworkCircuit

  @type t :: %{
          state: String.t(),
          failure_count: non_neg_integer(),
          window_start_ms: integer(),
          cooled_at_ms: integer(),
          retry_after_seconds: non_neg_integer()
        }

  @doc """
  Project a NetworkCircuit ETS entry (or `nil`) to the admin JSON
  shape. `now_ms` is the monotonic clock reading to derive
  `retry_after_seconds` from; inject from the caller so tests can
  pin the clock.
  """
  @spec entry_to_admin_json(NetworkCircuit.entry() | nil, integer()) :: t() | nil
  def entry_to_admin_json(nil, _), do: nil

  def entry_to_admin_json(
        {_, count, window_start_ms, state, cooled_at_ms},
        now_ms
      )
      when is_integer(now_ms) do
    %{
      state: Atom.to_string(state),
      failure_count: count,
      window_start_ms: window_start_ms,
      cooled_at_ms: cooled_at_ms,
      retry_after_seconds: retry_after_seconds(state, cooled_at_ms, now_ms)
    }
  end

  defp retry_after_seconds(:open, cooled_at_ms, now_ms) when cooled_at_ms > now_ms,
    do: ceil((cooled_at_ms - now_ms) / 1_000)

  defp retry_after_seconds(_, _, _), do: 0
end
