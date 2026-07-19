defmodule Grappa.RateLimit.TokenBucketTest do
  # async: false — asserts against the shared, application-started ETS singleton.
  use ExUnit.Case, async: false

  alias Grappa.RateLimit.TokenBucket

  setup do
    :ets.delete_all_objects(TokenBucket.table_name())
    :ok
  end

  test "a fresh bucket starts full: exactly `capacity` takes succeed, the next blocks" do
    key = {{:user, "u1"}, 1}
    for _ <- 1..5, do: assert(:ok == TokenBucket.take(:send, key, 5, 2))
    assert {:error, :rate_limited} == TokenBucket.take(:send, key, 5, 2)
  end

  test "refills over time — a drained bucket admits again after enough elapsed" do
    key = {{:user, "u2"}, 1}
    # Capacity 3, refill 2/s (⇒ 1 token per 500ms). Drain at t=0.
    for _ <- 1..3, do: assert(:ok == TokenBucket.take(:send, key, 3, 2, 0))
    assert {:error, :rate_limited} == TokenBucket.take(:send, key, 3, 2, 0)

    # Not enough elapsed for a whole token yet (<500ms).
    assert {:error, :rate_limited} == TokenBucket.take(:send, key, 3, 2, 499)

    # 500ms ⇒ exactly one token refilled ⇒ one take, then blocked again.
    assert :ok == TokenBucket.take(:send, key, 3, 2, 500)
    assert {:error, :rate_limited} == TokenBucket.take(:send, key, 3, 2, 500)
  end

  test "a blocked take does NOT consume — tokens never go negative" do
    key = {{:user, "u3"}, 1}
    assert :ok == TokenBucket.take(:send, key, 1, 2, 0)
    # Two blocked attempts. If either wrongly decremented, the bucket would
    # need >500ms to recover the token it drove negative.
    assert {:error, :rate_limited} == TokenBucket.take(:send, key, 1, 2, 0)
    assert {:error, :rate_limited} == TokenBucket.take(:send, key, 1, 2, 0)

    # Exactly one token back at t=500 proves the blocked calls left the
    # count untouched.
    assert :ok == TokenBucket.take(:send, key, 1, 2, 500)
    assert {:error, :rate_limited} == TokenBucket.take(:send, key, 1, 2, 500)
  end

  test "refill caps at capacity — a long idle never accrues beyond the burst" do
    key = {{:user, "u4"}, 1}
    for _ <- 1..3, do: assert(:ok == TokenBucket.take(:send, key, 3, 2, 0))
    assert {:error, :rate_limited} == TokenBucket.take(:send, key, 3, 2, 0)

    # Idle for a long time: refill is capped at capacity, so only 3 burst
    # takes are available again — not a huge backlog.
    for _ <- 1..3, do: assert(:ok == TokenBucket.take(:send, key, 3, 2, 100_000))
    assert {:error, :rate_limited} == TokenBucket.take(:send, key, 3, 2, 100_000)
  end

  test "distinct keys have independent buckets" do
    a = {{:user, "a"}, 1}
    b = {{:user, "b"}, 1}
    assert :ok == TokenBucket.take(:send, a, 1, 2)
    assert {:error, :rate_limited} == TokenBucket.take(:send, a, 1, 2)
    # b is untouched by a's exhaustion.
    assert :ok == TokenBucket.take(:send, b, 1, 2)
  end

  test "the same subject on distinct networks has independent buckets" do
    net1 = {{:user, "a"}, 1}
    net2 = {{:user, "a"}, 2}
    assert :ok == TokenBucket.take(:send, net1, 1, 2)
    assert {:error, :rate_limited} == TokenBucket.take(:send, net1, 1, 2)
    assert :ok == TokenBucket.take(:send, net2, 1, 2)
  end

  test "distinct buckets are independent for the same key" do
    key = {{:user, "a"}, 1}
    assert :ok == TokenBucket.take(:send, key, 1, 2)
    assert {:error, :rate_limited} == TokenBucket.take(:send, key, 1, 2)
    assert :ok == TokenBucket.take(:other, key, 1, 2)
  end
end
