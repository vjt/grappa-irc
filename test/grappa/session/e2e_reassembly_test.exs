defmodule Grappa.Session.E2eReassemblyTest do
  use ExUnit.Case, async: true

  alias Grappa.IRC.E2e
  alias Grappa.Session.E2eReassembly

  @budget 300

  # Two device ids, and the addresses each verb carries (wire v2).
  @alice "If4x36FUomE"
  @bob "AaZaARRDyBk"
  @addresses %{
    keyreq: {@alice, "*"},
    keys: {"*", @bob},
    pkmsg: {@alice, @bob},
    msg: {@alice, "*"},
    nack: {@alice, @bob}
  }

  # Real lines, cut by the production fragmenter and read back by the
  # production parser — never hand-built fragments.
  defp fragments(verb, msgid, payload) do
    {:ok, lines} = E2e.fragment(verb, msgid, Map.fetch!(@addresses, verb), payload, @budget)

    Enum.map(lines, fn line ->
      {:ok, fragment} = E2e.parse(line)
      fragment
    end)
  end

  # Compact JSON text, what a v2 frame carries.
  defp payload(bytes), do: ~s({"v":2,"body":"#{Base.encode64(:crypto.strong_rand_bytes(bytes))}"})

  # One byte of chunk per line: the frame around a `64/64` chunk from one
  # device to another is 52 bytes, so a 53-byte budget leaves 1, and a
  # 64-char payload needs all 64.
  defp tiny_fragments(msgid) do
    {:ok, lines} = E2e.fragment(:msg, msgid, {@alice, @bob}, String.duplicate("abcd", 16), 53)
    64 = length(lines)

    Enum.map(lines, fn line ->
      {:ok, fragment} = E2e.parse(line)
      fragment
    end)
  end

  defp feed(buffer, sender, fragments, now_ms) do
    {final, results} =
      Enum.reduce(fragments, {buffer, []}, fn fragment, {acc, out} ->
        case E2eReassembly.put(acc, sender, fragment, now_ms) do
          {:complete, message, next} -> {next, [{:complete, message} | out]}
          {:pending, next} -> {next, [:pending | out]}
          {:dropped, reason, next} -> {next, [{:dropped, reason} | out]}
        end
      end)

    {final, Enum.reverse(results)}
  end

  test "a single-line message completes at once and buffers nothing" do
    payload = ~s({"v":2})
    [fragment] = fragments(:keyreq, "q83vEjRWeJA", payload)

    assert {:complete, %{verb: :keyreq, msgid: "q83vEjRWeJA", from: @alice, to: "*", payload: ^payload}, buffer} =
             E2eReassembly.put(E2eReassembly.new(), "vjt-claude", fragment, 0)

    assert E2eReassembly.empty?(buffer)
  end

  test "fragments arriving out of order complete once, with the payload byte for byte" do
    payload = payload(1_500)
    frags = fragments(:msg, "q83vEjRWeJA", payload)
    assert length(frags) > 2

    # Last line first, first line last.
    {buffer, results} = feed(E2eReassembly.new(), "vjt-claude", Enum.reverse(frags), 0)

    assert List.last(results) ==
             {:complete, %{verb: :msg, msgid: "q83vEjRWeJA", from: @alice, to: "*", payload: payload}}

    assert Enum.all?(Enum.drop(results, -1), &(&1 == :pending))
    assert E2eReassembly.empty?(buffer)
  end

  test "two senders with the same msgid are two messages" do
    payload_a = payload(800)
    payload_b = payload(800)
    [a1 | a_rest] = fragments(:msg, "q83vEjRWeJA", payload_a)
    [b1 | b_rest] = fragments(:msg, "q83vEjRWeJA", payload_b)

    {alice_started, _} = feed(E2eReassembly.new(), "alice", [a1], 0)
    {both_started, _} = feed(alice_started, "bob", [b1], 0)
    {alice_done, a_out} = feed(both_started, "alice", a_rest, 0)
    {_, b_out} = feed(alice_done, "bob", b_rest, 0)

    assert {:complete, %{payload: ^payload_a}} = List.last(a_out)
    assert {:complete, %{payload: ^payload_b}} = List.last(b_out)
  end

  test "a repeated index is ignored: the message still completes with the first copy" do
    payload = payload(800)
    [f1, f2 | rest] = fragments(:msg, "q83vEjRWeJA", payload)

    {_, results} = feed(E2eReassembly.new(), "vjt-claude", [f1, f1, f2 | rest], 0)
    assert {:complete, %{payload: ^payload}} = List.last(results)
  end

  test "a fragment contradicting its message (other verb, total, from or to) drops the whole message" do
    [f1, f2 | _] = fragments(:msg, "q83vEjRWeJA", payload(800))

    for contradiction <- [%{f2 | verb: :pkmsg}, %{f2 | total: f2.total + 1}, %{f2 | from: @bob}, %{f2 | to: @bob}] do
      {buffer, [:pending, {:dropped, :inconsistent}]} = feed(E2eReassembly.new(), "vjt-claude", [f1, contradiction], 0)
      assert E2eReassembly.empty?(buffer)
    end
  end

  test "pending?/4 is true while a message of that verb from that sender is part-way in, and not once it timed out" do
    [k1 | k_rest] = fragments(:keys, "q83vEjRWeJA", payload(800))
    refute E2eReassembly.pending?(E2eReassembly.new(), "alice", :keys, 0)

    {partial, _} = feed(E2eReassembly.new(), "alice", [k1], 0)
    assert E2eReassembly.pending?(partial, "alice", :keys, 0)
    refute E2eReassembly.pending?(partial, "bob", :keys, 0)
    refute E2eReassembly.pending?(partial, "alice", :msg, 0)

    # Still held — no sweep has run — but no longer arriving.
    timeout = E2eReassembly.timeout_ms()
    assert E2eReassembly.pending?(partial, "alice", :keys, timeout - 1)
    refute E2eReassembly.pending?(partial, "alice", :keys, timeout)

    {whole, _} = feed(partial, "alice", k_rest, 0)
    refute E2eReassembly.pending?(whole, "alice", :keys, 0)
  end

  test "expire/2 discards a message whose last fragment is 60 s old, and only that one" do
    [old1 | _] = fragments(:msg, "AAAAAAAAAAA", payload(800))
    [new1 | _] = fragments(:msg, "BBBBBBBBBBB", payload(800))
    timeout = E2eReassembly.timeout_ms()

    {old_only, _} = feed(E2eReassembly.new(), "vjt-claude", [old1], 0)
    {both, _} = feed(old_only, "vjt-claude", [new1], 1_000)

    assert {^both, 0} = E2eReassembly.expire(both, timeout - 1)
    {new_only, 1} = E2eReassembly.expire(both, timeout)
    refute E2eReassembly.empty?(new_only)
    assert {drained, 1} = E2eReassembly.expire(new_only, timeout + 1_000)
    assert E2eReassembly.empty?(drained)
  end

  test "a message whose fragments keep coming outlives 60 s from its first, and completes" do
    # The sender's fake-lag pacing drips a long message at one line per
    # 5 s: well past 60 s from the first line, never 60 s from the last.
    payload = payload(3_000)
    frags = fragments(:msg, "q83vEjRWeJA", payload)
    # More than 13 lines 5 s apart: the last lands past 60 s.
    assert length(frags) > 13

    {buffer, results} =
      frags
      |> Enum.with_index()
      |> Enum.reduce({E2eReassembly.new(), []}, fn {fragment, i}, {acc, out} ->
        now = i * 5_000
        {live, _} = E2eReassembly.expire(acc, now)
        {next, [result]} = feed(live, "vjt-claude", [fragment], now)
        {next, [result | out]}
      end)

    assert {:complete, %{payload: ^payload}} = hd(results)
    assert E2eReassembly.empty?(buffer)
  end

  test "a repeated fragment does not keep a message alive" do
    [f1, f2 | _] = fragments(:msg, "q83vEjRWeJA", payload(800))
    timeout = E2eReassembly.timeout_ms()

    {started, _} = feed(E2eReassembly.new(), "vjt-claude", [f1, f2], 0)
    {repeated, [:pending]} = feed(started, "vjt-claude", [f2], timeout - 1)
    assert {_, 1} = E2eReassembly.expire(repeated, timeout)
  end

  test "a late fragment after expiry starts over and never completes the old message" do
    [f1, f2 | rest] = fragments(:msg, "q83vEjRWeJA", payload(800))
    timeout = E2eReassembly.timeout_ms()

    {started, _} = feed(E2eReassembly.new(), "vjt-claude", [f1], 0)
    {expired, 1} = E2eReassembly.expire(started, timeout)
    {_, results} = feed(expired, "vjt-claude", [f2 | rest], timeout)

    # Without fragment 1 the message cannot complete: nothing is delivered.
    assert Enum.all?(results, &(&1 == :pending))
  end

  test "one sender may not buffer more than 32 KiB across its messages" do
    # Each message is held one fragment short of complete; the sender's
    # buffered total grows until a fragment would cross the cap.
    held =
      for n <- 1..200 do
        [first | _] = fragments(:msg, String.pad_leading("#{n}", 11, "A"), payload(800))
        first
      end

    {buffer, results} = feed(E2eReassembly.new(), "flooder", held, 0)
    assert {:dropped, :sender_cap} in results
    buffered = Enum.count(results, &(&1 == :pending))
    assert buffered * byte_size(hd(held).chunk) <= 32 * 1024

    # Another sender is not affected by the flooder's cap.
    [other | _] = fragments(:msg, "q83vEjRWeJA", payload(800))
    assert {:pending, _} = E2eReassembly.put(buffer, "vjt-claude", other, 0)
  end

  test "a fragment the sender cap refuses takes its partial message with it" do
    # M1 is started, then the sender fills its allowance with messages held
    # one fragment short. M1's next fragment is refused, and M1 can never
    # complete any more: keeping it would only hold the bytes of a dead
    # message against the sender's next ones.
    [m1_first, m1_second | _] = fragments(:msg, "M1M1M1M1M1M", payload(800))

    held =
      for n <- 1..200 do
        [first | _] = fragments(:msg, String.pad_leading("#{n}", 11, "A"), payload(800))
        first
      end

    {started, [:pending]} = feed(E2eReassembly.new(), "flooder", [m1_first], 0)
    {full, results} = feed(started, "flooder", held, 0)
    assert {:dropped, :sender_cap} in results

    assert {:dropped, :sender_cap, after_drop} = E2eReassembly.put(full, "flooder", m1_second, 0)

    # M1's buffered fragment is gone, so a fragment of the same size fits
    # where it did not before.
    [fresh | _] = fragments(:msg, "FRESHFRESHF", payload(800))
    assert {:dropped, :sender_cap, _} = E2eReassembly.put(full, "flooder", fresh, 0)
    assert {:pending, _} = E2eReassembly.put(after_drop, "flooder", fresh, 0)
  end

  test "every fragment is charged a fixed overhead, so 1-byte chunks cannot pile up" do
    # A budget that leaves exactly one byte of chunk per line: a 64-char
    # payload becomes 64 one-byte fragments. Held one short of complete,
    # 32 such messages are 2016 fragments for 2016 bytes of chunk — far
    # under 32 KiB if only chunk bytes counted.
    tiny =
      Enum.flat_map(1..32, fn n ->
        "#{n}" |> String.pad_leading(11, "A") |> tiny_fragments() |> Enum.drop(-1)
      end)

    assert length(tiny) == 2016
    {_, results} = feed(E2eReassembly.new(), "flooder", tiny, 0)

    assert {:dropped, :sender_cap} in results
    assert Enum.count(results, &(&1 == :pending)) < 1_000
  end

  test "completing a message gives its bytes back to the sender's allowance" do
    payload = payload(800)
    frags = fragments(:msg, "q83vEjRWeJA", payload)

    buffer =
      Enum.reduce(1..100, E2eReassembly.new(), fn _, buffer ->
        {buffer, results} = feed(buffer, "vjt-claude", frags, 0)
        assert {:complete, %{payload: ^payload}} = List.last(results)
        buffer
      end)

    assert E2eReassembly.empty?(buffer)
  end

  test "all senders together may not buffer more than 1 MiB" do
    {_, results} =
      Enum.reduce(1..40, {E2eReassembly.new(), []}, fn n, {buffer, acc} ->
        held =
          for m <- 1..120 do
            [first | _] = fragments(:msg, String.pad_leading("#{m}", 11, "A"), payload(800))
            first
          end

        {buffer, results} = feed(buffer, "sender#{n}", held, 0)
        {buffer, acc ++ results}
      end)

    assert {:dropped, :total_cap} in results
  end
end
