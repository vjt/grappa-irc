defmodule Grappa.TestSupport.SubjectSessionTest do
  @moduledoc """
  Unit tests for `Grappa.TestSupport.SubjectSession.seed_channel/6`, the
  one seeder both test-only orchestrators write scrollback through.

  The spacing is what every e2e scroll spec is calibrated against, and
  since #2311 it is the caller's: a gap that is silently replaced, or a
  nonsensical one that is silently accepted, changes the corpus a spec
  reads without changing anything the spec can see.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.ScrollbackHelpers
  alias Grappa.TestSupport.SubjectSession

  setup do
    %{user: user_fixture(name: "seed-#{System.unique_integer([:positive])}"), network: network_fixture()}
  end

  describe "seed_channel/6" do
    test "spaces the rows gap_ms apart and lands the newest at now", %{user: user, network: network} do
      # Read the clock AROUND the call, after the fixtures: the newest row is
      # "now" as the seeder reads it, which can only fall inside this window.
      before = System.system_time(:millisecond)
      :ok = SubjectSession.seed_channel(user.id, network.id, "#bofh", 4, "seed-bot", 250)
      after_call = System.system_time(:millisecond)

      times = ScrollbackHelpers.server_times(user.id, network.id, "#bofh")

      assert length(times) == 4
      assert times |> Enum.chunk_every(2, 1, :discard) |> Enum.map(fn [a, b] -> b - a end) == [250, 250, 250]
      assert List.last(times) >= before and List.last(times) <= after_call
    end

    for {label, gap} <- [zero: 0, negative: -1, float: 1.5, string: "100", null: nil] do
      test "a #{label} gap is refused before anything is written", %{user: user, network: network} do
        # Refused by seed_channel's OWN clause, not by something it happened
        # to call with the bad value: a FunctionClauseError from anywhere
        # deeper would pass a bare assert_raise without the guard existing.
        assert %FunctionClauseError{module: SubjectSession, function: :seed_channel, arity: 6} =
                 assert_raise(FunctionClauseError, fn ->
                   SubjectSession.seed_channel(user.id, network.id, "#bofh", 3, "seed-bot", unquote(gap))
                 end)

        assert ScrollbackHelpers.server_times(user.id, network.id, "#bofh") == []
      end
    end
  end
end
