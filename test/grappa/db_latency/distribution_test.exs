defmodule Grappa.DbLatency.DistributionTest do
  @moduledoc """
  #1901 axis 3 — the accumulator that keeps an outlier a mean erases.

  No sandbox and no singleton: this is a pure data structure, so it is the
  one part of the `Grappa.DbLatency` surface that can be `async: true`.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.DbLatency.Distribution

  # Native-unit duration for a whole number of milliseconds, via the
  # production conversion (never hardcode the native tick rate).
  defp ms(n), do: System.convert_time_unit(n, :millisecond, :native)

  defp fold(durations_ms) do
    Enum.reduce(durations_ms, Distribution.new(), &Distribution.add(&2, ms(&1)))
  end

  # The exact quantile of a sample, by rank, computed independently of the
  # production histogram. This is the ORACLE the property below compares
  # against — deriving it from `@bounds` would make the test a mirror.
  defp exact_quantile_ms(durations_ms, q) do
    sorted = Enum.sort(durations_ms)

    Enum.at(sorted, min(max(ceil(q * length(sorted)) - 1, 0), length(sorted) - 1))
  end

  describe "an empty distribution" do
    test "reads all zeros rather than raising" do
      # A source nobody queried in this window is a real state, and the CLI
      # renders it beside the used ones. A mutant that divides by `n` for the
      # mean, or takes `hd/1` of an empty bucket list, dies here.
      assert Distribution.reading(Distribution.new()) == %{
               n: 0,
               total_ms: 0.0,
               mean_ms: 0.0,
               max_ms: 0.0,
               p50_ms: 0.0,
               p95_ms: 0.0,
               p99_ms: 0.0
             }
    end
  end

  describe "the exact halves" do
    test "n, total, mean and max are exact, not bucketed" do
      reading = Distribution.reading(fold([1, 3, 8]))

      assert reading.n == 3
      assert_in_delta reading.total_ms, 12.0, 0.5
      assert_in_delta reading.mean_ms, 4.0, 0.5

      # 🔴 `max` is the ONLY exact statement this structure makes about the
      # worst case, so a mutant that reports the top bucket's BOUND (10.0 ms
      # here, the smallest bound covering 8 ms) instead of the measurement
      # dies on this delta. The whole point of #1901 is a number an operator
      # can quote.
      assert_in_delta reading.max_ms, 8.0, 0.5
    end
  end

  describe "the defect this exists for" do
    test "a 31s write inside 1000 healthy ones moves the mean by nothing and the max by everything" do
      # The issue's own arithmetic, at 1/324th the scale so the test is
      # instant: `messages insert` reads 324 679 samples, and a 31 s write
      # inside that population moves the mean by 31_000/324_679 = 0.1 ms,
      # under the rounding the CLI prints. Same shape here.
      healthy = List.duplicate(1, 1_000)

      before = Distribution.reading(fold(healthy))
      after_stall = Distribution.reading(fold(healthy ++ [31_000]))

      # The mean moves — by ~31 ms at this scale, by 0.1 ms at production
      # scale — and in NEITHER case does it say a 31-second write happened.
      # That is the invisibility the issue measures, reproduced.
      assert after_stall.mean_ms > before.mean_ms

      # 🔴 These two lines ARE the deliverable. The max names the event
      # exactly, and the p99 stays where the healthy population is — which is
      # the second half of the reading: one accident, not a moving tail.
      assert_in_delta after_stall.max_ms, 31_000.0, 1.0
      assert after_stall.p99_ms <= 1.0

      # And the tail DOES move when the population moves, so the p99 above is
      # not simply insensitive. A mutant pinning every quantile to the
      # smallest bound passes the line above and dies on this one.
      moved = Distribution.reading(fold(List.duplicate(1, 900) ++ List.duplicate(900, 100)))
      assert moved.p99_ms >= 900.0
    end
  end

  describe "the quantile contract" do
    test "a quantile is the smallest bucket bound covering that share, never an interpolation" do
      # 99 samples at 1 ms and 1 at 400 ms: the true p99 is 1 ms, and the
      # smallest bound covering 99 % is 1 ms. The p50 is the same bound.
      reading = Distribution.reading(fold(List.duplicate(1, 99) ++ [400]))

      assert reading.p50_ms == 1.0
      assert reading.p99_ms == 1.0

      # 🔴 The printed value is a BOUND, so it is a round bucket edge and not
      # a measured decimal. A mutant that interpolates inside the bucket
      # prints something like 1.03 and dies here, which is the point: an
      # operator comparing two windows would otherwise read interpolation
      # noise as movement.
      assert reading.p95_ms == 1.0
    end

    test "a quantile past the largest bound reads the exact max, because that bucket has none" do
      # 30 s is the last finite bound (`busy_timeout`), so 45 s overflows.
      # There is no bound to report there, and the tightest thing the
      # structure holds is the measurement itself.
      reading = Distribution.reading(fold([45_000]))

      assert_in_delta reading.max_ms, 45_000.0, 1.0
      assert reading.p99_ms == reading.max_ms

      # A mutant that clamps the overflow to the largest bound reports 30 s
      # for a 45 s write — the exact under-report this arm exists to end.
      refute reading.p99_ms == 30_000.0
    end

    test "a write that exhausts busy_timeout lands in the last FINITE bucket, not the overflow" do
      # The bound set is chosen so `busy_timeout` (30 s, every env today) is
      # a bucket edge: a writer that gave up exactly there is the expected
      # terminal state, while the overflow means "worse than the driver's own
      # patience", which is a different and more interesting fact.
      reading = Distribution.reading(fold([30_000]))

      assert reading.p99_ms == 30_000.0
      assert_in_delta reading.max_ms, 30_000.0, 1.0
    end
  end

  describe "the upper-bound property" do
    property "a quantile never understates the true one, and never by more than one bucket" do
      # 🔴 The first assertion IS the contract, and it only runs in one
      # direction on purpose: a bucketed quantile may OVERSTATE (it reports
      # the bucket's ceiling) but must never understate, or an operator
      # reading `p99_ms` would believe 99 % of writes were faster than they
      # were. The oracle sorts and ranks; it shares no code with the
      # histogram.
      #
      # 🔴 "<= the observed max" was the FIRST cut of the second assertion
      # and it is FALSE — measured, first run: one 2 ms sample reports
      # `p50_ms == 2.5`, the ceiling of the bucket 2 ms falls in, which
      # exceeds the max by design. What is true, and worth pinning because it
      # is the resolution the operator is buying, is that a reported quantile
      # is within ONE bucket of the truth: at most 3x it, the coarsest step
      # in the bound set (10 s -> 30 s). In the overflow bucket there is no
      # ceiling and the reading is the exact max, which is the other arm.
      check all(
              durations <- list_of(integer(1..60_000), min_length: 1, max_length: 200),
              q <- member_of([{0.50, :p50_ms}, {0.95, :p95_ms}, {0.99, :p99_ms}])
            ) do
        {quantile, key} = q
        reading = Distribution.reading(fold(durations))
        reported = Map.fetch!(reading, key)
        truth = exact_quantile_ms(durations, quantile)

        assert reported >= truth * 0.999,
               "#{key} understated the true quantile: got #{reported}, true #{truth}"

        assert reported <= max(truth * 3.0, reading.max_ms),
               "#{key} is more than one bucket above the truth: got #{reported}, true #{truth}"
      end
    end

    property "the three quantiles are monotone in q" do
      # Structural, and independent of the bound set: the walk is over a
      # cumulative count, so a larger rank can only stop at the same bound or
      # a later one. A mutant that reads the buckets unsorted, or that walks
      # from the wrong end, breaks this without breaking the bound above.
      check all(durations <- list_of(integer(1..60_000), min_length: 1, max_length: 200)) do
        reading = Distribution.reading(fold(durations))

        assert reading.p50_ms <= reading.p95_ms
        assert reading.p95_ms <= reading.p99_ms
      end
    end

    property "n and total are exact for any sample" do
      # The bucketing must not leak into the two numbers that were always
      # exact. A mutant that folds `total` from bucket midpoints (a plausible
      # "simplification") dies across the whole input space.
      check all(durations <- list_of(integer(1..5_000), min_length: 1, max_length: 100)) do
        reading = Distribution.reading(fold(durations))

        assert reading.n == length(durations)
        assert_in_delta reading.total_ms, Enum.sum(durations) * 1.0, length(durations) * 0.5
      end
    end
  end
end
