defmodule Grappa.Session.DirectoryIngest do
  @moduledoc """
  #1390 slice 2 — the channel-directory (#84) `LIST` ingest, as a struct
  that owns its own decisions.

  ## What this is

  `Session.Server` used to carry the whole ETL: four state fields
  (`directory_refresh_timeout_ms`, `directory_progress_throttle_ms`,
  `directory_ingest_batch`, `directory_refresh`), three compile-env
  constants, a watchdog, and seven private functions parsing RPL_LIST rows,
  batching them, throttling progress pings and flushing the tail. The
  channel directory is a domain of its own — `Grappa.ChannelDirectory` — so
  none of that belonged on the hottest process in the tree.

  The four fields collapse to one `directory` key holding this struct.
  `run == nil` IS the "no refresh in flight" guard, exactly as
  `directory_refresh == nil` was.

  ## The buffer is the whole capture (issue 2046)

  It used to be a flush window: 200 rows in, 200 rows written, buffer
  emptied, repeat. Persistence is now DEFERRED — nothing reaches the table
  until 323 RPL_LISTEND — so the buffer accumulates the entire `LIST` and
  `finish/1` is the only door out of it. The batch size went with the
  mechanism: with no mid-stream write left to size, `absorb/3` appends and
  throttles, and that is all it does. What the capture costs is now plainly
  RAM, which is the price the ruling accepted.

  ## Why this one carries logic, unlike its `*Accum` siblings

  `WhoisAccum`, `LinksAccum` and friends are pure data drained by
  `EventRouter`. This module also owns the throttle window and the row
  parse, because that is the whole point of the extraction: before it,
  those decisions were reachable only by booting a `Session.Server`, a fake
  ircd and the Repo (`directory_test.exs` is `async: false` on `DataCase`
  for exactly that reason). `directory_ingest_test.exs` drives them on
  plain `ExUnit.Case`, `async: true`, with no process and no database — and
  it can only stay that way while the decisions stay pure.

  ## Struct, not a declared map type

  The tracker used to be an anonymous map with declared keys and a
  `buffer: [map()]`. #1391 measured the difference with a mutant pair: a
  struct-field typo is a *compile* error, a bare-map key typo compiles
  clean, and declaring the map's shape changes neither. So the fix that
  buys anything here is the struct.

  ## IO stays at the call site, on purpose

  `absorb/3` and `finish/1` hand back what to do, never do it. Two pieces
  of observable behaviour depend on that split and are preserved
  deliberately rather than tidied:

    * the `directory_complete` total is re-read from the DB snapshot by
      `Session.Server`, NOT taken from `run.count` — the two can differ
      the moment `ChannelDirectory.replace/3` collapses duplicate names;
    * `abort/1` (the watchdog) DROPS the buffered rows and hands back
      nothing to write, so a truncated refresh never calls
      `ChannelDirectory.replace/3`. Under deferred persistence that is no
      longer merely "the DB is left alone": it is what keeps the PREVIOUS
      snapshot intact, since nothing was nuked when the run began.
  """

  alias Grappa.ChannelDirectory

  @cfg Application.compile_env(:grappa, Grappa.ChannelDirectory, [])
  @default_timeout_ms Keyword.get(@cfg, :refresh_timeout_ms, 60_000)
  @default_throttle_ms Keyword.get(@cfg, :progress_throttle_ms, 1_000)

  defmodule Run do
    @moduledoc """
    The in-flight half of a `LIST` refresh: present from the moment the
    `LIST` hits the wire until 323 RPL_LISTEND or the watchdog.

    `buffer` holds parsed rows newest-first for an O(1) prepend and is
    reversed at `finish/1` so the ingest preserves wire order. `count`
    tracks the same rows the buffer holds and is kept separately only so a
    progress ping costs no `length/1`. `last_emit_ms` is a
    `System.monotonic_time(:millisecond)` stamp seeded when the refresh is
    armed, and `timer` is the watchdog ref the caller must cancel on a
    clean finish.
    """

    @type t :: %__MODULE__{
            buffer: [Grappa.ChannelDirectory.ingest_row()],
            count: non_neg_integer(),
            last_emit_ms: integer(),
            timer: reference() | nil
          }

    defstruct buffer: [], count: 0, last_emit_ms: 0, timer: nil
  end

  @typedoc """
  What `Session.Server` must perform, in the order handed back.

  One member since issue 2046 deferred the writes: `{:progress, n}`, a
  throttled `directory_progress` ping carrying the running total. It stays
  a list of a tagged tuple rather than collapsing to `n | nil`, because the
  shape is what keeps the decision here and the IO at the call site — and
  because a second action is exactly what a future ping would be.
  """
  @type action :: {:progress, non_neg_integer()}

  @type t :: %__MODULE__{
          timeout_ms: pos_integer(),
          throttle_ms: non_neg_integer(),
          run: Run.t() | nil
        }

  # The defaults ARE the production config, which is what makes
  # `Map.get(state, :directory, %DirectoryIngest{})` an exact equivalent for a
  # process hot-reloaded across the field's introduction — the same contract
  # the #1390 slice-1 `Deps` bundle relies on.
  defstruct timeout_ms: @default_timeout_ms,
            throttle_ms: @default_throttle_ms,
            run: nil

  @doc """
  Build the idle ingest from `t:Grappa.Session.start_opts/0`, taking the
  struct's config defaults for anything the caller does not pin.

  Same opt-key spelling as before the #1390 extraction for the two knobs
  that remain. The third, `:directory_ingest_batch`, is GONE with the
  mid-stream flush it sized (issue 2046) — and because this reader is
  `Map.get`, a caller still passing it is silently IGNORED rather than
  rejected. Stated because that is the cost of the non-strict shape below:
  a stale plan does not crash, it just stops meaning anything.

  Shaped after its slice-1 sibling `Deps.from_opts/2`, but deliberately NOT
  strict like it: these are numeric tuning knobs with real production
  defaults, not injected capabilities whose absence is a silent no-op
  (#1398).
  """
  @spec from_opts(map()) :: t()
  def from_opts(opts) when is_map(opts) do
    defaults = %__MODULE__{}

    %__MODULE__{
      timeout_ms: Map.get(opts, :directory_refresh_timeout_ms, defaults.timeout_ms),
      throttle_ms: Map.get(opts, :directory_progress_throttle_ms, defaults.throttle_ms)
    }
  end

  @doc "True while a `LIST` refresh is streaming. The in-flight guard."
  @spec in_flight?(t()) :: boolean()
  def in_flight?(%__MODULE__{run: nil}), do: false
  def in_flight?(%__MODULE__{}), do: true

  @doc """
  Arm a refresh. `now_ms` seeds the throttle window, so the first row is
  inside it and emits no ping — the pre-extraction behaviour.
  """
  @spec start(t(), integer(), reference() | nil) :: t()
  def start(%__MODULE__{} = ingest, now_ms, timer) do
    %{ingest | run: %Run{last_emit_ms: now_ms, timer: timer}}
  end

  @doc """
  Parse one 322 RPL_LIST row.

  Params carry the client-nick echo first:
  `:server 322 <nick> <#channel> <#users> :<topic>`. The three-element
  clause covers a stripped upstream that omits the trailing topic. A
  non-binary count coerces to 0 — never crash an ingest on a malformed
  numeric — and an unrecognised shape is dropped.
  """
  @spec parse_row([String.t()]) :: {:ok, ChannelDirectory.ingest_row()} | :error
  def parse_row([_, channel, count_str, topic]) when is_binary(channel) do
    {:ok, %{name: channel, topic: topic, user_count: user_count(count_str)}}
  end

  def parse_row([_, channel, count_str]) when is_binary(channel) do
    {:ok, %{name: channel, topic: nil, user_count: user_count(count_str)}}
  end

  def parse_row(_), do: :error

  @doc """
  Absorb one parsed row, returning the ingest and what to perform.

  The row is buffered, never written: the whole capture goes to the table
  in one `ChannelDirectory.replace/3` at `finish/1`. The count a ping
  reports is therefore what has been RECEIVED, not what has been stored —
  which is the honest reading of a `directory_progress` ping and the same
  number it always carried.
  """
  @spec absorb(t(), ChannelDirectory.ingest_row(), integer()) :: {t(), [action()]}
  def absorb(%__MODULE__{run: %Run{} = run} = ingest, row, now_ms) do
    appended = %{run | buffer: [row | run.buffer], count: run.count + 1}
    {emitted, actions} = throttle(appended, ingest.throttle_ms, now_ms)

    {%{ingest | run: emitted}, actions}
  end

  @doc """
  Finish a refresh: hand back the WHOLE capture in wire order (empty when
  nothing was buffered) and the watchdog ref to cancel, and clear the run.

  Safe on an already-cleared ingest — `abort/1` leaves it in exactly that
  shape — where it yields no rows and no timer.
  """
  @spec finish(t()) :: {t(), [ChannelDirectory.ingest_row()], reference() | nil}
  def finish(%__MODULE__{run: nil} = ingest), do: {ingest, [], nil}

  def finish(%__MODULE__{run: %Run{} = run} = ingest) do
    # Buffer is newest-first; hand back wire order.
    {%{ingest | run: nil}, Enum.reverse(run.buffer), run.timer}
  end

  @doc """
  Abandon a refresh without flushing — the `:directory_refresh_timeout`
  watchdog. Buffered rows since the last batch are DROPPED and no
  finalisation is offered; see the moduledoc for why that is preserved.
  """
  @spec abort(t()) :: t()
  def abort(%__MODULE__{} = ingest), do: %{ingest | run: nil}

  @spec throttle(Run.t(), non_neg_integer(), integer()) :: {Run.t(), [action()]}
  defp throttle(%Run{} = run, throttle_ms, now_ms) do
    if now_ms - run.last_emit_ms >= throttle_ms do
      {%{run | last_emit_ms: now_ms}, [{:progress, run.count}]}
    else
      {run, []}
    end
  end

  @spec user_count(term()) :: non_neg_integer()
  defp user_count(count_str) when is_binary(count_str) do
    case Integer.parse(count_str) do
      {n, _} -> n
      :error -> 0
    end
  end

  defp user_count(_), do: 0
end
