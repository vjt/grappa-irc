defmodule Grappa.Session.AutoReplyBudgetTest do
  @moduledoc """
  Unit tests for `Grappa.Session.AutoReplyBudget`.

  Every case supplies its own monotonic stamp, so refill is exercised by
  arithmetic rather than by sleeping — the reason `take/2` takes `now_ms`
  at all.

  The ceiling is read from the module (`capacity/0`, `refill_per_sec/0`)
  rather than re-typed here: a test that hardcodes 5 keeps passing after an
  operator lowers the configured burst to 1, which is the one change these
  tests exist to notice.
  """
  use ExUnit.Case, async: true

  alias Grappa.Session.AutoReplyBudget

  @t0 1_000_000

  defp drain(budget, 0, _), do: budget

  defp drain(budget, n, now) when n > 0 do
    {:ok, next} = AutoReplyBudget.take(budget, now)
    drain(next, n - 1, now)
  end

  describe "take/2" do
    test "a fresh budget answers the first query immediately" do
      assert {:ok, _} = AutoReplyBudget.take(AutoReplyBudget.new(@t0), @t0)
    end

    test "the burst is exactly `capacity` takes, and the next one is refused" do
      capacity = AutoReplyBudget.capacity()

      drained = drain(AutoReplyBudget.new(@t0), capacity, @t0)

      assert {:error, :rate_limited, _} = AutoReplyBudget.take(drained, @t0)
    end

    test "a refused take consumes nothing — it stays refused at the same instant" do
      drained = drain(AutoReplyBudget.new(@t0), AutoReplyBudget.capacity(), @t0)

      {:error, :rate_limited, after_first} = AutoReplyBudget.take(drained, @t0)

      assert {:error, :rate_limited, _} = AutoReplyBudget.take(after_first, @t0)
    end

    test "one token's worth of elapsed time buys exactly one more answer" do
      drained = drain(AutoReplyBudget.new(@t0), AutoReplyBudget.capacity(), @t0)
      one_token_ms = ceil(1000 / AutoReplyBudget.refill_per_sec())

      {:ok, spent} = AutoReplyBudget.take(drained, @t0 + one_token_ms)

      # The second take at the SAME instant is what proves the refill
      # credited one token and not the whole bucket.
      assert {:error, :rate_limited, _} = AutoReplyBudget.take(spent, @t0 + one_token_ms)
    end

    test "refill is capped at capacity — an idle century does not buy a bigger burst" do
      century_ms = 100 * 365 * 24 * 60 * 60 * 1000

      drained = drain(AutoReplyBudget.new(@t0), AutoReplyBudget.capacity(), @t0)
      recovered = drain(drained, AutoReplyBudget.capacity(), @t0 + century_ms)

      assert {:error, :rate_limited, _} = AutoReplyBudget.take(recovered, @t0 + century_ms)
    end

    test "a refused take still advances the clock, so the interval is not credited twice" do
      one_token_ms = ceil(1000 / AutoReplyBudget.refill_per_sec())
      drained = drain(AutoReplyBudget.new(@t0), AutoReplyBudget.capacity(), @t0)

      # Refused mid-interval: the partial refill is banked and stamped.
      {:error, :rate_limited, mid} = AutoReplyBudget.take(drained, @t0 + div(one_token_ms, 2))

      # Had the denial NOT re-stamped, the full interval would be credited
      # again here and this second half-interval would buy a whole token.
      assert {:ok, _} = AutoReplyBudget.take(mid, @t0 + one_token_ms)
    end
  end
end
