defmodule Grappa.Visitors.Reaper do
  @moduledoc """
  GenServer that periodically sweeps expired visitor rows out of the
  DB. Runs as a `:permanent` child under the main application
  supervision tree.

  ## Cadence

  Default interval is 60s — configurable via the `:interval_ms`
  start option (the test suite uses small intervals to verify the
  tick path without blocking).

  ## Sweep

  Each tick calls `sweep/0`, which enumerates `Visitors.list_expired/0`
  and invokes `Visitors.delete/1` per row. The DB-level FK ON DELETE
  CASCADE on `visitor_channels`, `messages`, and `accounts_sessions`
  wipes the dependent rows in the same transaction. Per-row failures
  log + continue — one bad row does not stop the sweep.

  Sweeps that delete zero rows stay quiet (no log line); a non-zero
  sweep logs once at `:info` so operators can grep visitor lifecycle
  across the deletion boundary.

  ## Boundary

  `top_level?: true` — Reaper opts out of `Grappa.Visitors`'s
  boundary so the application supervisor can list it as a child
  without dragging the entire Visitors public surface into
  `Grappa.Application`'s deps.
  """

  use Boundary, top_level?: true, deps: [Grappa.Visitors]

  use GenServer

  alias Grappa.Visitors

  require Logger

  @default_interval_ms 60_000

  @type opts :: [interval_ms: pos_integer(), name: GenServer.name()]

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Synchronous sweep — enumerates expired visitors and deletes each
  one. Returns `{:ok, count}` with the number of rows enumerated
  (per-row delete failures still count toward the total because the
  enumeration is the contract; the operator-facing failure surface
  is the `Logger.error` line, not the return value).
  """
  @spec sweep() :: {:ok, non_neg_integer()}
  def sweep do
    expired = Visitors.list_expired()

    Enum.each(expired, fn v ->
      case Visitors.delete(v.id) do
        :ok ->
          :ok

        {:error, reason} ->
          Logger.error("reaper delete failed",
            visitor_id: v.id,
            error: inspect(reason)
          )
      end
    end)

    {:ok, length(expired)}
  end

  @impl GenServer
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    schedule_tick(interval)
    {:ok, %{interval_ms: interval}}
  end

  @impl GenServer
  def handle_info(:tick, state) do
    {:ok, n} = sweep()

    case n do
      0 -> :ok
      _ -> Logger.info("reaper swept expired visitors", affected: n)
    end

    schedule_tick(state.interval_ms)
    {:noreply, state}
  end

  defp schedule_tick(interval), do: Process.send_after(self(), :tick, interval)
end
