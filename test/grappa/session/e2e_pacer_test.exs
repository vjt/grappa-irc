defmodule Grappa.Session.E2ePacerTest do
  # The scenarios marked "irc-olm:" are that reference's own tests
  # (`tests/test_pacing.py` at 77688e5), moved to integer milliseconds and
  # to grappa's caller: the bank is handed in, not shared.
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.{Client, Identifier}
  alias Grappa.Session.E2ePacer

  # A bank at the ceiling holds every line: what is enqueued stays queued.
  @held 10_000

  describe "lane/2" do
    test "KEYS and NACK are reactive and KEYREQ urgent whatever the client says; a MSG/PKMSG is what it says" do
      for priority <- [:control, :text] do
        assert E2ePacer.lane(:keys, priority) == :reactive
        assert E2ePacer.lane(:nack, priority) == :reactive
        assert E2ePacer.lane(:keyreq, priority) == :urgent
      end

      for verb <- [:pkmsg, :msg] do
        assert E2ePacer.lane(verb, :control) == :urgent
        assert E2ePacer.lane(verb, :text) == :text
      end
    end
  end

  describe "per recipient: 3 lines in any 6 s (FLUD)" do
    test "irc-olm: a burst of 3, then one line per window" do
      {burst, [], pacer, 6_000} = send(E2ePacer.new(), urgent("vjt", "m", List.duplicate(2_000, 7)), 0, 0)
      assert burst == ["m:1", "m:2", "m:3"]

      # Nothing is released a millisecond early.
      assert {[], [], early, 1} = E2ePacer.release(pacer, 5_999, 0)
      {window, [], later, 6_000} = release(early, 6_000, 0)
      assert window == ["m:4", "m:5", "m:6"]
      assert {["m:7"], [], _, nil} = release(later, 12_000, 0)
    end

    test "a full window holds its own recipient only" do
      {out, [], pacer, 6_000} = send(E2ePacer.new(), nack("alice", "a", List.duplicate(1_000, 4)), 0, 0)
      assert out == ["a:1", "a:2", "a:3"]
      assert {["b:1"], [], _, 6_000} = send(pacer, nack("bob", "b", [1_000]), 0, 3_000)
    end

    test "irc-olm: one nick spelt two ways is one recipient" do
      {_, [], pacer, _} = send(E2ePacer.new(), urgent("Vjt", "m", List.duplicate(1_000, 3)), 0, 0)
      assert {[], [], _, 6_000} = send(pacer, urgent("vJT", "n", [1_000]), 0, 0)
    end
  end

  describe "per connection: the fake-lag bank" do
    test "the ceiling is bahamut's drain gate, 10 s" do
      assert Client.fake_lag_ceiling_ms() == 10_000
    end

    test "text leaves the reserve free: a full line drips every 5 s, while urgent lines go to the ceiling" do
      reserve = E2ePacer.reserve_ms()
      assert reserve == 5_000

      {["t:1"], [], pacer, 5_000} = send(E2ePacer.new(), text("p", "t", [5_000, 5_000, 5_000]), 0, 0)
      assert {["t:2"], [], _, 5_000} = release(pacer, 5_000, 0)

      assert {["u:1", "u:2"], [], _, nil} = send(E2ePacer.new(), urgent("p", "u", [5_000, 5_000]), 0, 0)
    end

    test "an urgent line takes the reserve text leaves" do
      {["t:1"], [], pacer, _} = send(E2ePacer.new(), text("alice", "t", [5_000, 5_000]), 0, 0)
      assert {["k:1"], [], _, _} = send(pacer, keyreq("bob", "k", [2_000]), 100, 4_900)
    end

    test "irc-olm: a line dearer than its limit goes only at an empty bank" do
      {[], [], text_held, 1} = send(E2ePacer.new(), text("p", "t", [6_000]), 0, 1)
      assert {["t:1"], [], _, nil} = release(text_held, 1, 0)

      {[], [], urgent_held, 3_000} = send(E2ePacer.new(), urgent("p", "u", [12_000]), 0, 3_000)
      assert {["u:1"], [], _, nil} = release(urgent_held, 3_000, 0)
    end
  end

  describe "bounded, refused whole" do
    test "irc-olm: a recipient's text stays within the messages Olm can skip, refused ones counted" do
      pacer = Enum.reduce(1..31, E2ePacer.new(), fn n, acc -> held!(acc, text("vjt", "m#{n}", [6_000])) end)

      # Past the connection's text backlog, refused: it was encrypted all
      # the same, so its key is one the receiver will skip.
      backlog = div(E2ePacer.max_backlog_ms(), 6_000) - 31 + 1
      assert {:error, :queue_full, pacer} = enqueue(pacer, text("vjt", "big", List.duplicate(6_000, backlog)), 0, @held)
      assert pacer.gap == %{"vjt" => 1}

      # 31 queued and 1 skipped: a 32nd is one too many for vjt, not for lucy.
      assert {:error, :queue_full, _} = enqueue(pacer, text("vjt", "n", [2_000]), 0, @held)
      assert {:ok, _, _, _, _} = enqueue(pacer, text("lucy", "n", [2_000]), 0, @held)
      assert E2ePacer.max_text_messages() == 32
    end

    test "irc-olm: a refused message with no text queued leaves no gap" do
      too_big = List.duplicate(6_000, div(E2ePacer.max_backlog_ms(), 6_000) + 1)
      assert {:error, :queue_full, pacer} = enqueue(E2ePacer.new(), text("vjt", "big", too_big), 0, @held)
      assert pacer.gap == %{}
    end

    test "irc-olm: a recipient's urgent and reactive lanes hold 32 lines each" do
      for {lane, other} <- [{&urgent/3, &nack/3}, {&nack/3, &urgent/3}] do
        pacer = held!(E2ePacer.new(), lane.("mal", "a", List.duplicate(2_000, E2ePacer.max_lane_lines())))
        assert {:error, :queue_full, _} = enqueue(pacer, lane.("mal", "b", [2_000]), 0, @held)
        assert {:ok, _, _, _, _} = enqueue(pacer, lane.("vjt", "b", [2_000]), 0, @held)
        assert {:ok, _, _, _, _} = enqueue(pacer, other.("mal", "b", [2_000]), 0, @held)
      end
    end

    test "irc-olm: text past the connection's backlog is refused whole, an urgent message is not" do
      half = List.duplicate(6_000, div(E2ePacer.max_backlog_ms(), 2 * 6_000))
      pacer = E2ePacer.new() |> held!(text("vjt", "a", half)) |> held!(text("other", "b", half))
      assert {:error, :queue_full, _} = enqueue(pacer, text("third", "c", [2_000]), 0, @held)
      assert {:ok, _, _, _, _} = enqueue(pacer, urgent("third", "c", [2_000]), 0, @held)
    end

    test "at most 128 urgent and reactive lines wait on the whole connection; text never takes their room" do
      assert E2ePacer.max_queued() == 128
      lane = E2ePacer.max_lane_lines()

      full =
        Enum.reduce(1..div(E2ePacer.max_queued(), lane), E2ePacer.new(), fn n, acc ->
          held!(acc, nack("mal#{n}", "n#{n}", List.duplicate(2_000, lane)))
        end)

      assert {:error, :queue_full, _} = enqueue(full, keyreq("carol", "k", [2_000]), 0, @held)
      assert {:ok, _, _, _, _} = enqueue(full, text("carol", "t", [2_000]), 0, @held)

      # 128 lines of text, well within its backlog, leave an order its place.
      chatty =
        Enum.reduce(1..4, E2ePacer.new(), fn n, acc ->
          Enum.reduce(1..32, acc, fn m, acc -> held!(acc, text("peer#{n}", "t#{n}-#{m}", [2_000])) end)
        end)

      assert {:ok, _, _, _, _} = enqueue(chatty, keyreq("carol", "k", [2_000]), 0, @held)
    end
  end

  describe "by message, in three lanes" do
    test "one order under way at a time: a second one waits for the first to end" do
      pacer = E2ePacer.new() |> held!(urgent("alice", "a", [2_000, 2_000, 2_000])) |> held!(urgent("bob", "b", [2_000]))
      # bob, never served, would take his turn after alice's first line.
      assert {["a:1", "a:2", "a:3", "b:1"], [], _, nil} = release(pacer, 0, 0)
    end

    test "one text message under way at a time" do
      pacer = E2ePacer.new() |> held!(text("alice", "a", [2_000, 2_000])) |> held!(text("bob", "b", [2_000]))
      {["a:1", "a:2"], [], after_a, 1_000} = release(pacer, 0, 0)
      assert {["b:1"], [], _, nil} = release(after_a, 1_000, 3_000)
    end

    test "a short text message never overtakes a long one queued before it for the same recipient" do
      pacer = E2ePacer.new() |> held!(text("p", "long", [5_000, 5_000])) |> held!(text("p", "short", [2_000]))
      {["long:1"], [], first, _} = release(pacer, 0, 0)
      {["long:2"], [], second, _} = release(first, 5_000, 0)
      assert {["short:1"], [], _, _} = release(second, 10_000, 0)
    end

    test "irc-olm: urgent goes before reactive" do
      pacer =
        E2ePacer.new()
        |> held!(nack("mal0", "n0", [2_000]))
        |> held!(nack("mal1", "n1", [2_000]))
        |> held!(urgent("lucy", "c", [5_000, 4_000]))

      assert {["c:1", "c:2"], [], _, _} = release(pacer, 0, 0)
    end

    test "irc-olm: reactive messages take turns by recipient" do
      # Three single-line messages each, two for the fourth: a single one
      # would be fresh, and go first. A full bank holds them all at first.
      flood = for mal <- ["mal0", "mal1", "mal2"], n <- 1..3, do: nack(mal, "#{mal}-#{n}", [2_000])
      queued = flood ++ [nack("vjt", "v1", [2_000]), nack("vjt", "v2", [2_000])]
      %{order: order} = drive(E2ePacer.new(), 0, [{0, {:charge, 10_000}} | sent_at(queued, 0)])
      assert order |> Enum.map(&recipient/1) |> Enum.take(4) == ["mal0", "mal1", "mal2", "v1"]
    end
  end

  describe "budgets ahead of text" do
    test "an order past the connection's budget waits behind text; a recipient that drew nothing still goes, from the allowance" do
      budget = E2ePacer.urgent_budget_ms()
      assert budget == 36_000

      spent =
        Enum.reduce(1..6, E2ePacer.new(), fn n, acc ->
          {[_], [], acc, _} = send(acc, urgent("u#{n}", "o#{n}", [6_000]), (n - 1) * 10_000, 0)
          acc
        end)

      pacer =
        spent
        |> held!(text("t", "t", [2_000]), 55_000)
        |> held!(urgent("u1", "again", [2_000]), 55_000)
        |> held!(urgent("new", "first", [2_000]), 55_000)

      assert {["first:1", "t:1", "again:1"], [], _, _} = release(pacer, 55_000, 0)
    end

    test "a recipient's reactive messages past its own budget wait behind text; a fresh one goes ahead" do
      assert E2ePacer.reactive_budget_ms() == 18_000

      spent =
        Enum.reduce(0..2, E2ePacer.new(), fn n, acc ->
          {[_], [], acc, _} = send(acc, nack("mal", "m#{n}", [6_000]), n * 10_000, 0)
          acc
        end)

      pacer =
        spent
        |> held!(text("t", "t", [2_000]), 25_000)
        |> held!(nack("mal", "again", [2_000]), 25_000)
        |> held!(nack("honest", "h", [2_000]), 25_000)

      assert {["h:1", "t:1"], [], _, _} = release(pacer, 25_000, 0)
    end

    test "irc-olm: a KEYS for a peer that drew nothing goes ahead of older ones" do
      # The application's own lines fill the bank first.
      mals = for mal <- ["mal0", "mal1", "mal2"], n <- 1..2, do: keys(mal, "#{mal}-#{n}", [5_000, 3_000])
      queued = sent_at(mals, 0) ++ sent_at([keys("vjt", "v", [5_000, 3_000])], 0)
      %{released: released} = drive(E2ePacer.new(), 0, [{0, {:charge, 10_000}} | queued])

      assert elem(released["v:2"], 0) <=
               Enum.min(for mal <- ["mal0", "mal1", "mal2"], do: elem(released["#{mal}-1:1"], 0))
    end
  end

  describe "the text floor" do
    test "past the floor a text message under way goes before the orders not yet started, and holds them while the bank has no room for it" do
      floor = E2ePacer.text_floor_ms()
      {["t:1"], [], pacer, _} = send(E2ePacer.new(), text("t", "t", [5_000, 5_000]), 0, 0)

      assert {["u:1"], [], _, _} = send(pacer, keyreq("u", "u", [2_000]), floor - 1, 4_000)

      {[], [], held, 4_000} = send(pacer, keyreq("u", "u", [2_000]), floor, 4_000)
      assert {["t:2", "u:1"], [], _, _} = release(held, floor + 4_000, 0)
    end

    test "irc-olm: an order under way finishes before text past the floor" do
      {["t:1"], [], pacer, _} = send(E2ePacer.new(), text("t", "t", [5_000, 5_000]), 0, 0)
      {["c:1"], [], ordered, _} = send(pacer, urgent("u", "c", [6_000, 6_000]), 15_000, 0)
      assert {["c:2"], [], _, _} = release(ordered, 21_000, 1_000)
    end

    test "irc-olm: the floor of a KEYS under way runs from its own last line" do
      ev = [
        {10_000, {:send, keys("mal0", "first", [5_000, 3_000])}},
        {15_000, {:send, keys("mal0", "second", [5_000, 3_000])}},
        {20_000, {:send, chal("h2", "chal", [6_000, 5_000], 35_000)}}
      ]

      %{released: r} = drive(E2ePacer.new(), 0, ev)

      assert Enum.map(~w(first:1 first:2 second:1 chal:1 chal:2 second:2), &elem(r[&1], 0)) ==
               [10_000, 13_000, 18_000, 20_000, 24_000, 32_000]
    end
  end

  describe "a first contact's KEYS" do
    test "irc-olm: waits its patience, then goes ahead of the orders queued after" do
      assert E2ePacer.fresh_patience_ms() == 8_000
      times = [0 | for(i <- 1..11, do: 500 + 2_000 * i)]
      [first | rest] = for {at, i} <- Enum.with_index(times), do: {at, {:send, keyreq("h#{i}", "k#{i}", [3_000])}}
      ev = [first, {0, {:send, keys("vjt", "keys", [5_000, 3_000])}} | rest]

      %{released: r} = drive(E2ePacer.new(), 0, ev)
      {at, place} = r["keys:1"]
      assert at in 8_000..11_000

      for {t, i} <- Enum.with_index(times),
          do: assert(elem(r["k#{i}:1"], 1) < place == t < 8_000, "KEYREQ #{i} at #{t}")
    end

    test "irc-olm: a fresh NACK never goes ahead of an order, whatever it waited" do
      ev = [
        {0, {:charge, 20_000}},
        {0, {:send, nack("pz0", "nack", [2_000])}},
        {9_000, {:send, chal("h0", "chal", [5_000, 4_000], 24_000)}}
      ]

      %{released: r, pacer: pacer} = drive(E2ePacer.new(), 0, ev)
      assert {elem(r["chal:1"], 0), elem(r["chal:2"], 0)} == {15_000, 19_000}
      assert elem(r["chal:2"], 1) < elem(r["nack:1"], 1)
      refute Map.has_key?(pacer.spent, {:paid, :urgent})
    end
  end

  describe "the CHAL deadline" do
    test "an urgent message whose answer can no longer make it is refused at once, and makes way" do
      # The application holds the bank past the CHAL's deadline.
      assert {:error, :too_late, pacer} = enqueue(E2ePacer.new(), chal("vjt", "c", [6_000, 5_000], 10_000), 0, 30_000)
      assert {:ok, [], [], _, 22_000} = enqueue(pacer, keyreq("vjt", "k", [2_000]), 0, 30_000)
    end

    test "the margin is ack_margin_ms/0: a deadline any closer is too late" do
      margin = E2ePacer.ack_margin_ms()
      assert margin == 2_000
      assert {:error, :too_late, _} = enqueue(E2ePacer.new(), chal("vjt", "c", [5_000], 1_000 + margin), 1_000, 0)
      assert {:ok, [_], [], _, _} = enqueue(E2ePacer.new(), chal("vjt", "c", [5_000], 1_000 + margin + 1), 1_000, 0)
    end

    test "an answer refused as too late behind queued text counts as a gap" do
      pacer = held!(E2ePacer.new(), text("vjt", "t", [2_000]))
      assert {:error, :too_late, refused} = enqueue(pacer, chal("vjt", "c", [5_000], 1_000), 0, @held)
      assert refused.gap == %{"vjt" => 1}
    end

    test "irc-olm: an urgent message is dropped when it turns too late to start" do
      # Its recipient's window holds it until a second after the last
      # instant it could still be answered: the wake names that instant,
      # and the KEYREQ behind it goes when the window opens.
      pacer =
        Enum.reduce(1..3, E2ePacer.new(), fn n, acc ->
          {[_], [], acc, _} = send(acc, keyreq("vjt", "w#{n}", [2_000]), 1_500, 0)
          acc
        end)

      {[], [], with_chal, 5_500} = send(pacer, chal("vjt", "c", [5_000, 4_000], 9_000), 1_500, 0)
      {[], [], with_keyreq, 5_500} = send(with_chal, keyreq("vjt", "k", [2_000]), 1_500, 0)
      assert {[], [{"vjt", "c", :msg}], dropped, 500} = E2ePacer.release(with_keyreq, 7_000, 0)
      assert {["k:1"], [], _, nil} = release(dropped, 7_500, 0)
    end

    test "irc-olm: a started urgent message finishes past its deadline" do
      {["c:1"], [], pacer, _} = send(E2ePacer.new(), chal("vjt", "c", [6_000, 6_000], 9_000), 0, 4_000)
      # The application then fills the bank: half a message is worse than a late one.
      assert {[], [], pacer, _} = release(pacer, 20_000, 10_000)
      assert {["c:2"], [], _, nil} = release(pacer, 26_000, 4_000)
    end

    test "irc-olm: a CHAL dearer than the bank is dropped once its tail would be late" do
      # Its 14 s leave its tail 4 s after its head: it must start 4 s
      # earlier than a short one. The window holds it until 6 s.
      pacer =
        Enum.reduce([0, 1_000, 2_000], E2ePacer.new(), fn at, acc ->
          {[_], [], acc, _} = send(acc, keyreq("vjt", "w#{at}", [1]), at, 0)
          acc
        end)

      {[], [], dear, 3_000} = send(pacer, chal("vjt", "c", [5_000, 5_000, 4_000], 11_000), 2_000, 0)
      assert {[], [{"vjt", "c", :msg}], _, _} = E2ePacer.release(dear, 5_000, 0)

      # A short one with the same deadline waits for the window and goes,
      # a line per slot as the window frees them.
      {[], [], short, 4_000} = send(pacer, chal("vjt", "c", [5_000, 4_000], 11_000), 2_000, 0)
      {["c:1"], [], rest, 1_000} = release(short, 6_000, 0)
      assert {["c:2"], [], _, nil} = release(rest, 7_000, 4_000)
    end

    test "irc-olm: an urgent message dropped past its deadline counts as a gap" do
      texts = Enum.reduce(1..31, E2ePacer.new(), fn n, acc -> held!(acc, text("vjt", "m#{n}", [2_000])) end)
      pacer = held!(texts, chal("vjt", "c", [5_000, 4_000], 20_000))
      assert {[], [{"vjt", "c", :msg}], dropped, _} = E2ePacer.release(pacer, 18_000, @held)
      assert dropped.gap == %{"vjt" => 1}
      assert {:error, :queue_full, _} = enqueue(dropped, text("vjt", "n", [2_000]), 18_000, @held)
    end
  end

  describe "drop/3: a line that failed to go out" do
    test "irc-olm: dropping the rest of a message frees its text and its turn" do
      pacer =
        E2ePacer.new()
        |> held!(text("vjt", "m", [5_000, 5_000, 5_000]))
        |> held!(text("vjt", "n", [5_000]))
        |> held!(text("lucy", "o", [5_000, 5_000]))

      {["m:1"], [], started, _} = release(pacer, 0, 0)
      dropped = E2ePacer.drop(started, "vjt", "m")
      assert dropped.text_cost == 15_000 and dropped.gap == %{"vjt" => 1}
      assert dropped.text_messages == %{"vjt" => 1, "lucy" => 1}
      assert {["o:1"], [], _, _} = release(dropped, 6_000, 0)
    end

    test "irc-olm: a failed write of a fresh answer leaves nothing paid behind" do
      {["k:1"], [], pacer, _} = send(E2ePacer.new(), keys("vjt", "k", [5_000, 3_000]), 0, 0)
      dropped = E2ePacer.drop(pacer, "vjt", "k")
      assert dropped.queues == %{} and dropped.open == %{}
      assert MapSet.size(dropped.paid) == 0 and MapSet.size(dropped.fresh) == 0
      assert dropped.reactive_at == %{} and dropped.cutoff == %{}
    end
  end

  test "irc-olm: an idle recipient leaves nothing behind once its windows pass" do
    {[_], [], pacer, nil} = send(E2ePacer.new(), keyreq("p", "k", [2_000]), 0, 0)
    # Its FLUD slot is kept until the line leaves the window, its budget
    # until the budget window passes.
    {[], [], kept, nil} = release(pacer, 6_000, 0)
    assert Map.has_key?(kept.spent, {"p", :urgent}) and kept.sent == %{}
    {[], [], gone, nil} = release(kept, E2ePacer.budget_window_ms(), 0)
    assert gone.spent == %{} and gone.served == %{} and gone.queues == %{}
  end

  test "irc-olm: a recipient gone quiet forgets a turn no older than every queued one's, and comes back first" do
    # One drain serves both at 0: their turns are equal. bob's queue
    # empties, alice's waits for her window; a wake while bob is quiet
    # forgets his turn, so when both windows open he goes first, as a
    # recipient never served does.
    pacer =
      E2ePacer.new()
      |> held!(nack("bob", "b", [100, 100, 100]))
      |> then(&Enum.reduce(1..4, &1, fn n, acc -> held!(acc, nack("alice", "a#{n}", [100])) end))

    {["b:1", "b:2", "b:3", "a1:1", "a2:1", "a3:1"], [], served, 6_000} = release(pacer, 0, 0)
    {[], [], quiet, _} = release(served, 500, 0)
    {[], [], back, _} = send(quiet, nack("bob", "n", [100]), 1_000, 0)
    assert {["n:1", "a4:1"], [], _, _} = release(back, 6_000, 0)
  end

  property "irc-olm: nothing falls due before the wake, and the wake is never now" do
    # Event-driven, as the session runs it: between one wake and the next
    # nothing may become due (a window opening, the bank's room, a budget
    # recovering, a dead urgent message making way, a patience or a floor
    # running out), and a wake at `now` with nothing due would spin.
    check all(arrivals <- arrivals(), max_runs: 60) do
      %{order: order, steps: steps, pacer: pacer} = drive(E2ePacer.new(), 0, arrivals)

      for {now, at_now, bank, next} <- steps, k <- 1..7, t = now + div((next - now) * k, 8), t > now and t < next do
        assert {[], [], _, _} = E2ePacer.release(at_now, t, max(bank - (t - now), 0)),
               "due at #{t}, between #{now} and #{next}"
      end

      assert pacer.queues == %{}
      sent = MapSet.new(order)
      for {_, {:send, m}} <- arrivals, do: assert_whole(m, sent)
    end
  end

  property "driven the way the session drives it, neither bahamut rule is ever broken" do
    check all(arrivals <- arrivals(), max_runs: 60) do
      %{log: log} = drive(E2ePacer.new(), 0, arrivals)

      for {at, key, _, _, _} <- log do
        in_window = Enum.count(log, fn {u, k, _, _, _} -> k == key and u >= at and u < at + 6_000 end)
        assert in_window <= 3, "#{in_window} releases to #{key} in the window starting at #{at}"
      end

      for {at, _, bank, cost, lane} <- log do
        limit =
          if lane == :text, do: Client.fake_lag_ceiling_ms() - E2ePacer.reserve_ms(), else: Client.fake_lag_ceiling_ms()

        assert bank + cost <= max(limit, cost),
               "a #{lane} line of #{cost} ms released at #{at} with a #{bank} ms bank"
      end
    end
  end

  # --- messages, as the session hands them over ---------------------------

  defp text(to, id, costs), do: {to, %{msgid: id, verb: :msg, lane: :text, deadline_ms: nil}, costs}
  defp urgent(to, id, costs), do: {to, %{msgid: id, verb: :msg, lane: :urgent, deadline_ms: nil}, costs}
  defp chal(to, id, costs, deadline), do: {to, %{msgid: id, verb: :msg, lane: :urgent, deadline_ms: deadline}, costs}
  defp keyreq(to, id, costs), do: {to, %{msgid: id, verb: :keyreq, lane: :urgent, deadline_ms: nil}, costs}
  defp nack(to, id, costs), do: {to, %{msgid: id, verb: :nack, lane: :reactive, deadline_ms: nil}, costs}
  defp keys(to, id, costs), do: {to, %{msgid: id, verb: :keys, lane: :reactive, deadline_ms: nil}, costs}

  # Each body names its line, `msgid:n`.
  defp lines({_, %{msgid: id}, costs}), do: for({cost, n} <- Enum.with_index(costs, 1), do: {"#{id}:#{n}", cost})

  defp enqueue(pacer, {to, message, _} = m, now, bank),
    do: E2ePacer.enqueue(pacer, Identifier.canonical_target(to), to, message, lines(m), now, bank)

  # Queues `m` and returns `{bodies released, lost msgids, pacer, wait}`.
  defp send(pacer, m, now, bank) do
    {:ok, releases, lost, pacer, wait} = enqueue(pacer, m, now, bank)
    {bodies(releases), lost, pacer, wait}
  end

  defp held!(pacer, m), do: held!(pacer, m, 0)

  defp held!(pacer, m, now) do
    {[], _, pacer, _} = send(pacer, m, now, @held)
    pacer
  end

  defp release(pacer, now, bank) do
    {releases, lost, pacer, wait} = E2ePacer.release(pacer, now, bank)
    {bodies(releases), lost, pacer, wait}
  end

  defp bodies(releases), do: for({_, _, _, body} <- releases, do: body)

  defp sent_at(messages, at), do: for(m <- messages, do: {at, {:send, m}})

  defp recipient(body), do: body |> String.split(["-", ":"]) |> hd()

  defp assert_whole({_, %{msgid: id}, costs}, sent) do
    got = Enum.count(1..length(costs), &MapSet.member?(sent, "#{id}:#{&1}"))
    assert got in [0, length(costs)], "#{got} of #{length(costs)} lines of #{id} went out"
  end

  # Drives `pacer` from `now` at exactly the instants its waits name and at
  # those of `events` (`{at, {:send, m}}` or `{at, {:charge, cost}}`, what
  # the application writes itself), until nothing is left, keeping the bank
  # bahamut would keep (`since = max(since, now) + cost`). Returns every
  # release `%{body => {at, place}}`, their order, a log
  # `{at, key, bank before, cost, lane}`, and each step's
  # `{now, pacer, bank, next}` for the wake property.
  defp drive(pacer, now, events) do
    run(%{
      pacer: pacer,
      since: nil,
      wake: now,
      events: Enum.sort_by(events, &elem(&1, 0)),
      released: %{},
      order: [],
      log: [],
      steps: [],
      costs: %{}
    })
  end

  defp run(%{wake: nil, events: []} = st),
    do: %{st | order: Enum.reverse(st.order), log: Enum.reverse(st.log), steps: Enum.reverse(st.steps)}

  defp run(st) do
    now = Enum.min(Enum.reject([st.wake, List.first(Enum.map(st.events, &elem(&1, 0)))], &is_nil/1))
    {here, rest} = Enum.split_while(st.events, &(elem(&1, 0) <= now))
    fed = Enum.reduce(here, %{st | events: rest}, fn {_, ev}, acc -> event(acc, ev, now) end)
    {releases, _, pacer, wait} = E2ePacer.release(fed.pacer, now, bank(fed.since, now))
    # A wait under 1 ms would be a busy loop: the session re-arms its
    # timer with it and asks again at once.
    assert is_nil(wait) or wait >= 1
    recorded = record(%{fed | pacer: pacer}, releases, now)
    wake = if wait, do: now + wait, else: nil
    next = Enum.min(Enum.reject([wake, List.first(Enum.map(rest, &elem(&1, 0)))], &is_nil/1), fn -> nil end)
    steps = if next, do: [{now, pacer, bank(recorded.since, now), next} | recorded.steps], else: recorded.steps
    run(%{recorded | wake: wake, steps: steps})
  end

  defp event(st, {:charge, cost}, now), do: %{st | since: max(st.since || now, now) + cost}

  defp event(st, {:send, {_, message, _} = m}, now) do
    costs = Map.merge(st.costs, Map.new(lines(m), fn {body, cost} -> {body, {cost, message.lane}} end))

    case enqueue(st.pacer, m, now, bank(st.since, now)) do
      {:ok, releases, _, pacer, _} -> record(%{st | pacer: pacer, costs: costs}, releases, now)
      {:error, _, pacer} -> %{st | pacer: pacer, costs: costs}
    end
  end

  defp record(st, releases, now) do
    Enum.reduce(releases, st, fn {target, _, _, body}, acc ->
      {cost, lane} = Map.fetch!(acc.costs, body)
      place = map_size(acc.released)

      %{
        acc
        | since: max(acc.since || now, now) + cost,
          released: Map.put(acc.released, body, {now, place}),
          order: [body | acc.order],
          log: [{now, Identifier.canonical_target(target), bank(acc.since, now), cost, lane} | acc.log]
      }
    end)
  end

  defp bank(nil, _), do: 0
  defp bank(since, now), do: max(since - now, 0)

  # Up to 40 messages over two minutes, to up to four recipients, of every
  # lane, an urgent one with a deadline or not, and the application's own
  # lines now and then: irc-olm's wake test, generated.
  defp arrivals do
    message =
      tuple({
        integer(0..120_000),
        member_of(["a", "b", "c", "d"]),
        member_of([:text, :urgent, :chal, :keyreq, :nack, :keys]),
        list_of(member_of([2_000, 3_000, 4_000, 5_000, 6_000]), min_length: 1, max_length: 3),
        member_of([2_000, 8_000, 15_000])
      })

    gen all(
          messages <- list_of(message, min_length: 1, max_length: 40),
          charges <- list_of(tuple({integer(0..120_000), member_of([2_000, 3_000, 5_000])}), max_length: 4)
        ) do
      sends =
        for {{at, to, kind, costs, ttl}, n} <- Enum.with_index(messages) do
          id = "m#{n}"

          m =
            case kind do
              :text -> text(to, id, costs)
              :urgent -> urgent(to, id, costs)
              :chal -> chal(to, id, costs, at + ttl)
              :keyreq -> keyreq(to, id, [hd(costs)])
              :nack -> nack(to, id, costs)
              :keys -> keys(to, id, Enum.take(costs, 2))
            end

          {at, {:send, m}}
        end

      sends ++ for({at, cost} <- charges, do: {at, {:charge, cost}})
    end
  end
end
