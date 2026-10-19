defmodule Grappa.Session.E2ePacerTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.Client
  alias Grappa.Session.E2ePacer

  # A cheap line (2 s, any PRIVMSG under 120 bytes) and a full one (5 s, the
  # ~400-byte line a 512-byte wire carries) — what bahamut charges, in ms.
  @cheap 2_000
  @full 5_000
  # A bank at the ceiling holds every line: what is enqueued stays queued.
  @held 10_000

  defp lines(n, cost), do: for(i <- 1..n, do: {"line#{i}", cost})

  describe "per recipient: 3 lines in any 6 s (FLUD)" do
    test "up to 3 cheap lines go out at once, with nothing left to wait for" do
      assert {:ok, releases, _, nil} =
               E2ePacer.enqueue(E2ePacer.new(), "vjt-claude", "vjt-Claude", :text, lines(3, @cheap), 0, 0)

      assert releases == [{"vjt-Claude", "line1"}, {"vjt-Claude", "line2"}, {"vjt-Claude", "line3"}]
    end

    test "a 4th line waits until the first leaves the 6 s window, then the freed slots go at once" do
      {:ok, first, pacer, wait} =
        E2ePacer.enqueue(E2ePacer.new(), "vjt-claude", "vjt-claude", :text, lines(5, @cheap), 0, 0)

      assert length(first) == 3
      assert wait == 6_000

      # Nothing is released a millisecond early.
      assert {[], pacer, 1} = E2ePacer.release(pacer, 5_999, 0)
      assert {[{"vjt-claude", "line4"}, {"vjt-claude", "line5"}], pacer, nil} = E2ePacer.release(pacer, 6_000, 0)

      # The first burst has left the window but lines 4-5 (sent at 6 s) have
      # not, so a new message gets exactly one slot now.
      assert {:ok, [{"vjt-claude", "x"}], _, _} =
               E2ePacer.enqueue(pacer, "vjt-claude", "vjt-claude", :text, [{"x", @cheap}, {"y", @cheap}], 6_000, 0)
    end

    test "recipients are paced independently" do
      {:ok, a, pacer, _} = E2ePacer.enqueue(E2ePacer.new(), "alice", "alice", :text, lines(4, 1_000), 0, 0)
      {:ok, b, _, _} = E2ePacer.enqueue(pacer, "bob", "bob", :text, lines(4, 1_000), 0, 0)
      assert length(a) == 3
      assert length(b) == 3
    end
  end

  describe "per connection: the fake-lag bank never passes the ceiling" do
    test "the ceiling is bahamut's drain gate, 10 s" do
      assert Client.fake_lag_ceiling_ms() == 10_000
    end

    test "full lines: two go at once, then each waits until the bank has room for it" do
      {:ok, first, pacer, wait} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", :text, lines(3, @full), 0, 0)
      # 0 + 5 s, then 5 + 5 = 10 s: both fit. A third would make 15.
      assert first == [{"p", "line1"}, {"p", "line2"}]
      assert wait == 5_000

      # The bank drains in real time: 5 s later it reads 5 s, room for one.
      assert {[], _, 1} = E2ePacer.release(pacer, 4_999, 5_001)
      assert {[{"p", "line3"}], _, nil} = E2ePacer.release(pacer, 5_000, 5_000)
    end

    test "a bank already filled by other traffic holds even the first line" do
      # The user just sent something: 7.7 s of debt the pacer did not make.
      assert {:ok, [], pacer, 2_700} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", :text, lines(1, @full), 0, 7_700)
      assert {[{"p", "line1"}], _, nil} = E2ePacer.release(pacer, 2_700, 5_000)
    end

    test "a line costlier than the ceiling goes out once the bank is empty, never stuck" do
      # Only possible where LINELEN is far over 512. bahamut parses any line
      # that arrives under the gate, so an empty bank is room enough.
      {:ok, [], pacer, wait} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", :text, lines(1, 12_000), 0, 3_000)
      assert wait == 3_000
      assert {[{"p", "line1"}], _, nil} = E2ePacer.release(pacer, 3_000, 0)
    end

    test "the bank is shared: a line to one recipient uses room another would have had" do
      {:ok, [_, _], pacer, _} = E2ePacer.enqueue(E2ePacer.new(), "alice", "alice", :text, lines(2, @full), 0, 0)
      # alice's two lines filled the bank (the caller reads 10 s back).
      assert {:ok, [], _, 5_000} = E2ePacer.enqueue(pacer, "bob", "bob", :text, lines(1, @full), 0, 10_000)
    end
  end

  describe "per peer bounds (issue 2430, vjt's ruling 6255346375)" do
    test "at most 32 text messages wait for one peer, counted in messages, not lines" do
      pacer =
        Enum.reduce(1..E2ePacer.max_text_messages(), E2ePacer.new(), fn n, acc ->
          {:ok, [], acc, _} = E2ePacer.enqueue(acc, "p", "p", :text, sim_lines(2, @cheap, "m#{n}"), 0, @held)
          acc
        end)

      # 64 lines wait, far under the connection's 128: it is the message
      # count that refuses, and only for this peer.
      assert {:error, :queue_full} = E2ePacer.enqueue(pacer, "p", "p", :text, lines(1, @cheap), 0, @held)
      assert {:ok, [], _, _} = E2ePacer.enqueue(pacer, "q", "q", :text, lines(1, @cheap), 0, @held)
      # Urgent traffic has its own bound: a full text queue does not hold back a KEYREQ.
      assert {:ok, [], _, _} = E2ePacer.enqueue(pacer, "p", "p", :control, [{"KEYREQ", @cheap}], 0, @held)
    end

    test "a message frees its place once its LAST line is released" do
      pacer =
        Enum.reduce(1..E2ePacer.max_text_messages(), E2ePacer.new(), fn n, acc ->
          {:ok, [], acc, _} = E2ePacer.enqueue(acc, "p", "p", :text, sim_lines(2, @cheap, "m#{n}"), 0, @held)
          acc
        end)

      # Room for exactly one 2 s line: the first message's first line.
      {[_], half, _} = E2ePacer.release(pacer, 0, 8_000)
      assert {:error, :queue_full} = E2ePacer.enqueue(half, "p", "p", :text, lines(1, @cheap), 0, @held)

      {[_], whole, _} = E2ePacer.release(half, 1, 8_000)
      assert {:ok, [], _, _} = E2ePacer.enqueue(whole, "p", "p", :text, lines(1, @cheap), 1, @held)
    end

    test "at most 32 urgent lines wait for one peer, and a message that would pass it is refused whole" do
      {:ok, [], pacer, _} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", :control, lines(31, @cheap), 0, @held)
      assert {:error, :queue_full} = E2ePacer.enqueue(pacer, "p", "p", :control, lines(2, @cheap), 0, @held)
      assert {:ok, [], _, _} = E2ePacer.enqueue(pacer, "p", "p", :control, lines(1, @cheap), 0, @held)
    end
  end

  describe "urgent within a budget, peers in turn" do
    test "urgent lines go ahead of another peer's text only up to the budget, then the two take turns" do
      {:ok, [], urgent, _} = E2ePacer.enqueue(E2ePacer.new(), "a", "a", :control, lines(12, @cheap), 0, @held)
      {:ok, [], both, _} = E2ePacer.enqueue(urgent, "b", "b", :text, lines(12, @cheap), 0, @held)

      assert one_per_step(both, 12) == List.duplicate("a", E2ePacer.urgent_budget()) ++ ["b", "a", "b", "a"]
    end

    test "the budget comes back once the urgent window has passed" do
      # b's text is queued FIRST, so on a tie b's older lines win: a can be
      # first at the end only because its line is urgent again.
      {:ok, [], text, _} = E2ePacer.enqueue(E2ePacer.new(), "b", "b", :text, lines(9, @cheap), 0, @held)
      {:ok, [], both, _} = E2ePacer.enqueue(text, "a", "a", :control, lines(9, @cheap), 0, @held)

      spent =
        Enum.reduce(0..(E2ePacer.urgent_budget() - 1), both, fn i, acc ->
          {[{"a", _}], acc, _} = E2ePacer.release(acc, i * 2_500, 8_000)
          acc
        end)

      # Budget spent: b, served never, goes first...
      assert {[{"b", _}], turned, _} = E2ePacer.release(spent, 20_000, 8_000)
      # ...and once a's first urgent line is 60 s old, a's next is urgent again.
      assert {[{"a", _}], _, _} = E2ePacer.release(turned, E2ePacer.urgent_window_ms(), 8_000)
    end

    test "a peer whose queue empties keeps its spent budget until the window has passed" do
      {:ok, [], text, _} = E2ePacer.enqueue(E2ePacer.new(), "b", "b", :text, lines(9, @cheap), 0, @held)
      {:ok, [], both, _} = E2ePacer.enqueue(text, "a", "a", :control, lines(E2ePacer.urgent_budget(), @cheap), 0, @held)

      spent =
        Enum.reduce(0..(E2ePacer.urgent_budget() - 1), both, fn i, acc ->
          {[{"a", _}], acc, _} = E2ePacer.release(acc, i * 2_500, 8_000)
          acc
        end)

      # a has nothing left and its FLUD window has emptied; a release that
      # fits nothing still tidies the lanes, and forgetting a's there would
      # hand a fresh budget to the next KEYREQ.
      {[], tidied, _} = E2ePacer.release(spent, 25_000, @held)
      {:ok, [], again, _} = E2ePacer.enqueue(tidied, "a", "a", :control, [{"KEYREQ", @cheap}], 30_000, @held)
      assert {[{"b", _}], _, _} = E2ePacer.release(again, 30_000, 8_000)
    end

    test "text takes turns across peers instead of draining in queue order" do
      {:ok, [], long, _} = E2ePacer.enqueue(E2ePacer.new(), "a", "a", :text, lines(5, @cheap), 0, @held)
      {:ok, [], both, _} = E2ePacer.enqueue(long, "b", "b", :text, lines(1, @cheap), 1, @held)

      # b's one line waits behind a's first only, not behind all five.
      assert one_per_step(both, 6) == ["a", "b", "a", "a", "a", "a"]
    end
  end

  describe "the wake follows the ranking, not only the line it tried" do
    test "a peer whose FLUD window empties ranks as never served, and the pacer wakes for it" do
      # a sent at 0 s, b at 1 s and kept a cheap line queued; a then queues a
      # full line. At 4 s a ranks first (served longest ago) but its line
      # does not fit a 9 s bank.
      {:ok, [_], a_sent, _} = E2ePacer.enqueue(E2ePacer.new(), "a", "a", :text, [{"a1", @cheap}], 0, 0)

      {:ok, [{"b", "b1"}], b_sent, _} =
        E2ePacer.enqueue(a_sent, "b", "b", :text, [{"b1", @cheap}, {"b2", @cheap}], 1_000, 7_000)

      {:ok, [], queued, _} = E2ePacer.enqueue(b_sent, "a", "a", :text, [{"a2", @full}], 2_000, @held)

      # At 7 s b's send leaves its window too: both read never served, b's
      # line is the older one and fits a 6 s bank. Waiting for a's bank
      # room (8 s) would send it a second late.
      assert first_release(queued, 4_000, 9_000) == {7_000, [{"b", "b2"}]}
    end

    test "a peer whose spent urgent budget comes back ranks first again, and the pacer wakes for it" do
      # b's full line is queued FIRST: while a is past its budget, b's
      # older line ranks ahead of a's urgent one.
      {:ok, [], text, _} = E2ePacer.enqueue(E2ePacer.new(), "b", "b", :text, [{"full", @full}], 0, @held)
      budget = E2ePacer.urgent_budget()
      {:ok, [], both, _} = E2ePacer.enqueue(text, "a", "a", :control, lines(budget + 1, @cheap), 0, @held)

      spent =
        Enum.reduce(0..(budget - 1), both, fn i, acc ->
          {[{"a", _}], acc, _} = E2ePacer.release(acc, i * 2_500, 8_000)
          acc
        end)

      # At 58 s b's line waits for bank room until 62.5 s. a's first urgent
      # release turns 60 s old at 60 s; a's line is urgent again and fits.
      assert first_release(spent, 58_000, 9_500) == {E2ePacer.urgent_window_ms(), [{"a", "line#{budget + 1}"}]}
    end
  end

  property "whenever lines wait the pacer asks to be woken, and waking it then sends every line" do
    # No busy loop and no stall: `wake_at/2` refuses a wait under 1 ms, and
    # a `nil` wait with lines still queued would end the run short.
    check all(arrivals <- arrivals()) do
      sent = simulate(arrivals)
      assert length(sent) == Enum.sum(for {_, _, _, n, _} <- arrivals, do: n)
    end
  end

  describe "control first, text in order" do
    test "a control message goes ahead of the queued text of a longer one, across recipients" do
      {:ok, [_, _], started, _} = E2ePacer.enqueue(E2ePacer.new(), "alice", "alice", :text, lines(5, @full), 0, 0)
      {:ok, [], queued, _} = E2ePacer.enqueue(started, "bob", "bob", :control, [{"KEYREQ", @cheap}], 100, 9_900)

      # Room for one more line opens: bob's control message takes it, though
      # alice's line 3 was queued first.
      assert {[{"bob", "KEYREQ"}], after_control, _} = E2ePacer.release(queued, 5_000, 5_000)
      assert {[{"alice", "line3"}], _, _} = E2ePacer.release(after_control, 6_000, 3_000)
    end

    test "a short text message does not overtake a long one queued before it" do
      # The peer would display the two backwards: text never reorders.
      {:ok, [_, _], started, _} = E2ePacer.enqueue(E2ePacer.new(), "alice", "alice", :text, lines(3, @full), 0, 0)
      {:ok, [], queued, _} = E2ePacer.enqueue(started, "alice", "alice", :text, [{"short", @cheap}], 100, 9_900)

      assert {[{"alice", "line3"}], after_long, _} = E2ePacer.release(queued, 5_000, 5_000)
      assert {[{"alice", "short"}], _, _} = E2ePacer.release(after_long, 10_000, 3_000)
    end

    test "a multi-line control message keeps its lines in order, ahead of text" do
      {:ok, [_, _], started, _} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", :text, lines(4, @full), 0, 0)

      {:ok, [], queued, _} =
        E2ePacer.enqueue(started, "p", "p", :control, [{"c1", @cheap}, {"c2", @cheap}], 0, 10_000)

      assert {[{"p", "c1"}, {"p", "c2"}], _, _} = E2ePacer.release(queued, 6_000, 4_000)
    end

    test "otherwise lines leave in the order they were queued, across messages" do
      {:ok, _, first, _} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", :text, lines(4, @cheap), 0, 0)
      {:ok, [], second, _} = E2ePacer.enqueue(first, "p", "p", :text, [{"b1", @cheap}, {"b2", @cheap}], 100, 0)
      assert {[{"p", "line4"}, {"p", "b1"}, {"p", "b2"}], _, nil} = E2ePacer.release(second, 6_100, 0)
    end
  end

  test "the 128-line cap is per connection: lines waiting for one recipient count against another" do
    {:ok, _, half, _} = E2ePacer.enqueue(E2ePacer.new(), "alice", "alice", :text, lines(64, @cheap), 0, 0)
    {:ok, _, full, _} = E2ePacer.enqueue(half, "bob", "bob", :text, lines(64, @cheap), 0, 0)
    # 6 went out at once (3 each), so 122 wait: 6 more fit, 7 do not.
    assert {:error, :queue_full} = E2ePacer.enqueue(full, "carol", "carol", :text, lines(7, @cheap), 0, 0)
    assert {:ok, _, _, _} = E2ePacer.enqueue(full, "carol", "carol", :text, lines(6, @cheap), 0, 0)
  end

  test "a bank-blocked wake comes early when a recipient with an older line gets its FLUD slot back first" do
    # alice: 4 one-second lines at 0 s, 3 go, the 4th waits for her window
    # (6 s). bob: a full line at 5 s against a bank other traffic filled.
    {:ok, [_, _, _], started, 6_000} = E2ePacer.enqueue(E2ePacer.new(), "alice", "alice", :text, lines(4, 1_000), 0, 0)

    # bob alone would wait 4.5 s for the bank; alice's older line fits at
    # 6 s (bank 8.5 + 1 <= 10), one second from now.
    assert {:ok, [], _, 1_000} = E2ePacer.enqueue(started, "bob", "bob", :text, lines(1, @full), 5_000, 9_500)
  end

  test "a message that would overflow the 128-line queue is refused whole" do
    {:ok, _, half, _} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", :text, lines(64, @cheap), 0, 0)
    {:ok, _, full, _} = E2ePacer.enqueue(half, "p", "p", :text, lines(64, @cheap), 0, 0)
    assert {:error, :queue_full} = E2ePacer.enqueue(full, "p", "p", :text, lines(10, @cheap), 0, 0)
    # 3 went out at once, so 125 wait: 3 more fit, 4 do not.
    assert {:error, :queue_full} = E2ePacer.enqueue(full, "p", "p", :text, lines(4, @cheap), 0, 0)
    assert {:ok, [], _, _} = E2ePacer.enqueue(full, "p", "p", :text, lines(3, @cheap), 0, 0)
  end

  test "an idle recipient is forgotten once its window empties" do
    {:ok, _, pacer, nil} = E2ePacer.enqueue(E2ePacer.new(), "p", "p", :text, lines(3, @cheap), 0, 0)
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
      {0, "p", :text, 4, @full},
      {500, "q", :text, 1, @cheap},
      {2_500, "p", :text, 5, 3_000},
      {9_000, "q", :text, 6, @full},
      {9_100, "p", :text, 1, @cheap}
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

  # Follows the wakes the pacer asks for while a bank other traffic filled
  # drains in real time, until something is released: when, and what.
  defp first_release(pacer, now, bank) do
    case E2ePacer.release(pacer, now, bank) do
      {[], next, wait} when is_integer(wait) -> first_release(next, now + wait, max(bank - wait, 0))
      {out, _, _} -> {now, out}
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
      |> Enum.reduce(start, fn {{at, key, class, count, cost}, n}, acc ->
        caught_up = run_until(acc, at)
        bank = bank(caught_up.since, at)

        {:ok, out, pacer, wait} =
          E2ePacer.enqueue(caught_up.pacer, key, key, class, sim_lines(count, cost, "m#{n}"), at, bank)

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
  # A wait under 1 ms would be a busy loop: the session re-arms its timer
  # with it and asks again at once.
  defp wake_at(now, wait) when is_integer(wait) and wait >= 1, do: now + wait

  # One line per step: each release sees a bank with room for exactly one
  # 2 s line, and steps are 2.5 s apart, so no peer's FLUD window (3 in
  # 6 s) is ever what decides. Returns the peer served at each step.
  defp one_per_step(pacer, steps) do
    {out, _} =
      Enum.map_reduce(0..(steps - 1), pacer, fn i, acc ->
        {[{key, _}], acc, _} = E2ePacer.release(acc, i * 2_500, 8_000)
        {key, acc}
      end)

    out
  end

  # Up to 12 messages at increasing times, to two or three peers, either
  # class, under every per-peer and connection bound.
  defp arrivals do
    gen all(
          steps <-
            list_of(
              tuple(
                {integer(0..4_000), member_of(["p", "q", "r"]), member_of([:control, :text]), integer(1..2),
                 member_of([1_000, @cheap, 3_000, @full])}
              ),
              min_length: 1,
              max_length: 12
            )
        ) do
      {arrivals, _} =
        Enum.map_reduce(steps, 0, fn {gap, key, class, n, cost}, at -> {{at + gap, key, class, n, cost}, at + gap} end)

      arrivals
    end
  end
end
