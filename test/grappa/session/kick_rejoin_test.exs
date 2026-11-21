defmodule Grappa.Session.KickRejoinTest do
  @moduledoc """
  Issue 2657 — the kick-loop guard, as pure arithmetic over caller-supplied
  monotonic stamps: no process, no sleep. The session half (what the
  verdicts make `Session.Server` put on the wire) is
  `Grappa.Session.KickRejoinSessionTest`.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.Networks.Credential
  alias Grappa.Session.KickRejoin

  @limit KickRejoin.kick_limit()
  @window KickRejoin.window_ms()

  # Folds a list of `{channel, stamp}` kicks through the guard, returning the
  # verdicts in order and the final map.
  defp run(kicks) do
    Enum.map_reduce(kicks, %{}, fn {channel, at}, acc -> KickRejoin.record_kick(acc, channel, at) end)
  end

  # The numbers are vjt's ruling (issue 2657, decision 3), pinned here as
  # literals so moving either one is a visible decision and not a refactor.
  test "the guard stops at the third kick within ten minutes" do
    assert KickRejoin.kick_limit() == 3
    assert KickRejoin.window_ms() == 600_000
  end

  # The one constraint the ruling derives rather than chooses: with a window
  # shorter than this, the longest delay lets the kicks age out of the
  # window before the count reaches the limit, and the guard never fires.
  test "the window outlasts the rejoins the longest delay allows" do
    longest_delay_ms = Enum.max(Credential.kick_rejoin_delays()) * 1000

    assert @window >= (@limit - 1) * longest_delay_ms
  end

  test "the kicks below the limit rejoin and the kick reaching it stays out" do
    {verdicts, _} = run([{"#a", 0}, {"#a", 1_000}, {"#a", 2_000}])

    assert verdicts == [:rejoin, :rejoin, :stay_out]
  end

  test "every kick past the limit inside the window stays out" do
    {verdicts, _} = run([{"#a", 0}, {"#a", 1}, {"#a", 2}, {"#a", 3}])

    assert verdicts == [:rejoin, :rejoin, :stay_out, :stay_out]
  end

  # The boundary, from both sides. A kick exactly one window after the first
  # no longer counts it; one millisecond earlier it still does.
  test "a kick exactly one window after the first no longer counts it" do
    {verdicts, _} = run([{"#a", 0}, {"#a", 1}, {"#a", @window}])

    assert verdicts == [:rejoin, :rejoin, :rejoin]
  end

  test "a kick one millisecond inside the window still counts the first" do
    {verdicts, _} = run([{"#a", 0}, {"#a", 1}, {"#a", @window - 1}])

    assert verdicts == [:rejoin, :rejoin, :stay_out]
  end

  test "kicks on one channel do not count against another" do
    {verdicts, _} = run([{"#a", 0}, {"#a", 1}, {"#b", 2}, {"#b", 3}])

    assert verdicts == [:rejoin, :rejoin, :rejoin, :rejoin]
  end

  test "a kick drops every channel's stamps that have left the window" do
    {_, map} = run([{"#a", 0}, {"#b", 1}, {"#b", @window + 1}])

    assert map == %{"#b" => [@window + 1]}
  end

  test "the latest kick is the newest stamp of its own channel" do
    {_, map} = run([{"#a", 10}, {"#a", 20}, {"#b", 30}])

    assert KickRejoin.latest_kick?(map, "#a", 20)
    refute KickRejoin.latest_kick?(map, "#a", 10)
    refute KickRejoin.latest_kick?(map, "#a", 30)
    refute KickRejoin.latest_kick?(map, "#c", 20)
  end

  # Non-decreasing stamps on one channel, with gaps from back-to-back up to
  # well past the window so both the loop and its expiry are exercised.
  defp stamps_gen do
    gen all(gaps <- list_of(integer(0..(div(@window, 2) + 1)), min_length: 1, max_length: 30)) do
      Enum.scan(gaps, &(&1 + &2))
    end
  end

  property "no window of the guard's length holds more rejoins than the limit allows" do
    check all(stamps <- stamps_gen()) do
      {verdicts, _} = run(Enum.map(stamps, &{"#a", &1}))

      rejoined = for {at, :rejoin} <- Enum.zip(stamps, verdicts), do: at

      for at <- rejoined do
        in_window = Enum.count(rejoined, &(&1 <= at and at - &1 < @window))
        assert in_window <= @limit - 1
      end
    end
  end

  property "kicks spaced a full window apart always rejoin" do
    check all(n <- integer(1..10), start <- integer(0..1_000_000)) do
      stamps = for i <- 0..(n - 1), do: start + i * @window
      {verdicts, _} = run(Enum.map(stamps, &{"#a", &1}))

      assert Enum.all?(verdicts, &(&1 == :rejoin))
    end
  end
end
