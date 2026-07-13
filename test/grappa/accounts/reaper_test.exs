defmodule Grappa.Accounts.ReaperTest do
  @moduledoc """
  Tests for `Grappa.Accounts.Reaper` — the GenServer that periodically
  GCs `sessions` rows whose `last_seen_at` is older than the idle
  window (#223 unbounded-growth fix).

  `async: false` because (mirrors `Grappa.Visitors.ReaperTest`):
    1. `Grappa.DataCase` flips the sandbox into shared mode when
       `async: false` (`shared: not tags[:async]`); the spawned Reaper
       under test sees the test's inserts via the shared connection.
    2. The tick-path case spawns a process that performs DB writes —
       without shared mode it would not see the stale session row the
       test prepared.
  """
  use Grappa.DataCase, async: false

  alias Grappa.Accounts
  alias Grappa.Accounts.{Reaper, Session}

  @idle_seconds 7 * 24 * 3600

  defp stale_user_session do
    {:ok, user} =
      Accounts.create_user(%{
        name: "reap-#{System.unique_integer([:positive])}",
        password: "correct horse battery staple"
      })

    {:ok, session} = Accounts.create_session({:user, user.id}, "127.0.0.1", "ua", [])
    when_seen = DateTime.add(DateTime.utc_now(), -(@idle_seconds + 3600), :second)
    query = from(s in Session, where: s.id == ^session.id)
    {1, _} = Repo.update_all(query, set: [last_seen_at: when_seen])
    session
  end

  describe "sweep/0" do
    test "deletes idle-expired user sessions and reports the count" do
      stale = stale_user_session()

      assert {:ok, 1} = Reaper.sweep()
      assert Repo.get(Session, stale.id) == nil
    end

    test "returns {:ok, 0} when nothing is expired" do
      assert {:ok, 0} = Reaper.sweep()
    end
  end

  describe "GenServer tick" do
    test "scheduled tick fires the sweep" do
      stale = stale_user_session()

      pid =
        start_supervised!(
          {Reaper, [interval_ms: 50, name: :"accounts_reaper_test_#{System.unique_integer([:positive])}"]}
        )

      # Grant the spawned Reaper access to the shared test sandbox
      # connection (shared mode is on via `async: false`, but the PID
      # still has to be allowed; without this it sees an empty DB).
      Ecto.Adapters.SQL.Sandbox.allow(Repo, self(), pid)

      Process.sleep(150)

      assert Repo.get(Session, stale.id) == nil
    end
  end
end
