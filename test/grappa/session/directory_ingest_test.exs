defmodule Grappa.Session.DirectoryIngestTest do
  @moduledoc """
  #1390 slice 2 — the channel-directory ETL, exercised WITHOUT a session.

  This file is the boundary claim made falsifiable. It runs `async: true`
  on plain `ExUnit.Case`: no `DataCase`, no Repo, no `Session.Server`, no
  fake ircd. Its sibling `directory_test.exs` needs all four (228 lines,
  `async: false`, 23 lines naming `start_server`/`IRCServer`) because
  before this extraction the parse / buffer / throttle decisions were only
  reachable by booting a GenServer.

  If a later change re-entangles those decisions with the session process,
  this file stops compiling or stops being `async: true` — that is the
  point of it. It is not a mirror of the implementation: it asserts the
  decisions, and two of them are behaviour that a tidy-up would silently
  change (see the `abort/1` test).

  Steps are bound to numbered names (`r0`, `r1`, …) rather than rebound:
  each assertion then names the exact step it is about.
  """

  use ExUnit.Case, async: true

  alias Grappa.Session.DirectoryIngest

  # Tunables pinned per-test rather than taken from config: the point is the
  # decision boundary, and a config-derived throttle window would make the
  # assertions read as coincidence.
  defp ingest(opts) do
    DirectoryIngest.from_opts(%{
      directory_refresh_timeout_ms: Keyword.get(opts, :timeout_ms, 60_000),
      directory_progress_throttle_ms: Keyword.get(opts, :throttle_ms, 1_000)
    })
  end

  defp armed(opts, now), do: DirectoryIngest.start(ingest(opts), now, make_ref())

  defp row(name), do: %{name: name, topic: nil, user_count: 1}

  describe "parse_row/1" do
    test "a full RPL_LIST row yields name, topic and count" do
      assert {:ok, parsed} = DirectoryIngest.parse_row(["mynick", "#elixir", "42", "The topic"])
      assert parsed == %{name: "#elixir", topic: "The topic", user_count: 42}
    end

    test "a stripped upstream that omits the trailing topic yields a nil topic" do
      assert {:ok, parsed} = DirectoryIngest.parse_row(["mynick", "#elixir", "7"])
      assert parsed == %{name: "#elixir", topic: nil, user_count: 7}
    end

    test "a non-numeric user count coerces to 0 rather than crashing the ingest" do
      assert {:ok, %{user_count: 0}} = DirectoryIngest.parse_row(["mynick", "#x", "lots", "t"])
    end

    test "a shape we do not recognise is dropped" do
      assert :error = DirectoryIngest.parse_row(["mynick"])
      assert :error = DirectoryIngest.parse_row([])
    end
  end

  describe "start/3 and in_flight?/1" do
    test "a fresh ingest is not in flight, and starting arms it" do
      idle = ingest([])
      refute DirectoryIngest.in_flight?(idle)

      assert DirectoryIngest.in_flight?(DirectoryIngest.start(idle, 0, make_ref()))
    end
  end

  describe "absorb/3 — nothing is written mid-stream (issue 2046)" do
    # The pin that replaces the batch-boundary block, and it is the same
    # claim from the other side: absorbing rows produces NO write instruction
    # at any depth. The old shape emitted `{:ingest, rows}` every 200 rows;
    # if one ever comes back, the deferral has been undone and the previous
    # snapshot is being nuked mid-capture again.
    test "no depth of buffering produces a write action" do
      r0 = armed([throttle_ms: 1_000], 0)

      {_, actions} =
        Enum.reduce(1..250, {r0, []}, fn i, {run, seen} ->
          {next, emitted} = DirectoryIngest.absorb(run, row("#c#{i}"), 0)
          {next, seen ++ emitted}
        end)

      assert Enum.all?(actions, &match?({:progress, _}, &1)),
             "absorb/3 handed back a non-progress action: #{inspect(actions)}"
    end

    test "the whole capture comes out of finish/1, in wire order" do
      r0 = armed([], 0)

      {r1, []} = DirectoryIngest.absorb(r0, row("#a"), 0)
      {r2, []} = DirectoryIngest.absorb(r1, row("#b"), 0)
      {r3, []} = DirectoryIngest.absorb(r2, row("#c"), 0)

      assert {_, rows, _} = DirectoryIngest.finish(r3)
      assert Enum.map(rows, & &1.name) == ["#a", "#b", "#c"]
    end

    test "count tracks rows received, and the ping reports it" do
      r0 = armed([throttle_ms: 0], 0)

      {r1, _} = DirectoryIngest.absorb(r0, row("#a"), 0)
      {r2, _} = DirectoryIngest.absorb(r1, row("#b"), 0)
      {_, third} = DirectoryIngest.absorb(r2, row("#c"), 0)

      assert {:progress, 3} in third
    end
  end

  describe "absorb/3 — the progress throttle" do
    test "no progress ping inside the throttle window" do
      r0 = armed([throttle_ms: 1_000], 0)

      {_, actions} = DirectoryIngest.absorb(r0, row("#a"), 999)
      refute Enum.any?(actions, &match?({:progress, _}, &1))
    end

    test "a ping once the window elapses, and the window then restarts" do
      r0 = armed([throttle_ms: 1_000], 0)

      {r1, at_1000} = DirectoryIngest.absorb(r0, row("#a"), 1_000)
      assert {:progress, 1} in at_1000

      {r2, at_1500} = DirectoryIngest.absorb(r1, row("#b"), 1_500)
      refute Enum.any?(at_1500, &match?({:progress, _}, &1))

      {_, at_2000} = DirectoryIngest.absorb(r2, row("#c"), 2_000)
      assert {:progress, 3} in at_2000
    end

    test "a ping is the ONLY thing an absorb can ask for" do
      r0 = armed([throttle_ms: 0], 0)

      {_, actions} = DirectoryIngest.absorb(r0, row("#a"), 0)

      assert [{:progress, 1}] = actions
    end
  end

  describe "finish/1" do
    test "hands back the capture in wire order and the watchdog ref, and clears the run" do
      timer = make_ref()
      r0 = DirectoryIngest.start(ingest([]), 0, timer)

      {r1, []} = DirectoryIngest.absorb(r0, row("#a"), 0)
      {r2, []} = DirectoryIngest.absorb(r1, row("#b"), 0)

      assert {cleared, rows, ^timer} = DirectoryIngest.finish(r2)
      assert Enum.map(rows, & &1.name) == ["#a", "#b"]
      refute DirectoryIngest.in_flight?(cleared)
    end

    test "an empty buffer hands back an empty capture" do
      assert {cleared, [], _} = DirectoryIngest.finish(armed([], 0))
      refute DirectoryIngest.in_flight?(cleared)
    end
  end

  describe "abort/1 — the watchdog" do
    test "DROPS the buffered rows and hands back nothing to write" do
      # Behaviour pin, not tidiness. `handle_info(:directory_refresh_timeout,
      # ...)` wipes the tracker without flushing, so the whole capture is
      # lost and `ChannelDirectory.replace/3` never runs for that refresh.
      # Since issue 2046 that is also what SAVES the previous snapshot: the
      # arm nukes nothing, so a stalled refresh leaves the last good list in
      # place. A version that flushed on timeout would write a truncated
      # capture over it.
      r0 = armed([], 0)

      {r1, []} = DirectoryIngest.absorb(r0, row("#a"), 0)
      {r2, []} = DirectoryIngest.absorb(r1, row("#b"), 0)

      cleared = DirectoryIngest.abort(r2)

      refute DirectoryIngest.in_flight?(cleared)
      assert {^cleared, [], nil} = DirectoryIngest.finish(cleared)
    end
  end
end
