defmodule Grappa.RateLimit.DailyQuotaTest do
  # async: false — asserts against the shared, application-started ETS singleton.
  use ExUnit.Case, async: false

  alias Grappa.RateLimit.DailyQuota

  setup do
    :ets.delete_all_objects(DailyQuota.table_name())
    :ok
  end

  test "allows exactly up to the limit then blocks" do
    subject = {:user, "u1"}
    for _ <- 1..5, do: assert(:ok == DailyQuota.check_and_record(:theme_create, subject, 5))
    assert {:error, :rate_limited} == DailyQuota.check_and_record(:theme_create, subject, 5)
  end

  test "distinct subjects have independent quotas" do
    assert :ok == DailyQuota.check_and_record(:theme_create, {:user, "a"}, 1)
    assert {:error, :rate_limited} == DailyQuota.check_and_record(:theme_create, {:user, "a"}, 1)
    assert :ok == DailyQuota.check_and_record(:theme_create, {:user, "b"}, 1)
  end

  test "distinct buckets have independent quotas for the same subject" do
    subject = {:user, "a"}
    assert :ok == DailyQuota.check_and_record(:theme_create, subject, 1)
    assert {:error, :rate_limited} == DailyQuota.check_and_record(:theme_create, subject, 1)
    assert :ok == DailyQuota.check_and_record(:other_bucket, subject, 1)
  end

  test "a blocked call does NOT consume further quota (no runaway increment)" do
    subject = {:user, "a"}
    assert :ok == DailyQuota.check_and_record(:theme_create, subject, 1)
    assert {:error, :rate_limited} == DailyQuota.check_and_record(:theme_create, subject, 1)
    assert {:error, :rate_limited} == DailyQuota.check_and_record(:theme_create, subject, 1)
    # Raising the limit to 2 immediately after: exactly one slot remains, proving
    # the blocked calls never incremented past the recorded 1.
    assert :ok == DailyQuota.check_and_record(:theme_create, subject, 2)
  end

  test "a new day resets the quota" do
    day1 = ~D[2026-07-17]
    day2 = ~D[2026-07-18]
    assert :ok == DailyQuota.check_and_record(:theme_create, {:user, "a"}, 1, day1)
    assert {:error, :rate_limited} == DailyQuota.check_and_record(:theme_create, {:user, "a"}, 1, day1)
    assert :ok == DailyQuota.check_and_record(:theme_create, {:user, "a"}, 1, day2)
  end
end
