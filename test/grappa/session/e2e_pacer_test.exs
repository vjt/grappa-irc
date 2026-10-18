defmodule Grappa.Session.E2EPacerTest do
  use ExUnit.Case, async: true

  alias Grappa.Session.E2EPacer

  defp lines(n), do: for(i <- 1..n, do: "line#{i}")

  test "up to 3 lines go out at once, with nothing left to wait for" do
    assert {:ok, releases, _, nil} = E2EPacer.enqueue(E2EPacer.new(), "vjt-claude", "vjt-Claude", lines(3), 0)
    assert releases == [{"vjt-Claude", "line1"}, {"vjt-Claude", "line2"}, {"vjt-Claude", "line3"}]
  end

  test "a 4th line waits until the first leaves the 6 s window, then one line per slot" do
    {:ok, first, pacer, wait} = E2EPacer.enqueue(E2EPacer.new(), "vjt-claude", "vjt-claude", lines(5), 0)
    assert length(first) == 3
    assert wait == 6_000

    # Nothing is released a millisecond early.
    assert {[], pacer, 1} = E2EPacer.release(pacer, 5_999)
    assert {[{"vjt-claude", "line4"}, {"vjt-claude", "line5"}], pacer, nil} = E2EPacer.release(pacer, 6_000)

    # The first burst has left the window but lines 4-5 (sent at 6 s) have
    # not, so a new message gets exactly one slot now.
    assert {:ok, [{"vjt-claude", "x"}], _, _} = E2EPacer.enqueue(pacer, "vjt-claude", "vjt-claude", ["x", "y"], 6_000)
  end

  test "no 6 s window ever holds more than 3 releases to one recipient" do
    # Drive the pacer the way Session.Server does — release at every wake
    # it asks for — with messages arriving at irregular times.
    arrivals = [{0, 4}, {500, 2}, {2_500, 5}, {9_000, 1}, {9_100, 6}]

    sent = simulate(arrivals)
    assert length(sent) == 18

    for t <- sent do
      in_window = Enum.count(sent, &(&1 >= t and &1 < t + 6_000))
      assert in_window <= 3, "#{in_window} releases in the window starting at #{t}: #{inspect(sent)}"
    end
  end

  test "recipients are paced independently" do
    {:ok, a, pacer, _} = E2EPacer.enqueue(E2EPacer.new(), "alice", "alice", lines(4), 0)
    {:ok, b, _, _} = E2EPacer.enqueue(pacer, "bob", "bob", lines(4), 0)
    assert length(a) == 3
    assert length(b) == 3
  end

  test "lines go out in the order they were queued, across messages" do
    {:ok, _, first, _} = E2EPacer.enqueue(E2EPacer.new(), "p", "p", ["a1", "a2", "a3", "a4"], 0)
    {:ok, [], second, _} = E2EPacer.enqueue(first, "p", "p", ["b1"], 100)
    assert {[{"p", "a4"}, {"p", "b1"}], _, nil} = E2EPacer.release(second, 6_100)
  end

  test "a message that would overflow the 128-line queue is refused whole" do
    {:ok, _, half, _} = E2EPacer.enqueue(E2EPacer.new(), "p", "p", lines(64), 0)
    {:ok, _, full, _} = E2EPacer.enqueue(half, "p", "p", lines(64), 0)
    assert {:error, :queue_full} = E2EPacer.enqueue(full, "p", "p", lines(10), 0)
    # 3 went out at once, so 125 wait: 3 more fit, 4 do not.
    assert {:error, :queue_full} = E2EPacer.enqueue(full, "p", "p", lines(4), 0)
    assert {:ok, [], _, _} = E2EPacer.enqueue(full, "p", "p", lines(3), 0)
  end

  test "an idle recipient is forgotten once its window empties" do
    {:ok, _, pacer, nil} = E2EPacer.enqueue(E2EPacer.new(), "p", "p", lines(3), 0)
    assert {[], %E2EPacer{lanes: lanes}, nil} = E2EPacer.release(pacer, 5_999)
    assert Map.has_key?(lanes, "p")
    assert {[], %E2EPacer{lanes: lanes}, nil} = E2EPacer.release(pacer, 6_000)
    assert lanes == %{}
  end

  # Returns the release timestamps of a run where messages of `count`
  # lines arrive at the given times and the caller wakes exactly when
  # asked.
  defp simulate(arrivals) do
    {pacer, sent, wake} =
      Enum.reduce(arrivals, {E2EPacer.new(), [], nil}, fn {at, count}, {pacer, sent, wake} ->
        {pacer, sent, _} = run_until(pacer, sent, wake, at)
        {:ok, out, pacer, wait} = E2EPacer.enqueue(pacer, "p", "p", lines(count), at)
        {pacer, sent ++ List.duplicate(at, length(out)), wake_at(at, wait)}
      end)

    {_, all_sent, _} = run_until(pacer, sent, wake, :infinity)
    all_sent
  end

  defp run_until(pacer, sent, nil, _), do: {pacer, sent, nil}
  defp run_until(pacer, sent, wake, limit) when limit != :infinity and wake > limit, do: {pacer, sent, wake}

  defp run_until(pacer, sent, wake, limit) do
    {out, pacer, wait} = E2EPacer.release(pacer, wake)
    run_until(pacer, sent ++ List.duplicate(wake, length(out)), wake_at(wake, wait), limit)
  end

  defp wake_at(_, nil), do: nil
  defp wake_at(now, wait), do: now + wait
end
