defmodule Grappa.Visitors.ShareTokensTest do
  @moduledoc """
  ETS-backed one-shot consumption set for visitor share-token IDs.

  The actual Phoenix.Token signing / verification stays in the controller
  layer — this module is the "has this token already been redeemed?"
  ledger. Two devices clicking the same share link race here.

  `async: false` because the ShareTokens GenServer + ETS table is a
  module-singleton (named-table), shared across the whole suite.
  """
  use ExUnit.Case, async: false

  alias Grappa.Visitors.ShareTokens

  setup do
    # Fresh table state per test — clear all entries.
    for key <- ShareTokens.all_keys(), do: :ets.delete(:visitor_share_tokens_used, key)
    :ok
  end

  describe "mark_consumed/1" do
    test "first call returns :ok" do
      assert :ok = ShareTokens.mark_consumed("token-a")
    end

    test "second call with same token returns {:error, :already_consumed}" do
      :ok = ShareTokens.mark_consumed("token-b")
      assert {:error, :already_consumed} = ShareTokens.mark_consumed("token-b")
    end

    test "distinct tokens are independent" do
      assert :ok = ShareTokens.mark_consumed("token-c")
      assert :ok = ShareTokens.mark_consumed("token-d")
    end

    test "concurrent attempts on same token: exactly one :ok, rest :already_consumed" do
      token = "token-race"

      results =
        1..50
        |> Task.async_stream(fn _ -> ShareTokens.mark_consumed(token) end, max_concurrency: 50)
        |> Enum.map(fn {:ok, r} -> r end)

      oks = Enum.count(results, &(&1 == :ok))
      errs = Enum.count(results, &(&1 == {:error, :already_consumed}))

      assert oks == 1
      assert errs == 49
    end
  end

  describe "table_name/0" do
    test "returns the named ETS table atom" do
      assert ShareTokens.table_name() == :visitor_share_tokens_used
    end
  end
end
