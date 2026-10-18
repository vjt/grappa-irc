defmodule Grappa.Session.E2ePacerTest do
  use ExUnit.Case, async: true

  alias Grappa.IRC.Client
  alias Grappa.Session.E2ePacer

  # A cheap line (2 s, any PRIVMSG under 120 bytes) and a full one (5 s, the
  # ~400-byte line a 512-byte wire carries) — what bahamut charges, in ms.
  @cheap 2_000
  @full 5_000

  defp lines(n, cost), do: for(i <- 1..n, do: {"line#{i}", cost})

  describe "per recipient: 3 lines in any 6 s (FLUD)" do
    test "up to 3 cheap lines go out at once, with nothing left to wait for" do
      assert {:ok, releases, _, nil} =
               E2ePacer.enqueue(E2ePacer.new(), "vjt-claude", "vjt-Claude", lines(3, @cheap), 0, 0)

      assert releases == [{"vjt-Claude", "line1"}, {"vjt-Claude", "line2"}, {"vjt-Claude", "line3"}]
    end

    test "a 4th line waits until the first leaves the 6 s window, then the freed slots go at once" do
      {:ok, first, pacer, wait} = E2ePacer.enqueue(E2ePacer.new(), "vjt-claude", "vjt-claude", lines(5, @cheap), 0, 0)
      assert length(first) == 3
      assert wait == 6_000

      # Nothing is released a millisecond early.
      assert {[], pacer, 1} = E2ePacer.release(pacer, 5_999, 0)
      assert {[{"vjt-claude", "line4"}, {"vjt-claude", "line5"}], pacer, nil} = E2ePacer.release(pacer, 6_000, 0)

      # The first burst has left the window but lines 4-5 (sent at 6 s) have
      # not, so a new message gets exactly one slot now.
      assert {:ok, [{"vjt-claude", "x"}], _, _} =
               E2ePacer.enqueue(pacer, "vjt-claude", "vjt-claude", [{"x", @cheap}, {"y", @cheap}], 6_000, 0)
    end

    test "recipients are paced independently" do
      {:ok, a, pacer, _} = E2ePacer.enqueue(E2ePacer.new(), "alice", "alice", lines(4, 1_000), 0, 0)
      {:ok, b, _, _} = E2ePacer.enqueue(pacer, "bob", "bob", lines(4, 1_000), 0, 0)
      assert length(a) == 3
      assert length(b) == 3
    end
  end

  describe "per connection: the fake-lag bank never passes the ceiling" do
    test "the ceiling is bahamut's drain gate, 10 s" do
      assert Client.fake_lag_ceiling_ms() == 10_000
    end

    test "full lines: two go at once, then each waits until the bank has room for it" do
      {:ok, first, pacer, wait} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", lines(3, @full), 0, 0)
      # 0 + 5 s, then 5 + 5 = 10 s: both fit. A third would make 15.
      assert first == [{"p", "line1"}, {"p", "line2"}]
      assert wait == 5_000

      # The bank drains in real time: 5 s later it reads 5 s, room for one.
      assert {[], _, 1} = E2ePacer.release(pacer, 4_999, 5_001)
      assert {[{"p", "line3"}], _, nil} = E2ePacer.release(pacer, 5_000, 5_000)
    end

    test "a bank already filled by other traffic holds even the first line" do
      # The user just sent something: 7.7 s of debt the pacer did not make.
      assert {:ok, [], pacer, 2_700} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", lines(1, @full), 0, 7_700)
      assert {[{"p", "line1"}], _, nil} = E2ePacer.release(pacer, 2_700, 5_000)
    end

    test "a line costlier than the ceiling goes out once the bank is empty, never stuck" do
      # Only possible where LINELEN is far over 512. bahamut parses any line
      # that arrives under the gate, so an empty bank is room enough.
      {:ok, [], pacer, wait} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", lines(1, 12_000), 0, 3_000)
      assert wait == 3_000
      assert {[{"p", "line1"}], _, nil} = E2ePacer.release(pacer, 3_000, 0)
    end

    test "the bank is shared: a line to one recipient uses room another would have had" do
      {:ok, [_, _], pacer, _} = E2ePacer.enqueue(E2ePacer.new(), "alice", "alice", lines(2, @full), 0, 0)
      # alice's two lines filled the bank (the caller reads 10 s back).
      assert {:ok, [], _, 5_000} = E2ePacer.enqueue(pacer, "bob", "bob", lines(1, @full), 0, 10_000)
    end
  end

  describe "short messages first" do
    test "a single-line message goes ahead of the rest of a longer one, across recipients" do
      {:ok, [_, _], pacer, _} = E2ePacer.enqueue(E2ePacer.new(), "alice", "alice", lines(5, @full), 0, 0)
      {:ok, [], pacer, _} = E2ePacer.enqueue(pacer, "bob", "bob", [{"KEYREQ", @cheap}], 100, 9_900)

      # Room for one more line opens: bob's short message takes it, though
      # alice's line 3 was queued first.
      assert {[{"bob", "KEYREQ"}], pacer, _} = E2ePacer.release(pacer, 5_000, 5_000)
      assert {[{"alice", "line3"}], _, _} = E2ePacer.release(pacer, 6_000, 3_000)
    end

    test "otherwise lines leave in the order they were queued, across messages" do
      {:ok, _, first, _} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", lines(4, @cheap), 0, 0)
      {:ok, [], second, _} = E2ePacer.enqueue(first, "p", "p", [{"b1", @cheap}, {"b2", @cheap}], 100, 0)
      assert {[{"p", "line4"}, {"p", "b1"}, {"p", "b2"}], _, nil} = E2ePacer.release(second, 6_100, 0)
    end
  end

  test "a message that would overflow the 128-line queue is refused whole" do
    {:ok, _, half, _} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", lines(64, @cheap), 0, 0)
    {:ok, _, full, _} = E2ePacer.enqueue(half, "p", "p", lines(64, @cheap), 0, 0)
    assert {:error, :queue_full} = E2ePacer.enqueue(full, "p", "p", lines(10, @cheap), 0, 0)
    # 3 went out at once, so 125 wait: 3 more fit, 4 do not.
    assert {:error, :queue_full} = E2ePacer.enqueue(full, "p", "p", lines(4, @cheap), 0, 0)
    assert {:ok, [], _, _} = E2ePacer.enqueue(full, "p", "p", lines(3, @cheap), 0, 0)
  end

  test "an idle recipient is forgotten once its window empties" do
    {:ok, _, pacer, nil} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", lines(3, @cheap), 0, 0)
    assert {[], %E2ePacer{lanes: lanes}, nil} = E2ePacer.release(pacer, 5_999, 0)
    assert Map.has_key?(lanes, "p")
    assert {[], %E2ePacer{lanes: lanes}, nil} = E2ePacer.release(pacer, 6_000, 0)
    assert lanes == %{}
  end

  test "driven the way the session drives it, neither rule is ever broken" do
    # Release at every wake the pacer asks for, feeding back the bank its own
    # releases built (bahamut's `since = max(since, now) + cost`), with
    # messages of mixed line costs arriving at irregular times for two
    # recipients.
    arrivals = [
      {0, "p", 4, @full},
      {500, "q", 1, @cheap},
      {2_500, "p", 5, 3_000},
      {9_000, "q", 6, @full},
      {9_100, "p", 1, @cheap}
    ]

    sent = simulate(arrivals)
    assert length(sent) == 17

    for {t, key, _, _} <- sent do
      in_window = Enum.count(sent, fn {u, k, _, _} -> k == key and u >= t and u < t + 6_000 end)
      assert in_window <= 3, "#{in_window} releases to #{key} in the window starting at #{t}"
    end

    for {t, _, bank_before, cost} <- sent do
      assert bank_before == 0 or bank_before + cost <= Client.fake_lag_ceiling_ms(),
             "released at #{t} with a #{bank_before} ms bank and a #{cost} ms line"
    end
  end

  # Each body carries its own cost, so the simulation can charge a release
  # without knowing the pacer's internals. Returns `{at, key, bank_before,
  # cost}` per release, oldest first.
  defp sim_lines(n, cost, tag), do: for(i <- 1..n, do: {"#{tag}:#{i}:#{cost}", cost})

  defp simulate(arrivals) do
    start = %{pacer: E2ePacer.new(), sent: [], since: nil, wake: nil}

    done =
      arrivals
      |> Enum.with_index()
      |> Enum.reduce(start, fn {{at, key, count, cost}, n}, acc ->
        caught_up = run_until(acc, at)
        bank = bank(caught_up.since, at)
        {:ok, out, pacer, wait} = E2ePacer.enqueue(caught_up.pacer, key, key, sim_lines(count, cost, "m#{n}"), at, bank)
        %{record(caught_up, out, at) | pacer: pacer, wake: wake_at(at, wait)}
      end)

    Enum.reverse(run_until(done, :infinity).sent)
  end

  defp run_until(%{wake: nil} = acc, _), do: acc
  defp run_until(%{wake: wake} = acc, limit) when limit != :infinity and wake > limit, do: acc

  defp run_until(%{wake: wake} = acc, limit) do
    {out, pacer, wait} = E2ePacer.release(acc.pacer, wake, bank(acc.since, wake))
    run_until(%{record(acc, out, wake) | pacer: pacer, wake: wake_at(wake, wait)}, limit)
  end

  defp record(acc, out, at) do
    Enum.reduce(out, acc, fn {key, body}, step ->
      [_, _, cost] = String.split(body, ":")
      cost = String.to_integer(cost)
      entry = {at, key, bank(step.since, at), cost}
      %{step | sent: [entry | step.sent], since: max(step.since || at, at) + cost}
    end)
  end

  defp bank(nil, _), do: 0
  defp bank(since, now), do: max(since - now, 0)

  defp wake_at(_, nil), do: nil
  defp wake_at(now, wait), do: now + wait
end
