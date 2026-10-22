defmodule Grappa.Session.E2eKeyAnswersTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.Session.E2eKeyAnswers

  # What two full lines of KEYS cost: the 8 s w2 measured for one answer.
  @keys_cost 8_000

  describe "per nick" do
    test "a nick gets one KEYS answer per 15 s, a one-time key in it at most once a minute" do
      assert E2eKeyAnswers.nick_interval_ms() == 15_000
      answers = E2eKeyAnswers.record(E2eKeyAnswers.new(), "alice", :otk, @keys_cost, 0)

      assert {:error, :too_soon} = E2eKeyAnswers.admit(answers, "alice", 14_999)
      assert {:ok, :fallback} = E2eKeyAnswers.admit(answers, "alice", 15_000)
      assert {:ok, :fallback} = E2eKeyAnswers.admit(answers, "alice", 59_999)
      assert {:ok, :otk} = E2eKeyAnswers.admit(answers, "alice", 60_000)
    end

    test "a nick never answered gets a one-time key, whatever another nick drew" do
      answers = E2eKeyAnswers.record(E2eKeyAnswers.new(), "alice", :otk, @keys_cost, 0)
      assert {:ok, :otk} = E2eKeyAnswers.admit(answers, "bob", 1)
    end

    test "an answer that carried the fallback key does not count against the one-time keys" do
      answers = E2eKeyAnswers.record(E2eKeyAnswers.new(), "alice", :fallback, @keys_cost, 0)
      assert {:ok, :otk} = E2eKeyAnswers.admit(answers, "alice", 15_000)
    end
  end

  describe "per connection" do
    test "at most 30 one-time keys an hour, then the fallback until the oldest is an hour old" do
      answers =
        Enum.reduce(1..E2eKeyAnswers.otks_per_hour(), E2eKeyAnswers.new(), fn n, acc ->
          E2eKeyAnswers.record(acc, "nick#{n}", :otk, 1, n * 1_000)
        end)

      assert {:ok, :fallback} = E2eKeyAnswers.admit(answers, "fresh", 3_600_999)
      assert {:ok, :otk} = E2eKeyAnswers.admit(answers, "fresh", 3_601_000)
    end

    test "KEYS answers spend at most 22 s of fake-lag bank in any 60 s" do
      answers =
        E2eKeyAnswers.new()
        |> E2eKeyAnswers.record("alice", :otk, @keys_cost, 0)
        |> E2eKeyAnswers.record("bob", :otk, @keys_cost, 10_000)

      # 16 s spent: 6 s more fit, 6.001 do not.
      assert E2eKeyAnswers.afford?(answers, 6_000, 20_000)
      refute E2eKeyAnswers.afford?(answers, 6_001, 20_000)
      # alice's answer leaves the window at 60 s, giving its 8 s back.
      refute E2eKeyAnswers.afford?(answers, @keys_cost, 59_999)
      assert E2eKeyAnswers.afford?(answers, @keys_cost, 60_000)
    end
  end

  test "what it remembers is bounded by its windows, not by how many nicks ever asked" do
    answers =
      Enum.reduce(1..400, E2eKeyAnswers.new(), fn n, acc ->
        E2eKeyAnswers.record(acc, "nick#{n}", :otk, 1, n * 10_000)
      end)

    # At 4000 s, only the nicks answered in the last 15 s and 60 s are still
    # held, the spend of the last minute, and the one-time keys of the hour.
    %E2eKeyAnswers{answered: answered, otk_given: otk_given, otks: otks, spent: spent} = answers
    assert map_size(answered) <= 2
    assert map_size(otk_given) <= 6
    assert length(otks) <= 360
    assert length(spent) <= 6
  end

  property "driven the way the session drives it, no limit is ever broken" do
    check all(requests <- requests()) do
      answered = simulate(requests)

      for {at, nick, _, _} <- answered do
        interval = E2eKeyAnswers.nick_interval_ms()
        same = Enum.count(answered, fn {t, n, _, _} -> n == nick and t >= at and t < at + interval end)
        assert same == 1, "#{same} KEYS answers to #{nick} within #{interval} ms of #{at}"
      end

      for {at, nick, :otk, _} <- answered do
        same = Enum.count(answered, fn {t, n, k, _} -> n == nick and k == :otk and t >= at and t < at + 60_000 end)
        assert same == 1, "#{same} one-time keys to #{nick} within 60 s of #{at}"
      end

      for {at, _, _, _} <- answered do
        otks = Enum.count(answered, fn {t, _, k, _} -> k == :otk and t >= at and t < at + 3_600_000 end)
        assert otks <= E2eKeyAnswers.otks_per_hour(), "#{otks} one-time keys in the hour from #{at}"

        spent = answered |> Enum.filter(fn {t, _, _, _} -> t >= at and t < at + 60_000 end) |> Enum.map(&elem(&1, 3))

        assert Enum.sum(spent) <= E2eKeyAnswers.bank_budget_ms(),
               "#{Enum.sum(spent)} ms of bank in the minute from #{at}"
      end
    end
  end

  # Admit, then check the bank, then record: the session's order. Returns
  # `{at, nick, kind, cost}` per answer.
  defp simulate(requests) do
    {answered, _} =
      Enum.reduce(requests, {[], E2eKeyAnswers.new()}, fn {at, nick, cost}, {acc, answers} ->
        with {:ok, kind} <- E2eKeyAnswers.admit(answers, nick, at),
             true <- E2eKeyAnswers.afford?(answers, cost, at) do
          {[{at, nick, kind, cost} | acc], E2eKeyAnswers.record(answers, nick, kind, cost, at)}
        else
          _ -> {acc, answers}
        end
      end)

    Enum.reverse(answered)
  end

  # KEYREQs at increasing times from a handful of nicks, each answer
  # costing what one to three lines do.
  defp requests do
    gen all(
          steps <-
            list_of(tuple({integer(0..20_000), member_of(~w(a b c d e)), integer(2_000..15_000)}),
              min_length: 1,
              max_length: 120
            )
        ) do
      {requests, _} = Enum.map_reduce(steps, 0, fn {gap, nick, cost}, at -> {{at + gap, nick, cost}, at + gap} end)
      requests
    end
  end
end
