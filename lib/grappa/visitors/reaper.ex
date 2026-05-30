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
  CASCADE on `messages`, `query_windows`,
  `push_subscriptions`, `user_settings`, and `read_cursors` (every
  table that carries a `visitor_id` FK after the visitor-parity
  cluster) wipes the dependent rows in the same transaction.
  `accounts_sessions` also CASCADEs — the bearer token of an
  expired visitor dies with the row. Per-row failures log + continue
  — one bad row does not stop the sweep.

  `Visitors.list_expired/0` carries an explicit `expires_at IS NOT
  NULL` guard so V7 (NickServ-identified visitors persist forever
  via `expires_at = NULL`) requires no coordinated change here —
  the column was flipped to nullable in
  `20260515111331_visitors_expires_at_nullable`. Reaper sees only
  rows that have OPTED IN to expiry by setting a non-NULL timestamp.

  Sweeps that delete zero rows stay quiet (no log line); a non-zero
  sweep logs once at `:info` so operators can grep visitor lifecycle
  across the deletion boundary.

  ## Boundary

  `top_level?: true` — Reaper opts out of `Grappa.Visitors`'s
  boundary so the application supervisor can list it as a child
  without dragging the entire Visitors public surface into the
  application's deps (see `lib/grappa/application.ex`).
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.AdminEvents, Grappa.Networks, Grappa.Session, Grappa.Visitors]

  use GenServer

  alias Grappa.{AdminEvents, Networks, Session, Visitors}
  alias Grappa.AdminEvents.Wire, as: AdminWire

  require Logger

  @default_interval_ms 60_000

  @type opts :: [interval_ms: pos_integer(), name: GenServer.name()]

  defstruct [:interval_ms]

  @type t :: %__MODULE__{interval_ms: pos_integer()}

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Synchronous sweep — enumerates expired visitors, stops each visitor's
  live `Session.Server` when its network still exists, then deletes the
  row. Returns `{:ok, count}` with the number of rows successfully
  deleted. Per-row stop/delete failures log + continue; the
  operator-facing failure surface is the `Logger.error` line, not the
  return value.
  """
  @spec sweep() :: {:ok, non_neg_integer()}
  def sweep do
    expired = Visitors.list_expired()

    deleted =
      Enum.reduce(expired, 0, fn v, acc ->
        case reap_visitor(v) do
          :ok ->
            # M-11: per-row reap event for the admin events stream.
            # Emitted ONLY on successful delete — a failed delete logs
            # but doesn't fire a misleading "reaped" signal.
            :ok = AdminEvents.record(AdminWire.visitor_reaped(v.id, v.nick, v.network_slug))
            acc + 1

          {:error, reason} ->
            Logger.error("reaper delete failed",
              visitor_id: v.id,
              error: inspect(reason)
            )

            acc
        end
      end)

    {:ok, deleted}
  end

  @spec reap_visitor(Visitors.Visitor.t()) :: :ok | {:error, :not_found}
  defp reap_visitor(v) do
    with :ok <- stop_visitor_session(v),
         :ok <- Visitors.delete(v.id) do
      :ok
    end
  end

  @spec stop_visitor_session(Visitors.Visitor.t()) :: :ok
  defp stop_visitor_session(%Visitors.Visitor{id: id, network_slug: slug}) do
    case Networks.get_network_by_slug(slug) do
      {:ok, network} ->
        :ok = Session.stop_session({:visitor, id}, network.id)

      {:error, :not_found} ->
        # Same orphan-network shape as Operator.delete_visitor/1: no
        # network row means no viable live session can be resolved from
        # the visitor row, but the DB delete still reaches the promised
        # post-condition via CASCADE. Keep this informational, not an
        # error, so one stale slug does not poison the whole sweep.
        Logger.warning("reaper visitor network missing; deleting row without session stop",
          visitor_id: id,
          network: slug
        )

        :ok
    end
  end

  @impl GenServer
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    schedule_tick(interval)
    {:ok, %__MODULE__{interval_ms: interval}}
  end

  @impl GenServer
  def handle_info(:tick, state) do
    # REV-J M9: schedule the next tick BEFORE running the sweep so the
    # cadence is interval-fixed, not "interval + sweep_duration". Pre-fix
    # the schedule call lived after `sweep/0` returned; a slow Cloak
    # decrypt or a backlog of expired rows (each delete CASCADEs across
    # 7 dependent tables) could realistically take seconds, drifting
    # the wall-clock cadence under load. With the scheduling first,
    # sweep duration is consumed within the interval rather than
    # extending it — if a sweep ever exceeds the interval, the next
    # `:tick` message piles up in the mailbox and runs back-to-back,
    # which is the right shape ("never less frequent than configured").
    schedule_tick(state.interval_ms)
    {:ok, n} = sweep()

    # M-11: scheduled-tick :reaper_swept summary — actor is nil
    # because the scheduler is "the system", not an operator.
    # Suppressed on count=0 to avoid flooding the admin events
    # ring buffer (200-cap) with 1440 idle ticks/day. Operator-
    # triggered sweeps emit unconditionally via Operator.reap_visitors/1
    # because operators care that "I clicked the button and
    # something happened, even if nothing was expired."
    case n do
      0 ->
        :ok

      _ ->
        Logger.info("reaper swept expired visitors", affected: n)
        :ok = AdminEvents.record(AdminWire.reaper_swept(n))
    end

    {:noreply, state}
  end

  defp schedule_tick(interval), do: Process.send_after(self(), :tick, interval)
end
