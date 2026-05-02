defmodule Grappa.Visitors.ReaperTest do
  @moduledoc """
  Tests for `Grappa.Visitors.Reaper` — the GenServer that periodically
  sweeps `expires_at <= now()` visitors out of the DB.

  `async: false` because:
    1. `Grappa.DataCase` flips the sandbox into shared mode when
       `async: false` (`shared: not tags[:async]`); the spawned Reaper
       under test sees the test's inserts via the shared connection.
    2. The "GenServer ticks every interval" case spawns a process that
       performs DB writes — without shared mode it would not see the
       expired visitor row the test prepared.
  """
  use Grappa.DataCase, async: false

  alias Grappa.Visitors
  alias Grappa.Visitors.{Reaper, Visitor}

  defp expire(visitor) do
    query = from(v in Visitor, where: v.id == ^visitor.id)
    Repo.update_all(query, set: [expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)])
  end

  describe "sweep/0" do
    test "deletes expired visitors and leaves live ones alone" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      {:ok, alive} = Visitors.find_or_provision_anon("alive", slug, nil)
      {:ok, dead} = Visitors.find_or_provision_anon("dead", slug, nil)
      expire(dead)

      assert {:ok, 1} = Reaper.sweep()
      assert Repo.reload(alive)
      refute Repo.reload(dead)
    end

    test "returns {:ok, 0} when nothing to reap" do
      assert {:ok, 0} = Reaper.sweep()
    end
  end

  describe "GenServer tick" do
    test "scheduled tick fires sweep" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      {:ok, dead} = Visitors.find_or_provision_anon("dead", slug, nil)
      expire(dead)

      pid = start_supervised!({Reaper, [interval_ms: 50, name: :"reaper_test_#{System.unique_integer([:positive])}"]})

      # Allow the spawned process to share the test sandbox connection
      # (shared mode is enabled by `async: false` above, but the Reaper
      # PID still has to be granted; without this it sees an empty DB).
      Ecto.Adapters.SQL.Sandbox.allow(Repo, self(), pid)

      Process.sleep(150)

      refute Repo.reload(dead)
    end
  end
end
