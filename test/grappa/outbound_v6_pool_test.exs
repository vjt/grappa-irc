defmodule Grappa.OutboundV6PoolTest do
  @moduledoc """
  Tests for `Grappa.OutboundV6Pool` — boot-time CSV parse + runtime
  random pick.

  ## Test isolation

  These tests mutate `:persistent_term[{OutboundV6Pool, :pool}]`
  directly via `boot/0`. They run `async: false` to avoid racing
  the application-level boot value (which is set once at
  `Grappa.Application.start/2` and read by every IRC.Client spawn
  in the test run).
  """
  use ExUnit.Case, async: false

  alias Grappa.OutboundV6Pool

  setup do
    prior = Application.get_env(:grappa, :outbound_v6_pool, [])

    on_exit(fn ->
      Application.put_env(:grappa, :outbound_v6_pool, prior)
      :ok = OutboundV6Pool.boot()
    end)

    :ok
  end

  describe "parse_csv/1" do
    test "returns [] for nil" do
      assert OutboundV6Pool.parse_csv(nil) == []
    end

    test "returns [] for empty string" do
      assert OutboundV6Pool.parse_csv("") == []
    end

    test "parses a single address" do
      assert OutboundV6Pool.parse_csv("2a03:4000:2:33c::9000") ==
               [{0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000}]
    end

    test "parses CSV with surrounding whitespace" do
      csv = " 2a03:4000:2:33c::9000 , 2a03:4000:2:33c::442 "
      assert length(OutboundV6Pool.parse_csv(csv)) == 2
    end

    test "skips blank entries" do
      parsed = OutboundV6Pool.parse_csv("2a03:4000:2:33c::9000,,2a03:4000:2:33c::442")
      assert length(parsed) == 2
    end

    test "raises on invalid address" do
      assert_raise ArgumentError, ~r/invalid v6 address/, fn ->
        OutboundV6Pool.parse_csv("not-an-ip")
      end
    end

    test "raises on v4 address (pool is v6-only)" do
      assert_raise ArgumentError, ~r/invalid v6 address/, fn ->
        OutboundV6Pool.parse_csv("10.0.0.1")
      end
    end
  end

  describe "pick/0" do
    test "returns :none when pool is empty" do
      Application.put_env(:grappa, :outbound_v6_pool, [])
      :ok = OutboundV6Pool.boot()
      assert OutboundV6Pool.pick() == :none
    end

    test "returns the single entry when pool has one address" do
      addr = {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000}
      Application.put_env(:grappa, :outbound_v6_pool, [addr])
      :ok = OutboundV6Pool.boot()
      assert OutboundV6Pool.pick() == {:ok, addr}
    end

    test "returns one of the configured addresses across many rolls" do
      pool = [
        {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000},
        {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x442},
        {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x6699}
      ]

      Application.put_env(:grappa, :outbound_v6_pool, pool)
      :ok = OutboundV6Pool.boot()

      picks =
        for _ <- 1..200 do
          {:ok, ip} = OutboundV6Pool.pick()
          ip
        end

      # Every pick MUST come from the pool — invariant under any
      # randomization scheme.
      assert Enum.all?(picks, &(&1 in pool))

      # With 200 rolls across a 3-element pool, hitting all three is
      # overwhelmingly likely (P(miss any) ≈ 3·(2/3)^200 ≈ 0). A
      # failure here means the pick isn't actually random — either
      # the pool wasn't loaded or Enum.random is being bypassed.
      assert picks |> Enum.uniq() |> length() == 3
    end
  end

  describe "apply_exclusions/1 + raw_pool/0" do
    setup do
      Application.put_env(:grappa, :outbound_v6_pool, [
        {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000},
        {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x442}
      ])

      :ok = OutboundV6Pool.boot()
    end

    test "effective pool = raw minus the excluded source" do
      :ok = OutboundV6Pool.apply_exclusions(["2a03:4000:2:33c::9000"])

      assert OutboundV6Pool.raw_pool() == [
               {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000},
               {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x442}
             ]

      # pick/0 now only ever returns the surviving member
      assert {:ok, {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x442}} = OutboundV6Pool.pick()
    end

    test "string-format variant of a pool member is still removed" do
      # zero-padded / uncompressed spelling of ::9000 normalizes to the
      # same tuple as the stored pool entry
      :ok = OutboundV6Pool.apply_exclusions(["2a03:4000:0002:033c:0000:0000:0000:9000"])
      refute {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000} in effective()
    end

    test "v4 exclusion against the v6 pool is a no-op" do
      :ok = OutboundV6Pool.apply_exclusions(["203.0.113.7"])
      assert length(effective()) == 2
    end

    test "is idempotent — re-running with the same exclusion is stable" do
      :ok = OutboundV6Pool.apply_exclusions(["2a03:4000:2:33c::9000"])
      :ok = OutboundV6Pool.apply_exclusions(["2a03:4000:2:33c::9000"])
      assert length(effective()) == 1
    end
  end

  # Reads the effective pool the way pick/0 does, for assertion.
  defp effective, do: :persistent_term.get({OutboundV6Pool, :pool}, [])
end
