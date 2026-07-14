defmodule Grappa.OutboundV6PoolTest do
  @moduledoc """
  Tests for `Grappa.OutboundV6Pool` — the v6 source-address rotation
  pool. #228 made it DB-driven (vjt 2026-07-14): the pool is no longer
  parsed from `GRAPPA_OUTBOUND_V6_POOL`; `apply_pool/1` receives the
  `in_pool` vhost addresses (as strings) from `Grappa.Bootstrap` /the
  admin surface and stores them in `:persistent_term`. `pick/0` stays a
  thin lock-free read so `Grappa.IRC.Client` never deps `Grappa.Vhosts`
  (which would close a boundary cycle).

  ## Test isolation

  These tests mutate `:persistent_term[{OutboundV6Pool, :pool}]` directly
  via `apply_pool/1`. They run `async: false` to avoid racing the
  application-level value (set once at boot + read by every IRC.Client
  spawn in the test run).
  """
  use ExUnit.Case, async: false

  alias Grappa.OutboundV6Pool

  setup do
    on_exit(fn -> :ok = OutboundV6Pool.apply_pool([]) end)
    :ok
  end

  describe "apply_pool/1 + pick/0" do
    test "an empty pool → pick returns :none" do
      :ok = OutboundV6Pool.apply_pool([])
      assert OutboundV6Pool.pick() == :none
    end

    test "a single-address pool → pick returns that tuple" do
      :ok = OutboundV6Pool.apply_pool(["2a03:4000:2:33c::9000"])
      assert OutboundV6Pool.pick() == {:ok, {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000}}
    end

    test "pick returns one of the configured addresses across many rolls" do
      addrs = ["2a03:4000:2:33c::9000", "2a03:4000:2:33c::442", "2a03:4000:2:33c::6699"]
      :ok = OutboundV6Pool.apply_pool(addrs)

      tuples =
        for a <- addrs do
          {:ok, t} = :inet.parse_ipv6strict_address(String.to_charlist(a))
          t
        end

      picks =
        for _ <- 1..200 do
          {:ok, ip} = OutboundV6Pool.pick()
          ip
        end

      # Every pick MUST come from the pool.
      assert Enum.all?(picks, &(&1 in tuples))
      # 200 rolls over 3 entries hits all three w.o.p.
      assert picks |> Enum.uniq() |> length() == 3
    end

    test "accepts already-parsed tuples (idempotent re-apply)" do
      tuple = {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000}
      :ok = OutboundV6Pool.apply_pool([tuple])
      assert OutboundV6Pool.pick() == {:ok, tuple}
    end

    test "skips v4 addresses (the pool is v6-only) — pick never returns them" do
      :ok = OutboundV6Pool.apply_pool(["10.0.0.1", "2a03:4000:2:33c::442"])
      assert OutboundV6Pool.pick() == {:ok, {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x442}}
    end

    test "skips malformed addresses without crashing" do
      :ok = OutboundV6Pool.apply_pool(["not-an-ip", "2a03:4000:2:33c::442"])
      assert OutboundV6Pool.pick() == {:ok, {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x442}}
    end

    test "an all-invalid list collapses to an empty pool" do
      :ok = OutboundV6Pool.apply_pool(["nope", "10.0.0.1"])
      assert OutboundV6Pool.pick() == :none
    end
  end

  describe "boot/0" do
    test "initializes an empty pool (no env read)" do
      :ok = OutboundV6Pool.boot()
      assert OutboundV6Pool.pick() == :none
    end
  end
end
