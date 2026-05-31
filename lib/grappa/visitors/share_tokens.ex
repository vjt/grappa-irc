defmodule Grappa.Visitors.ShareTokens do
  @moduledoc """
  ETS-backed one-shot consumption set for visitor share-token IDs.

  ## What this owns

  A single named ETS table that records which Phoenix-signed share
  tokens have already been redeemed. The token signing + TTL check
  live in `GrappaWeb.AuthController` (Phoenix.Token.sign/verify); this
  module is just the "has this token already been used?" ledger.

  ## Why

  The share-link flow (visitor mints a token on device A, opens it on
  device B) needs one-shot semantics: a token verifies-once and is
  thereafter rejected, even if the link is forwarded or clicked twice
  by accident. Phoenix.Token alone doesn't track consumption — its
  signature + TTL just say "this token is well-formed and not stale."
  We layer one-shot on top via `:ets.insert_new/2`'s atomic insert.

  ETS over DB by intent: the threat model is benign (operator clicks
  their own link twice), and TTL is short (≤15 min). Losing the
  consumed-set on a BEAM restart opens a small reuse window for any
  unconsumed-but-signed tokens still inside their TTL — acceptable
  for this surface. A future hardening path (DB table with
  `consumed_at` + reaper) is a mechanical migration if the threat
  model ever shifts.

  ## API contract

    * `mark_consumed/1 :: :ok | {:error, :already_consumed}` —
      atomic insert-if-absent. Caller MUST treat
      `{:error, :already_consumed}` as a hard reject (HTTP 410 Gone).
    * `all_keys/0` — test helper, returns the set of recorded tokens.

  ## Crash boundary

  Application.ex starts this GenServer BEFORE the Endpoint, so the
  consume controller can never see a missing table. A genuine crash
  of this GenServer would destroy the table; the supervisor's
  `:permanent` policy respawns within ~1ms. During that window
  callers would see `ArgumentError` on `:ets.insert_new/2`, which
  propagates as a 500 — the right outcome (operator sees the wedge,
  retry succeeds). Per CLAUDE.md "Defensive programming hides bugs"
  we do NOT rescue the missing-table case.

  ## Test isolation

  Application-wide singleton (`name: __MODULE__`, ETS table
  `:visitor_share_tokens_used`) shared across the entire `mix test`
  run. `config :ex_unit, max_cases: 1` in `config/test.exs` is the
  global guard. Tests touching this module MUST stay `async: false`
  even if `max_cases` is later relaxed for a faster lane.

  ## Telemetry

  None at this layer — the controllers emit
  `[:grappa, :visitor, :share_token, :consumed | :rejected]` with
  rich metadata. Surfacing telemetry from the ETS lookup itself
  would be noise.

  ## Boundary

  `top_level?: true` — opts out of `Grappa.Visitors`'s boundary so
  the application supervisor + downstream controllers can reach the
  module without dragging the entire Visitors public surface into
  their deps (mirrors `Grappa.Visitors.Reaper`).
  """
  use Boundary, top_level?: true, deps: []

  use GenServer

  @table :visitor_share_tokens_used

  @doc """
  Returns the ETS table atom — public surface so callers / tests
  single-source the table-name boundary instead of duplicating the
  literal.
  """
  @spec table_name() :: :visitor_share_tokens_used
  def table_name, do: @table

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  @doc """
  Atomically record `token` as consumed. Returns `:ok` if this call
  was the first to record it; `{:error, :already_consumed}` if a
  previous call (possibly from another pid) already did.

  Race-safe via `:ets.insert_new/2` (BIF, atomic against concurrent
  callers). No GenServer roundtrip — readers race directly against
  the ETS table.
  """
  @spec mark_consumed(binary()) :: :ok | {:error, :already_consumed}
  def mark_consumed(token) when is_binary(token) do
    if :ets.insert_new(@table, {token, System.monotonic_time(:millisecond)}) do
      :ok
    else
      {:error, :already_consumed}
    end
  end

  @doc false
  @spec all_keys() :: [binary()]
  def all_keys do
    @table
    |> :ets.tab2list()
    |> Enum.map(fn {key, _} -> key end)
  end

  ## GenServer

  @impl GenServer
  def init(_) do
    _ = :ets.new(@table, [:named_table, :set, :public, read_concurrency: true, write_concurrency: true])
    {:ok, %{}}
  end
end
