defmodule Grappa.Session.E2EReassemblyTest do
  use ExUnit.Case, async: true

  alias Grappa.IRC.E2E
  alias Grappa.Session.E2EReassembly

  @budget 300

  # Real lines, cut by the production fragmenter and read back by the
  # production parser — never hand-built fragments.
  defp fragments(verb, msgid, payload) do
    {:ok, lines} = E2E.fragment(verb, msgid, payload, @budget)

    Enum.map(lines, fn line ->
      {:ok, fragment} = E2E.parse(line)
      fragment
    end)
  end

  defp payload(bytes), do: Base.encode64(:crypto.strong_rand_bytes(bytes))

  defp feed(buffer, sender, fragments, now_ms) do
    {final, results} =
      Enum.reduce(fragments, {buffer, []}, fn fragment, {acc, out} ->
        case E2EReassembly.put(acc, sender, fragment, now_ms) do
          {:complete, message, next} -> {next, [{:complete, message} | out]}
          {:pending, next} -> {next, [:pending | out]}
          {:dropped, reason, next} -> {next, [{:dropped, reason} | out]}
        end
      end)

    {final, Enum.reverse(results)}
  end

  test "a single-line message completes at once and buffers nothing" do
    payload = Base.encode64(~s({"v":1}))
    [fragment] = fragments(:keyreq, "q83vEjRWeJA", payload)

    assert {:complete, %{verb: :keyreq, msgid: "q83vEjRWeJA", payload: ^payload}, buffer} =
             E2EReassembly.put(E2EReassembly.new(), "vjt-claude", fragment, 0)

    assert E2EReassembly.empty?(buffer)
  end

  test "fragments arriving out of order complete once, with the payload byte for byte" do
    payload = payload(1_500)
    frags = fragments(:msg, "q83vEjRWeJA", payload)
    assert length(frags) > 2

    # Last line first, first line last.
    {buffer, results} = feed(E2EReassembly.new(), "vjt-claude", Enum.reverse(frags), 0)

    assert List.last(results) == {:complete, %{verb: :msg, msgid: "q83vEjRWeJA", payload: payload}}
    assert Enum.all?(Enum.drop(results, -1), &(&1 == :pending))
    assert E2EReassembly.empty?(buffer)
  end

  test "two senders with the same msgid are two messages" do
    payload_a = payload(800)
    payload_b = payload(800)
    [a1 | a_rest] = fragments(:msg, "q83vEjRWeJA", payload_a)
    [b1 | b_rest] = fragments(:msg, "q83vEjRWeJA", payload_b)

    {alice_started, _} = feed(E2EReassembly.new(), "alice", [a1], 0)
    {both_started, _} = feed(alice_started, "bob", [b1], 0)
    {alice_done, a_out} = feed(both_started, "alice", a_rest, 0)
    {_, b_out} = feed(alice_done, "bob", b_rest, 0)

    assert {:complete, %{payload: ^payload_a}} = List.last(a_out)
    assert {:complete, %{payload: ^payload_b}} = List.last(b_out)
  end

  test "a repeated index is ignored: the message still completes with the first copy" do
    payload = payload(800)
    [f1, f2 | rest] = fragments(:msg, "q83vEjRWeJA", payload)

    {_, results} = feed(E2EReassembly.new(), "vjt-claude", [f1, f1, f2 | rest], 0)
    assert {:complete, %{payload: ^payload}} = List.last(results)
  end

  test "a fragment contradicting its message (other verb or total) drops the whole message" do
    [f1, f2 | _] = fragments(:msg, "q83vEjRWeJA", payload(800))

    {other_verb, [:pending, {:dropped, :inconsistent}]} =
      feed(E2EReassembly.new(), "vjt-claude", [f1, %{f2 | verb: :pkmsg}], 0)

    assert E2EReassembly.empty?(other_verb)

    {other_total, [:pending, {:dropped, :inconsistent}]} =
      feed(E2EReassembly.new(), "vjt-claude", [f1, %{f2 | total: f2.total + 1}], 0)

    assert E2EReassembly.empty?(other_total)
  end

  test "expire/2 discards a message whose first fragment is 60 s old, and only that one" do
    [old1 | _] = fragments(:msg, "AAAAAAAAAAA", payload(800))
    [new1 | _] = fragments(:msg, "BBBBBBBBBBB", payload(800))
    timeout = E2EReassembly.timeout_ms()

    {old_only, _} = feed(E2EReassembly.new(), "vjt-claude", [old1], 0)
    {both, _} = feed(old_only, "vjt-claude", [new1], 1_000)

    assert {^both, 0} = E2EReassembly.expire(both, timeout - 1)
    {new_only, 1} = E2EReassembly.expire(both, timeout)
    refute E2EReassembly.empty?(new_only)
    assert {drained, 1} = E2EReassembly.expire(new_only, timeout + 1_000)
    assert E2EReassembly.empty?(drained)
  end

  test "a late fragment after expiry starts over and never completes the old message" do
    [f1, f2 | rest] = fragments(:msg, "q83vEjRWeJA", payload(800))
    timeout = E2EReassembly.timeout_ms()

    {started, _} = feed(E2EReassembly.new(), "vjt-claude", [f1], 0)
    {expired, 1} = E2EReassembly.expire(started, timeout)
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

    {buffer, results} = feed(E2EReassembly.new(), "flooder", held, 0)
    assert {:dropped, :sender_cap} in results
    buffered = Enum.count(results, &(&1 == :pending))
    assert buffered * byte_size(hd(held).chunk) <= 32 * 1024

    # Another sender is not affected by the flooder's cap.
    [other | _] = fragments(:msg, "q83vEjRWeJA", payload(800))
    assert {:pending, _} = E2EReassembly.put(buffer, "vjt-claude", other, 0)
  end

  test "completing a message gives its bytes back to the sender's allowance" do
    payload = payload(800)
    frags = fragments(:msg, "q83vEjRWeJA", payload)

    buffer =
      Enum.reduce(1..100, E2EReassembly.new(), fn _, buffer ->
        {buffer, results} = feed(buffer, "vjt-claude", frags, 0)
        assert {:complete, %{payload: ^payload}} = List.last(results)
        buffer
      end)

    assert E2EReassembly.empty?(buffer)
  end

  test "all senders together may not buffer more than 1 MiB" do
    {_, results} =
      Enum.reduce(1..40, {E2EReassembly.new(), []}, fn n, {buffer, acc} ->
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
