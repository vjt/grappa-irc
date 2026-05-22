defmodule Grappa.HealthTest do
  # async: false — these tests mutate the global
  # `Grappa.Health.@persistent_term_key` flag (single key, lock-free).
  # Concurrent assert-on-ready? tests would race the setter.
  use Grappa.DataCase, async: false

  alias Grappa.Health

  setup do
    # Snapshot + restore around every test. Application.start/2 sets
    # this to true at boot; each test starts from a known state.
    original = Health.ready?()
    on_exit(fn -> :persistent_term.put({Health, :ready}, original) end)
    :ok
  end

  describe "ready?/0 + mark_ready/0 + mark_not_ready/0" do
    test "defaults to true once Application.start/2 has run" do
      # Application.start/2 ran at test-process boot — flag is true.
      Health.mark_ready()
      assert Health.ready?() == true
    end

    test "mark_not_ready/0 flips the flag to false" do
      Health.mark_not_ready()
      assert Health.ready?() == false
    end

    test "mark_ready/0 flips the flag back to true" do
      Health.mark_not_ready()
      assert Health.ready?() == false
      Health.mark_ready()
      assert Health.ready?() == true
    end
  end

  describe "check/0 — every check passes" do
    test "returns :ok with the supervision tree up + Repo reachable + ETS present" do
      Health.mark_ready()
      assert :ok = Health.check()
    end
  end

  describe "check/0 — failure cases (review H26)" do
    test "returns {:fail, [...]} naming :ready when not ready" do
      Health.mark_not_ready()
      assert {:fail, failures} = Health.check()
      assert {:ready, reason} = List.keyfind(failures, :ready, 0)
      assert reason =~ "boot not complete"
    end

    test "ready failure preserves other check results in the same call" do
      # When :ready fails the function still runs :repo + :ets
      # checks; we want the operator to see EVERY failing layer in
      # one /healthz hit, not chase one at a time.
      Health.mark_not_ready()
      assert {:fail, failures} = Health.check()
      # :repo and :ets pass in test env — only :ready should be in
      # the failure list.
      assert Enum.count(failures, fn {name, _} -> name == :ready end) == 1
      refute Enum.any?(failures, fn {name, _} -> name == :repo end)
      refute Enum.any?(failures, fn {name, _} -> name == :ets end)
    end
  end
end
