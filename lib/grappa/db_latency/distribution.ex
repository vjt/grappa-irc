defmodule Grappa.DbLatency.Distribution do
  @moduledoc """
  A bounded latency distribution: exact `n`, `total` and `max`, plus a
  fixed-bucket histogram for quantiles (#1901 axis 3).

  ## Why a mean was not enough, measured

  Every family in `Grappa.DbLatency` used to fold to `n / total_ms / mean_ms`,
  and on the live node `messages insert` reads **324 679** samples at a mean
  of 30.12 ms. A single 31-second write inside that population moves the mean
  by `31_000 / 324_679`, i.e. **0.1 ms** — under the rounding the CLI prints.
  So the four write-lock stalls of issue 1888, the exact events the whole
  telemetry surface exists to catch, left no arithmetic trace anywhere: the
  operator could read the table during the freeze and see nothing.

  `max_ms` alone would fix that one number and nothing else, so this keeps the
  SHAPE: `max` says the worst thing that happened, the quantiles say whether it
  was one accident or the tail moving.

  ## What the quantiles are, exactly, and what they are not

  🔴 **Every quantile here is an UPPER BOUND on the true one, never an
  interpolation.** `p95_ms` is the smallest bucket bound that covers at least
  95 % of the samples — so the true p95 is somewhere in that bucket, at or
  below the number printed. This is deliberate and it is the honest option:
  interpolating inside a bucket would print a decimal nobody measured, and a
  reader comparing two windows would be reading interpolation noise as
  movement. When the quantile falls in the overflow bucket (past the largest
  bound) the reading is the exact `max_ms`, which is the tightest bound this
  structure holds.

  Read `p99_ms == 30_000.0` as *"at most 1 % of samples were slower than 30 s"*
  and `max_ms` as the only exact statement about the worst case.

  ## Bounds, and why these

  Fixed, in MICROSECONDS, roughly 1-2-5 per decade from 0.5 ms to 30 s. The
  bottom is where this system's healthy writes live (the issue's own table has
  five sources under 2 ms) and the top is `busy_timeout`, so a write that
  exhausted it lands in the last finite bucket rather than the overflow — the
  overflow then means *"worse than the driver's own patience"*, which is a
  distinct and interesting fact rather than a saturation artefact.

  Memory is bounded and small: at most 16 counters per family regardless of
  sample count, against the unbounded list a reservoir or a keep-the-last-N
  would need. Nothing here allocates per sample.

  ## Units

  `total` and `max` are kept in NATIVE units and converted once, at
  `reading/1` — the discipline `Grappa.DbLatency` already had. Only the
  histogram converts per sample, because a bucket bound has to be a fixed
  wall-clock duration and `:native` is not one. `to_ms/1` is public because it
  is this context's single native-to-millisecond conversion: `DbLatency`'s
  `queue_ms` rides it too rather than carrying a second copy.
  """

  # Upper bounds in microseconds. `:overflow` is the implicit last bucket and
  # is not listed: it has no bound, which is the whole reason `reading/1`
  # falls back to the exact `max` there instead of printing one.
  @bounds [
    500,
    1_000,
    2_500,
    5_000,
    10_000,
    25_000,
    50_000,
    100_000,
    250_000,
    500_000,
    1_000_000,
    2_500_000,
    5_000_000,
    10_000_000,
    30_000_000
  ]

  defstruct n: 0, total: 0, max: 0, buckets: %{}

  @typedoc """
  `total` and `max` are NATIVE units; `buckets` is keyed by the microsecond
  upper bound the sample fell in, or `:overflow` past the largest one.
  """
  @type t :: %__MODULE__{
          n: non_neg_integer(),
          total: integer(),
          max: integer(),
          buckets: %{(pos_integer() | :overflow) => pos_integer()}
        }

  @typedoc """
  The millisecond projection. `n`, `total_ms`, `mean_ms` and `max_ms` are
  exact; the three quantiles are UPPER BOUNDS — see the moduledoc.
  """
  @type reading :: %{
          n: non_neg_integer(),
          total_ms: float(),
          mean_ms: float(),
          max_ms: float(),
          p50_ms: float(),
          p95_ms: float(),
          p99_ms: float()
        }

  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc """
  Fold one measurement, in NATIVE units.

  A negative duration is impossible from a monotonic span and is not guarded
  against: it would land in the first bucket and understate `max`, which is
  the same failure a guard would produce more slowly.
  """
  @spec add(t(), integer()) :: t()
  def add(%__MODULE__{} = dist, native) when is_integer(native) do
    bound = bucket(System.convert_time_unit(native, :native, :microsecond))

    %{
      dist
      | n: dist.n + 1,
        total: dist.total + native,
        max: max(dist.max, native),
        buckets: Map.update(dist.buckets, bound, 1, &(&1 + 1))
    }
  end

  @doc """
  Project to milliseconds. An empty distribution reads all zeros rather than
  raising — an unused bucket is a real state (the source was never queried in
  this window) and the CLI renders it beside the used ones.
  """
  @spec reading(t()) :: reading()
  def reading(%__MODULE__{} = dist) do
    %{
      n: dist.n,
      total_ms: to_ms(dist.total),
      mean_ms: mean_ms(dist.total, dist.n),
      max_ms: to_ms(dist.max),
      p50_ms: quantile_ms(dist, 0.50),
      p95_ms: quantile_ms(dist, 0.95),
      p99_ms: quantile_ms(dist, 0.99)
    }
  end

  @doc "This context's single native-to-millisecond conversion."
  @spec to_ms(integer()) :: float()
  def to_ms(native), do: System.convert_time_unit(native, :native, :microsecond) / 1000.0

  # The smallest bound that covers this sample. `Enum.find/3` over 15 sorted
  # integers is a linear scan and that is deliberate: a binary search over a
  # compile-time list of this size buys nothing measurable and costs the
  # reader the one property that matters here — that the bucket a sample
  # lands in is obviously the smallest bound at or above it.
  @spec bucket(integer()) :: pos_integer() | :overflow
  defp bucket(microseconds), do: Enum.find(@bounds, :overflow, &(microseconds <= &1))

  # 🔴 An UPPER bound, by construction: walk the bounds in order until the
  # cumulative count reaches the rank, and report THAT bound. The true
  # quantile is somewhere inside that bucket. Exhausting the list means the
  # rank sits in the overflow bucket, where the tightest bound available is
  # the exact `max` — never a bound, because the overflow bucket has none.
  @spec quantile_ms(t(), float()) :: float()
  defp quantile_ms(%__MODULE__{n: 0}, _), do: 0.0

  defp quantile_ms(dist, q), do: walk(@bounds, dist, ceil(q * dist.n), 0)

  @spec walk([pos_integer()], t(), pos_integer(), non_neg_integer()) :: float()
  defp walk([], dist, _rank, _seen), do: to_ms(dist.max)

  defp walk([bound | rest], dist, rank, seen) do
    seen = seen + Map.get(dist.buckets, bound, 0)

    if seen >= rank, do: bound / 1000.0, else: walk(rest, dist, rank, seen)
  end

  @spec mean_ms(integer(), non_neg_integer()) :: float()
  defp mean_ms(_, 0), do: 0.0
  defp mean_ms(total, n), do: to_ms(total) / n
end
