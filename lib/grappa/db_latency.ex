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
          row — `queue_timeout` / `busy_locked` / `interrupted` counts (#1657
          added the third: a checkout the pool served and then revoked), and `dropped`
          (budget-exhausted rows lost).
        - **mechanism 3 (pure insert / index write-amplification):** the
          `persist` row `mean_ms` on its own, watched as the table grows.

    * **`[:grappa, :repo, :lock_stall, :detected | :resolved |
      :unattributed]`** (#1420, #1687) —
      the write-lock HOLDER, which neither family above can see. Both of
      them are completion-driven, so a process sitting idle inside
      `BEGIN IMMEDIATE` emits nothing while it sits and only its victims
      show up (as 30.1s `busy_timeout` rows). `Grappa.Repo.LockWatch`
      reads at the seam instead and hands over the holder's sampled stack
      plus the queue behind it; here they are kept as a bounded ring, so
      the existing CLI and admin doors surface them with no new noun.
      `:unattributed` is the same ring for the episodes that seam CANNOT
      name — an autocommit writer holds the same file lock and never
      registers — and it carries the queue's stacks with explicit nils
      where the holder would be. `:nif_census` (#1901) is the fourth phase
      and the only one taken WITHOUT reading the seam at all: the roster of
      processes sitting inside `Exqlite.Sqlite3NIF`, which is how the
      autocommit writers that dominate this system's write volume become
      visible to any door. Filing any of them elsewhere would mean an
      operator asking what the write lock did has to already know that a
      differently-shaped answer exists somewhere else.

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

  alias Grappa.DbLatency.Distribution

  @handler_id "grappa-db-latency"
  @events [
    [:grappa, :repo, :query],
    [:grappa, :scrollback, :persist, :stop],
    [:grappa, :session, :send_privmsg, :stop],
    [:grappa, :scrollback, :persist, :contention],
    [:grappa, :repo, :lock_stall, :detected],
    [:grappa, :repo, :lock_stall, :resolved],
    [:grappa, :repo, :lock_stall, :unattributed],
    [:grappa, :repo, :lock_stall, :nif_census]
  ]

  # #1420 — the lock-stall ring is bounded: these rows carry sampled
  # stacktraces, so an unbounded list would grow the singleton's heap for as
  # long as the node stays up. Twenty episodes is far more than any single
  # incident produces and still fits in one admin response.
  @lock_stall_ring 20

  @type op :: :select | :insert | :update | :delete | :count | :other

  @typedoc """
  One `{source, op}` bucket. Everything but `queue_ms` comes from a
  `t:Grappa.DbLatency.Distribution.reading/0`, so `max_ms` is exact and the
  three quantiles are UPPER bounds — see that module for why an interpolated
  quantile was refused.

  🔴 `queue_ms` stays a plain cumulative sum, and that is a KNOWN GAP rather
  than a judgement that the pool axis does not matter. #1687 measured a
  victim's 62 s as ~31 s of DBConnection checkout PLUS ~31 s of
  `busy_timeout`, so a queue-time outlier is exactly as invisible in a mean
  as an execution-time one. #1901 asks for the execution axis; giving the
  queue its own histogram is the same change again and has not been made.
  """
  @type query_row :: %{
          source: String.t() | nil,
          op: op(),
          n: non_neg_integer(),
          total_ms: float(),
          queue_ms: float(),
          mean_ms: float(),
          max_ms: float(),
          p50_ms: float(),
          p95_ms: float(),
          p99_ms: float()
        }

  @type span_row :: %{
          n: non_neg_integer(),
          total_ms: float(),
          mean_ms: float(),
          max_ms: float(),
          p50_ms: float(),
          p95_ms: float(),
          p99_ms: float(),
          outcomes: %{atom() => non_neg_integer()}
        }

  @type contention_row :: %{
          n: non_neg_integer(),
          queue_timeout: non_neg_integer(),
          busy_locked: non_neg_integer(),
          # #1657 — the pool cancelling a checkout it had already served.
          # Counted apart from `queue_timeout` (never granted) and
          # `busy_locked` (granted, then blocked on the file lock) because
          # the three name three different places the write died.
          interrupted: non_neg_integer(),
          dropped: non_neg_integer()
        }

  @typedoc """
  One write-lock stall episode (#1420). `:detected` carries the holder's
  sampled stack and the queue behind it; `:resolved` brackets the same
  episode with the TOTAL hold and no samples (by then there is nothing left
  to sample). Newest first.

  `:unattributed` (#1687) is the third phase and the reason two fields are
  nilable: a queue past the threshold that LockWatch could name nobody for.
  Its `holder_pid` and `held_ms` are `nil` — the explicit-null honesty
  signal, not a gap to paper over. A `held_ms: 0` would assert a hold of
  zero was measured, and nothing in that episode measured a hold at all; its
  own figure is the longest WAIT, which rides the telemetry measurements and
  is derivable from `waiters` rather than duplicated here. It gets no
  `:resolved` bracket, because there is no hold to total.

  #1888 adds three fields, on the same rule — a phase that did not observe a
  thing carries an explicit `nil` for it rather than a plausible value:

    * `observed_at` — the instant the EMITTER observed the episode, on every
      phase. Without it a ring row cannot be lined up against `erlang.log`,
      which is the only artefact that dates a freeze, and the ring is exactly
      the door that survives a log that went quiet.
    * `caller` — WHO held the lock, on `:resolved` only. It is not a holder
      `sample()` and the two must not be read as one: a sample names the
      frame the holder PAUSED in, this names the write path that opened the
      transaction. `holder` therefore stays `nil` on a `:resolved` row, as it
      always has.
    * `announced` — whether the watchdog got to report the episode WHILE it
      held. `false` means this row is the only record of it, which is the
      #1888 case; `nil` on the two phases where the question does not arise.

  `waiter_count` is nilable for the same reason: a closing bracket counts no
  queue, and the `0` it used to carry asserted an empty one was measured.

  #1901 adds the fourth phase, `:nif_census`, and with it `parked` plus two
  counts. It is the arm that does not read the seam at all — it reports every
  process sitting inside `Exqlite.Sqlite3NIF` past the threshold — so on that
  row EVERY seam-derived field is nil, including `holder_pid`, and that is a
  stronger statement than `:unattributed`'s: a holder is certainly IN
  `parked`, and nothing BEAM-visible says which entry it is.
  `registered_holders` / `registered_waiters` count how many of the parked
  processes the seam could already name, so an operator can tell "widen
  coverage" from "the other two arms already told you". `parked` follows
  `waiters` in being a plain list defaulting to `[]` rather than a nilable:
  an empty roster and no roster are the same fact here, since a census with
  nobody in it emits nothing at all.
  """
  @type lock_stall_row :: %{
          phase: :detected | :resolved | :unattributed | :nif_census,
          observed_at: String.t(),
          holder_pid: String.t() | nil,
          held_ms: non_neg_integer() | nil,
          waiter_count: non_neg_integer() | nil,
          holder: map() | nil,
          caller: map() | nil,
          announced: boolean() | nil,
          waiters: [map()],
          parked: [map()],
          registered_holders: non_neg_integer() | nil,
          registered_waiters: non_neg_integer() | nil
        }

  @type snapshot :: %{
          queries: [query_row()],
          send_privmsg: span_row(),
          persist: span_row(),
          contention: contention_row(),
          lock_stalls: [lock_stall_row()]
        }

  # Internal accumulators carry NATIVE time units; the native → millisecond
  # conversion happens once, at snapshot time. Since #1901 the duration half
  # of every family is a `Distribution` rather than an `{n, total}` pair —
  # same exactness for those two, plus the max and the tail a mean erases.
  defstruct queries: %{},
            send_privmsg: %{dist: %Distribution{}, outcomes: %{}},
            persist: %{dist: %Distribution{}, outcomes: %{}},
            contention: %{n: 0, queue_timeout: 0, busy_locked: 0, interrupted: 0, dropped: 0},
            lock_stalls: []

  @type t :: %__MODULE__{
          queries: %{{String.t() | nil, op()} => %{dist: Distribution.t(), queue: integer()}},
          send_privmsg: %{dist: Distribution.t(), outcomes: %{atom() => non_neg_integer()}},
          persist: %{dist: Distribution.t(), outcomes: %{atom() => non_neg_integer()}},
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

  @doc """
  The telemetry events this handler binds at `init/1`.

  Exposed because `fold/4` has NO catch-all clause: an event added to
  `@events` without a matching clause crashes the singleton, and a clause
  added without the event folds nothing — and the second failure is silent,
  which is how it presented while #1901 was being built (a new emitter, a
  green suite, and an empty ring). `Grappa.DbLatencyTest` keeps its own
  independent copy of the set as the oracle and asserts it equals this one, so
  the drift is a named failure rather than a missing row.
  """
  @spec attached_events() :: [[atom()]]
  def attached_events, do: @events

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
    prev = Map.get(state.queries, key, %{dist: %Distribution{}, queue: 0})

    updated = %{
      dist: Distribution.add(prev.dist, native(measurements, :total_time)),
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
      :interrupted -> %{state | contention: %{counted | interrupted: counted.interrupted + 1}}
      _ -> %{state | contention: counted}
    end
  end

  defp fold([:grappa, :repo, :lock_stall, :detected], measurements, metadata, state) do
    push_stall(state, %{
      phase: :detected,
      observed_at: metadata.observed_at,
      holder_pid: metadata.holder.pid,
      held_ms: measurements.held_ms,
      waiter_count: measurements.waiter_count,
      holder: metadata.holder,
      caller: nil,
      announced: nil,
      waiters: metadata.waiters,
      parked: [],
      registered_holders: nil,
      registered_waiters: nil
    })
  end

  # #1687 — the episode that named nobody. It reaches the SAME ring and the
  # same two doors as the other two: an operator asking "what did the write
  # lock do" must not have to know that a third, differently-shaped answer
  # exists somewhere else. What it does NOT do is synthesise a holder to fit
  # the row shape — the nils are the finding.
  defp fold([:grappa, :repo, :lock_stall, :unattributed], measurements, metadata, state) do
    push_stall(state, %{
      phase: :unattributed,
      observed_at: metadata.observed_at,
      holder_pid: nil,
      held_ms: nil,
      waiter_count: measurements.waiter_count,
      holder: nil,
      caller: nil,
      announced: nil,
      waiters: metadata.waiters,
      parked: [],
      registered_holders: nil,
      registered_waiters: nil
    })
  end

  # #1888 — the closing bracket, which since that issue also fires for an
  # episode the watchdog never announced. `caller` is the identity such a row
  # carries INSTEAD of a holder sample (there is no pause site left to sample
  # by then), and `announced: false` is the finding: this row is the only
  # record that episode left anywhere.
  defp fold([:grappa, :repo, :lock_stall, :resolved], measurements, metadata, state) do
    push_stall(state, %{
      phase: :resolved,
      observed_at: metadata.observed_at,
      holder_pid: metadata.holder_pid,
      held_ms: measurements.held_ms,
      # nil, not 0: nothing in a closing bracket counted a queue, and a zero
      # would assert an empty one was measured.
      waiter_count: nil,
      holder: nil,
      caller: metadata.caller,
      announced: metadata.announced,
      waiters: [],
      parked: [],
      registered_holders: nil,
      registered_waiters: nil
    })
  end

  # #1901 — the arm that reads `Process.list/0` rather than the seam, so it is
  # the one phase where `holder_pid` being nil is not a gap the instrument
  # might have closed: a holder IS among `parked`, and exqlite's busy handler
  # sleeping inside the same dirty-IO NIF as the writer that holds the lock
  # makes the cohort indivisible from the BEAM's side. Synthesising a
  # `holder_pid` to fill the column would turn the one honest thing this row
  # says into a guess. `registered_holders` / `registered_waiters` are what
  # separate "the seam is blind here" from "the other two arms already spoke".
  defp fold([:grappa, :repo, :lock_stall, :nif_census], _measurements, metadata, state) do
    push_stall(state, %{
      phase: :nif_census,
      observed_at: metadata.observed_at,
      holder_pid: nil,
      held_ms: nil,
      # nil, not `parked_count`: nothing here observed a QUEUE. The count of
      # parked processes is a different measurement and rides its own field,
      # exactly as #1687 refused to reuse `held_ms` for a longest WAIT.
      waiter_count: nil,
      holder: nil,
      caller: nil,
      announced: nil,
      waiters: [],
      parked: metadata.parked,
      registered_holders: metadata.registered_holders,
      registered_waiters: metadata.registered_waiters
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
      dist: Distribution.add(acc.dist, native(measurements, :duration)),
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
      |> Enum.map(fn {{source, op}, %{dist: dist, queue: queue}} ->
        dist
        |> Distribution.reading()
        |> Map.merge(%{source: source, op: op, queue_ms: Distribution.to_ms(queue)})
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
  defp span_snapshot(%{dist: dist, outcomes: outcomes}) do
    dist |> Distribution.reading() |> Map.put(:outcomes, outcomes)
  end
end
