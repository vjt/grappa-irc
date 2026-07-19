defmodule Grappa.RateLimit.FailureWindowTest do
  # async: false — asserts against the shared, application-started ETS singleton.
  use ExUnit.Case, async: false

  alias Grappa.RateLimit.FailureWindow

  @window :timer.minutes(15)

  setup do
    :ets.delete_all_objects(FailureWindow.table_name())
    :ok
  end

  test "check/3 is :ok with no recorded failures" do
    assert :ok == FailureWindow.check(:test_bucket, "10.0.0.1", 10)
  end

  test "check blocks at the limit, not before" do
    key = "10.0.0.2"
    for _ <- 1..9, do: FailureWindow.record_failure(:test_bucket, key, @window)
    assert :ok == FailureWindow.check(:test_bucket, key, 10)

    FailureWindow.record_failure(:test_bucket, key, @window)
    assert {:error, :limited} == FailureWindow.check(:test_bucket, key, 10)
  end

  test "record_failure returns the running count — the crossing is detectable" do
    key = "10.0.0.3"
    counts = for _ <- 1..3, do: FailureWindow.record_failure(:test_bucket, key, @window)
    assert counts == [1, 2, 3]
  end

  test "a window expires: blocked key is clean again past window_ms" do
    key = "10.0.0.4"
    for _ <- 1..10, do: FailureWindow.record_failure(:test_bucket, key, @window, 0)

    assert {:error, :limited} == FailureWindow.check(:test_bucket, key, 10, @window - 1)
    assert :ok == FailureWindow.check(:test_bucket, key, 10, @window)

    # A failure past expiry opens a FRESH window at count 1.
    assert 1 == FailureWindow.record_failure(:test_bucket, key, @window, @window + 1)
  end

  test "distinct keys and distinct buckets are independent" do
    for _ <- 1..10, do: FailureWindow.record_failure(:test_bucket, "10.0.0.5", @window)

    assert {:error, :limited} == FailureWindow.check(:test_bucket, "10.0.0.5", 10)
    assert :ok == FailureWindow.check(:test_bucket, "10.0.0.6", 10)
    assert :ok == FailureWindow.check(:other_bucket, "10.0.0.5", 10)
  end

  test "opening a new window sweeps every expired row (table stays bounded)" do
    stale = {:test_bucket, "10.9.9.9"}
    FailureWindow.record_failure(:test_bucket, "10.9.9.9", @window, 0)
    assert [_] = :ets.lookup(FailureWindow.table_name(), stale)

    # A first-failure far past the stale row's expiry triggers the sweep.
    FailureWindow.record_failure(:test_bucket, "10.8.8.8", @window, @window * 2)
    assert [] == :ets.lookup(FailureWindow.table_name(), stale)
  end
end
