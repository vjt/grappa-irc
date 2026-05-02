defmodule Mix.Tasks.Grappa.ReapVisitorsTest do
  @moduledoc """
  Smoke-tests the `mix grappa.reap_visitors` operator-recovery CLI
  entry point.

  This task is the unblocker for the `Grappa.Bootstrap` W7 hard-error
  path (Task 20): when an operator drops a network from the DB while
  visitor rows still point at it, `Bootstrap.run/0` raises with
  recovery instructions that point here. Boots with `Bootstrap`
  suppressed via `Mix.Tasks.Grappa.Boot.start_app_silent/0` — the
  whole point is recovering from a state that makes a normal boot
  raise.

  `async: true` because `Grappa.DataCase` sandboxes per test; the
  Visitor inserts here don't touch any singleton (no
  `SessionSupervisor`, no `SessionRegistry`).
  """
  use Grappa.DataCase, async: true

  import ExUnit.CaptureIO

  alias Grappa.Visitors
  alias Mix.Tasks.Grappa.ReapVisitors

  test "deletes visitors matching --network=<slug>, leaves others" do
    keep_slug = "keep-#{System.unique_integer([:positive])}"
    drop_slug = "drop-#{System.unique_integer([:positive])}"

    {:ok, keep} =
      Visitors.find_or_provision_anon(
        "a#{System.unique_integer([:positive])}",
        keep_slug,
        nil
      )

    {:ok, drop} =
      Visitors.find_or_provision_anon(
        "b#{System.unique_integer([:positive])}",
        drop_slug,
        nil
      )

    output = capture_io(fn -> ReapVisitors.run(["--network=#{drop_slug}"]) end)

    assert output =~ "Reaped 1 visitor(s)"
    assert output =~ drop_slug
    assert Repo.reload(keep)
    refute Repo.reload(drop)
  end

  test "rejects --network missing" do
    assert_raise Mix.Error, ~r/--network=<slug>/, fn -> ReapVisitors.run([]) end
  end
end
