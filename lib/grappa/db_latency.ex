defmodule Grappa.DbLatency do
  @moduledoc """
  Interim in-code telemetry handler for #357 — SQLite write-latency
  diagnostics + the broader repo query-latency profile.

  #357 Deliverable 1 shipped the emitters (`Grappa.Scrollback.Telemetry`,
  the `send_privmsg` span) but by deliberate design "no handler ships by
  default" — the eventual consumer is a Phase-5 PromEx exporter. In the
  meantime the operator had to hand-attach a forwarder over `rpc` on the
  live node, which a restart wipes (verified after the 0.5.0 cold: the
  handler was gone). This module makes the consumer PERMANENT INFRA: a
  supervised singleton attached at boot that survives every restart, so
  the 25s-under-load sample is a `bin/grappa` verb / admin GET away
  instead of a hand-attach that evaporates.

  It is a HANDLER, not a new emitter and not a metrics framework: it
  attaches to telemetry events that already exist and folds their
  measurements into small in-memory running counters. No Repo, no
  PubSub, no schema.

  ## Three signal families, one handler

  The handler consumes both the D1 write-path spans AND Ecto's built-in
  per-query telemetry, because the two answer two different open
  questions on #357:

    * **`[:grappa, :repo, :query]`** — Ecto's per-query event, bucketed by
      `{source, op}` (op derived from the SQL: `:select | :insert |
      :update | :delete | :count | :other`). This reproduces the baseline
      table that gates the FIX-B / #395 decision ("is the badge /
      `count_after_split` path still a top DB-time consumer under load?").
      It spans READS too — and reads dominate DB time — so a write-only
      instrument could not answer it. `total_time` + `queue_time` are
      accumulated (native units) per bucket.

    * **The D1 write-path spans** — for the deferred "busier channel =
      slower send" investigation. Three mechanisms, read apart from these
      rows:
        - **mechanism 1 (mailbox head-of-line):** `send_privmsg.mean_ms −
          persist.mean_ms`. The send span is the total round-trip incl.
          mailbox queue-wait; persist is the pure insert. A large gap =
          the sender's own `handle_call` queued behind a busy channel's
          synchronous inbound inserts.
        - **mechanism 2 (single-writer contention):** the `contention`
          row — `queue_timeout` / `busy_locked` counts, and `dropped`
          (budget-exhausted rows lost).
        - **mechanism 3 (pure insert / index write-amplification):** the
          `persist` row `mean_ms` on its own, watched as the table grows.

    * **`[:grappa, :repo, :lock_stall, :detected | :resolved]`** (#1420) —
      the write-lock HOLDER, which neither family above can see. Both of
      them are completion-driven, so a process sitting idle inside
      `BEGIN IMMEDIATE` emits nothing while it sits and only its victims
      show up (as 30.1s `busy_timeout` rows). `Grappa.Repo.LockWatch`
      reads at the seam instead and hands over the holder's sampled stack
      plus the queue behind it; here they are kept as a bounded ring, so
      the existing CLI and admin doors surface them with no new noun.

  ## Reading a window

  Counters are cumulative-since-boot (or since the last `reset/0`). To
  take a 25s sample under load: `reset/0` → wait 25s → `snapshot/0`.
  Both doors drive the same context functions (one feature, one code
  path, every door):

    * CLI: `bin/grappa db-latency` / `bin/grappa db-latency-reset`
      (`Grappa.Operator.db_latency_text!/0` / `reset_db_latency!/0`).
    * HTTP: `GET /admin/db_latency` / `POST /admin/db_latency/reset`
      (`GrappaWeb.Admin.DbLatencyController`, `:admin_authn`-gated).

  ## Restart strategy

  `:permanent` (infrastructure). Crashing forgets the in-memory counters
  but the telemetry handler re-attaches on `init/1`; a fresh window
  starts populating immediately. The whole point is restart survival, so
  it is wired at boot in `Grappa.Application`, not hand-attached.

  ## Test isolation

  Singleton (registered as `__MODULE__`). Boots with
  `attach_telemetry: false` under test (`config/test.exs`) so the global
  handler doesn't fold every async test's queries into the shared
  singleton; telemetry tests attach explicitly and drain via `reset/0`.
  """

  use Boundary, top_level?: true, deps: []

  use GenServer

  @handler_id "grappa-db-latency"
  @events [
    [:grappa, :repo, :query],
    [:grappa, :scrollback, :persist, :stop],
    [:grappa, :session, :send_privmsg, :stop],
    [:grappa, :scrollback, :persist, :contention],
    [:grappa, :repo, :lock_stall, :detected],
    [:grappa, :repo, :lock_stall, :resolved]
  ]

  # #1420 — the lock-stall ring is bounded: these rows carry sampled
  # stacktraces, so an unbounded list would grow the singleton's heap for as
  # long as the node stays up. Twenty episodes is far more than any single
  # incident produces and still fits in one admin response.
  @lock_stall_ring 20

  @type op :: :select | :insert | :update | :delete | :count | :other

  @type query_row :: %{
          source: String.t() | nil,
          op: op(),
          n: non_neg_integer(),
          total_ms: float(),
          queue_ms: float(),
          mean_ms: float()
        }

  @type span_row :: %{
          n: non_neg_integer(),
          total_ms: float(),
          mean_ms: float(),
          outcomes: %{atom() => non_neg_integer()}
        }

  @type contention_row :: %{
          n: non_neg_integer(),
          queue_timeout: non_neg_integer(),
          busy_locked: non_neg_integer(),
          dropped: non_neg_integer()
        }

  @typedoc """
  One write-lock stall episode (#1420). `:detected` carries the holder's
  sampled stack and the queue behind it; `:resolved` brackets the same
  episode with the TOTAL hold and no samples (by then there is nothing left
  to sample). Newest first.
  """
  @type lock_stall_row :: %{
          phase: :detected | :resolved,
          holder_pid: String.t(),
          held_ms: non_neg_integer(),
          waiter_count: non_neg_integer(),
          holder: map() | nil,
          waiters: [map()]
        }

  @type snapshot :: %{
          queries: [query_row()],
          send_privmsg: span_row(),
          persist: span_row(),
          contention: contention_row(),
          lock_stalls: [lock_stall_row()]
        }

  # Internal accumulators carry NATIVE time units (integer sums); the
  # native → millisecond conversion happens once, at snapshot time.
  defstruct queries: %{},
            send_privmsg: %{n: 0, total: 0, outcomes: %{}},
            persist: %{n: 0, total: 0, outcomes: %{}},
            contention: %{n: 0, queue_timeout: 0, busy_locked: 0, dropped: 0},
            lock_stalls: []

  @type t :: %__MODULE__{
          queries: %{{String.t() | nil, op()} => %{n: non_neg_integer(), total: integer(), queue: integer()}},
          send_privmsg: %{n: non_neg_integer(), total: integer(), outcomes: %{atom() => non_neg_integer()}},
          persist: %{n: non_neg_integer(), total: integer(), outcomes: %{atom() => non_neg_integer()}},
          contention: contention_row(),
          lock_stalls: [lock_stall_row()]
        }

  ## ----- Public API ---------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Cumulative aggregate since boot / last `reset/0`, ms-converted."
  @spec snapshot() :: snapshot()
  def snapshot, do: GenServer.call(__MODULE__, :snapshot)

  @doc "Zero every counter — call before opening a fresh sample window."
  @spec reset() :: :ok
  def reset, do: GenServer.call(__MODULE__, :reset)

  ## ----- GenServer callbacks ------------------------------------------

  @impl GenServer
  def init(opts) do
    if Keyword.get(opts, :attach_telemetry, true) do
      # Detach-then-attach so a brutal_kill restart (terminate/2 never
      # runs) doesn't leave a stale handler bound to a dead pid. Detach
      # of an unknown id is `:ok`, so this is safe on first boot too.
      _ = :telemetry.detach(@handler_id)

      :ok =
        :telemetry.attach_many(
          @handler_id,
          @events,
          &__MODULE__.handle_telemetry/4,
          nil
        )
    end

    {:ok, %__MODULE__{}}
  end

  @doc false
  # Runs in the EMITTER's process (per :telemetry semantics). Forward the
  # raw triple onto the GenServer mailbox so the fold happens in the
  # serialized aggregator process — a cheap cast keeps the emitter's hot
  # path (Session.Server loop / query caller) free of aggregation work.
  @spec handle_telemetry([atom()], map(), map(), term()) :: :ok
  def handle_telemetry(event, measurements, metadata, _) do
    GenServer.cast(__MODULE__, {:telemetry, event, measurements, metadata})
  end

  @impl GenServer
  def handle_cast({:telemetry, event, measurements, metadata}, state) do
    {:noreply, fold(event, measurements, metadata, state)}
  end

  @impl GenServer
  def handle_call(:snapshot, _, state), do: {:reply, to_snapshot(state), state}
  def handle_call(:reset, _, _), do: {:reply, :ok, %__MODULE__{}}

  @impl GenServer
  def terminate(_, _) do
    # Detach so a re-init doesn't accumulate stale handlers — telemetry
    # warns on duplicate ids. Safe when not attached (detach of an
    # unknown id returns :ok).
    :ok = :telemetry.detach(@handler_id)
  end

  ## ----- Fold (one clause per attached event) -------------------------

  @spec fold([atom()], map(), map(), t()) :: t()
  defp fold([:grappa, :repo, :query], measurements, metadata, state) do
    key = {Map.get(metadata, :source), classify_op(Map.get(metadata, :query))}
    prev = Map.get(state.queries, key, %{n: 0, total: 0, queue: 0})

    updated = %{
      n: prev.n + 1,
      total: prev.total + native(measurements, :total_time),
      queue: prev.queue + native(measurements, :queue_time)
    }

    %{state | queries: Map.put(state.queries, key, updated)}
  end

  defp fold([:grappa, :scrollback, :persist, :stop], measurements, metadata, state) do
    %{state | persist: add_span(state.persist, measurements, metadata)}
  end

  defp fold([:grappa, :session, :send_privmsg, :stop], measurements, metadata, state) do
    %{state | send_privmsg: add_span(state.send_privmsg, measurements, metadata)}
  end

  defp fold([:grappa, :scrollback, :persist, :contention], _, metadata, state) do
    base = state.contention
    counted = %{base | n: base.n + 1, dropped: base.dropped + if(Map.get(metadata, :dropped), do: 1, else: 0)}

    case Map.get(metadata, :fault) do
      :queue_timeout -> %{state | contention: %{counted | queue_timeout: counted.queue_timeout + 1}}
      :busy_locked -> %{state | contention: %{counted | busy_locked: counted.busy_locked + 1}}
      _ -> %{state | contention: counted}
    end
  end

  defp fold([:grappa, :repo, :lock_stall, :detected], measurements, metadata, state) do
    push_stall(state, %{
      phase: :detected,
      holder_pid: metadata.holder.pid,
      held_ms: measurements.held_ms,
      waiter_count: measurements.waiter_count,
      holder: metadata.holder,
      waiters: metadata.waiters
    })
  end

  defp fold([:grappa, :repo, :lock_stall, :resolved], measurements, metadata, state) do
    push_stall(state, %{
      phase: :resolved,
      holder_pid: metadata.holder_pid,
      held_ms: measurements.held_ms,
      waiter_count: 0,
      holder: nil,
      waiters: []
    })
  end

  @spec push_stall(t(), lock_stall_row()) :: t()
  defp push_stall(state, row) do
    %{state | lock_stalls: Enum.take([row | state.lock_stalls], @lock_stall_ring)}
  end

  # Accumulate one span's duration + outcome tally.
  @spec add_span(map(), map(), map()) :: map()
  defp add_span(acc, measurements, metadata) do
    %{
      n: acc.n + 1,
      total: acc.total + native(measurements, :duration),
      outcomes: Map.update(acc.outcomes, Map.get(metadata, :outcome), 1, &(&1 + 1))
    }
  end

  # A measurement is a native-unit integer; a missing/malformed one folds
  # as 0 so a partial event still increments `n` (honest under-count over
  # a crash-on-nil).
  @spec native(map(), :total_time | :queue_time | :duration) :: integer()
  defp native(measurements, key) do
    case Map.get(measurements, key) do
      n when is_integer(n) -> n
      _ -> 0
    end
  end

  # Classify a query by its leading SQL keyword; a `SELECT count(...)`
  # is split out from a plain SELECT (that count is the FIX-B gate).
  @spec classify_op(String.t() | nil) :: op()
  defp classify_op(nil), do: :other

  defp classify_op(sql) when is_binary(sql) do
    normalized = sql |> String.trim_leading() |> String.downcase()

    cond do
      # Anchor on the leading `select count(` so a plain row-fetch that
      # merely contains a `count(...)` subquery isn't miscounted as :count
      # (the FIX-B gate reads this bucket).
      String.starts_with?(normalized, "select count(") -> :count
      String.starts_with?(normalized, "select") -> :select
      String.starts_with?(normalized, "insert") -> :insert
      String.starts_with?(normalized, "update") -> :update
      String.starts_with?(normalized, "delete") -> :delete
      true -> :other
    end
  end

  ## ----- Snapshot projection ------------------------------------------

  @spec to_snapshot(t()) :: snapshot()
  defp to_snapshot(state) do
    queries =
      state.queries
      |> Enum.map(fn {{source, op}, %{n: n, total: total, queue: queue}} ->
        %{
          source: source,
          op: op,
          n: n,
          total_ms: to_ms(total),
          queue_ms: to_ms(queue),
          mean_ms: mean_ms(total, n)
        }
      end)
      |> Enum.sort_by(& &1.total_ms, :desc)

    %{
      queries: queries,
      send_privmsg: span_snapshot(state.send_privmsg),
      persist: span_snapshot(state.persist),
      contention: state.contention,
      lock_stalls: state.lock_stalls
    }
  end

  @spec span_snapshot(map()) :: span_row()
  defp span_snapshot(%{n: n, total: total, outcomes: outcomes}) do
    %{n: n, total_ms: to_ms(total), mean_ms: mean_ms(total, n), outcomes: outcomes}
  end

  @spec to_ms(integer()) :: float()
  defp to_ms(native), do: System.convert_time_unit(native, :native, :microsecond) / 1000.0

  @spec mean_ms(integer(), non_neg_integer()) :: float()
  defp mean_ms(_, 0), do: 0.0
  defp mean_ms(total, n), do: to_ms(total) / n
end
