defmodule Grappa.ApplicationAmbientReapersTest do
  # #893 — determinism pin for the ambient sweepers.
  #
  # The application supervisor starts three periodic reapers (Visitors /
  # Uploads / Accounts) in EVERY env, test included, and
  # `Grappa.DataCase` puts the Sandbox in SHARED mode for `async: false`
  # tests. So an ambient tick issues its `delete_all` / soft-delete on
  # the CURRENT test's connection — a cross-test writer nobody armed,
  # firing at wall-clock rather than at anything the test did. On CI it
  # reaped the row out from under `Uploads.ReaperTest`'s sustained-busy
  # case (1 failure in 5185): that test's own sweep degraded exactly as
  # designed, and the ambient reaper flipped `deleted_at` behind it.
  #
  # The cure is a deterministic SETUP, not a weakened assert: in test the
  # cadence is pushed past any suite runtime (`:reaper_interval_ms` in
  # `config/test.exs`), so no ambient sweep ever fires. This pins that —
  # it is RED against the pre-#893 tree (60s in test) and covers a FOURTH
  # reaper automatically, because the set is derived from the running
  # supervisor rather than listed by hand.
  use ExUnit.Case, async: true

  # No `mix test` run comes near an hour; production stays at 60s.
  @suite_ceiling_ms :timer.minutes(60)

  @known [Grappa.Visitors.Reaper, Grappa.Uploads.Reaper, Grappa.Accounts.Reaper]

  test "no application-supervised reaper is scheduled to tick during a suite run" do
    reapers = running_reapers()

    assert Enum.sort(Enum.map(reapers, &elem(&1, 0))) == Enum.sort(@known),
           "the reaper set derived from the running supervisor drifted from the known set — " <>
             "if a reaper was added or renamed, the pin below must still cover it"

    for {mod, pid} <- reapers do
      assert %{interval_ms: interval} = :sys.get_state(pid)

      assert interval > @suite_ceiling_ms,
             "#{inspect(mod)} ticks every #{interval}ms in the test env. An ambient sweep " <>
               "during the suite runs on the shared Sandbox connection of whatever " <>
               "`async: false` test is live and mutates its rows (#893). Raise " <>
               "`:reaper_interval_ms` in config/test.exs instead of arming this one by hand."
    end
  end

  defp running_reapers do
    Grappa.Supervisor
    |> Supervisor.which_children()
    |> Enum.filter(fn {id, pid, _, _} -> reaper?(id) and is_pid(pid) end)
    |> Enum.map(fn {id, pid, _, _} -> {id, pid} end)
  end

  defp reaper?(id) when is_atom(id), do: id |> Atom.to_string() |> String.ends_with?(".Reaper")
  defp reaper?(_), do: false
end
