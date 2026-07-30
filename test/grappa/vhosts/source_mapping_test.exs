defmodule Grappa.Vhosts.SourceMappingTest do
  @moduledoc """
  Unit + property tests for the #543 static-mapping derivation.

  `SourceMapping.derive/2` maps a client's `/64` (v6) or `/32` (v4) to a
  deterministic address inside the configured `::cb::/80`. The invariants
  under test are the ones the whole feature leans on: determinism,
  interface-id insensitivity (RFC 8981 — a roaming client keeps ONE
  outbound address), the network bits pinning inside the prefix, IPv4
  collapse onto the `/32`, and collision-freedom across a large sample.
  """

  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.Vhosts.SourceMapping

  @prefix "2a03:4000:20:2d3:cb::/80"

  # ---------------------------------------------------------------------------
  # Unit — determinism / inside-prefix / interface-id insensitivity
  # ---------------------------------------------------------------------------

  test "derive is deterministic and lands inside the prefix" do
    {:ok, ip} = SourceMapping.derive(SourceMapping.client_key({0x2001, 0xDB8, 1, 2, 3, 4, 5, 6}), @prefix)
    {:ok, ip2} = SourceMapping.derive(SourceMapping.client_key({0x2001, 0xDB8, 1, 2, 0, 0, 0, 0}), @prefix)

    # same /64, different interface id → SAME address (RFC 8981)
    assert ip == ip2
    assert SourceMapping.in_prefix?(ip, @prefix)
  end

  test "distinct /64 → distinct address; the /80 network bits are fixed" do
    {:ok, a} = SourceMapping.derive(SourceMapping.client_key({0x2001, 0xDB8, 1, 2, 0, 0, 0, 0}), @prefix)
    {:ok, b} = SourceMapping.derive(SourceMapping.client_key({0x2001, 0xDB8, 1, 3, 0, 0, 0, 0}), @prefix)

    refute a == b
    assert String.starts_with?(a, "2a03:4000:20:2d3:cb:")
    assert String.starts_with?(b, "2a03:4000:20:2d3:cb:")
  end

  test "IPv4 collapses on the /32 and lands inside the prefix" do
    k = SourceMapping.client_key({203, 0, 113, 7})
    {:ok, a} = SourceMapping.derive(k, @prefix)
    {:ok, a2} = SourceMapping.derive(SourceMapping.client_key({203, 0, 113, 7}), @prefix)

    assert a == a2
    assert SourceMapping.in_prefix?(a, @prefix)
    assert String.starts_with?(a, "2a03:4000:20:2d3:cb:")
  end

  test "a /128 prefix degenerates to the prefix address itself" do
    prefix128 = "2a03:4000:20:2d3:cb::1/128"
    {:ok, a} = SourceMapping.derive(SourceMapping.client_key({0x2001, 0xDB8, 1, 2, 0, 0, 0, 0}), prefix128)
    {:ok, b} = SourceMapping.derive(SourceMapping.client_key({0x2001, 0xDB8, 9, 9, 0, 0, 0, 0}), prefix128)

    # host_bits == 0 → hash contributes nothing; every client derives the prefix host.
    assert a == b
    assert a == "2a03:4000:20:2d3:cb::1"
    assert SourceMapping.in_prefix?(a, prefix128)
  end

  test "client_key ignores the v6 interface id (folds to the /64)" do
    assert SourceMapping.client_key({0x2001, 0xDB8, 1, 2, 0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD}) ==
             SourceMapping.client_key({0x2001, 0xDB8, 1, 2, 0, 0, 0, 0})

    assert byte_size(SourceMapping.client_key({0x2001, 0xDB8, 1, 2, 0, 0, 0, 0})) == 8
    assert byte_size(SourceMapping.client_key({203, 0, 113, 7})) == 4
  end

  # ---------------------------------------------------------------------------
  # Unit — error / boundary handling
  # ---------------------------------------------------------------------------

  test "derive rejects a malformed or non-v6 prefix" do
    assert {:error, :invalid_prefix} = SourceMapping.derive(<<0, 0, 0, 0, 0, 0, 0, 0>>, "not-a-cidr")
    assert {:error, :invalid_prefix} = SourceMapping.derive(<<0, 0, 0, 0, 0, 0, 0, 0>>, "2a03:4000:20:2d3:cb::")
    assert {:error, :invalid_prefix} = SourceMapping.derive(<<0, 0, 0, 0, 0, 0, 0, 0>>, "203.0.113.0/24")
  end

  test "in_prefix? is false for an address outside the prefix or a bad input" do
    refute SourceMapping.in_prefix?("2a03:4000:20:2d3:ffff::1", @prefix)
    refute SourceMapping.in_prefix?("203.0.113.7", @prefix)
    refute SourceMapping.in_prefix?("not-an-ip", @prefix)
    refute SourceMapping.in_prefix?("2a03:4000:20:2d3:cb::1", "not-a-cidr")
  end

  # ---------------------------------------------------------------------------
  # Collision-freedom — 100k distinct /64s derive to 100k distinct addresses
  # ---------------------------------------------------------------------------

  test "100k distinct /64s derive to 100k distinct addresses (no in-sample collision)" do
    derived =
      for i <- 1..100_000, into: MapSet.new() do
        key = SourceMapping.client_key({0x2001, 0xDB8, div(i, 0x10000), rem(i, 0x10000), 0, 0, 0, 0})
        {:ok, ip} = SourceMapping.derive(key, @prefix)
        ip
      end

    assert MapSet.size(derived) == 100_000
  end

  # ---------------------------------------------------------------------------
  # Property — StreamData
  # ---------------------------------------------------------------------------

  property "any v6 /64 derives inside the prefix, interface-id-stable and idempotent" do
    group = StreamData.integer(0..0xFFFF)

    check all(
            net <- StreamData.list_of(group, length: 4),
            iface_a <- StreamData.list_of(group, length: 4),
            iface_b <- StreamData.list_of(group, length: 4)
          ) do
      tuple_a = List.to_tuple(net ++ iface_a)
      tuple_b = List.to_tuple(net ++ iface_b)

      {:ok, ip_a} = SourceMapping.derive(SourceMapping.client_key(tuple_a), @prefix)
      {:ok, ip_a2} = SourceMapping.derive(SourceMapping.client_key(tuple_a), @prefix)
      {:ok, ip_b} = SourceMapping.derive(SourceMapping.client_key(tuple_b), @prefix)

      assert SourceMapping.in_prefix?(ip_a, @prefix)
      assert ip_a == ip_a2, "derive must be idempotent"
      assert ip_a == ip_b, "different interface id on the same /64 must derive the same address"
    end
  end

  property "any prefix length 0..128 derives a valid in-prefix address (no /8-alignment)" do
    group = StreamData.integer(0..0xFFFF)

    check all(
            net_groups <- StreamData.list_of(group, length: 8),
            key_tuple <- StreamData.list_of(group, length: 8),
            len <- StreamData.integer(0..128)
          ) do
      # Random, deliberately non-/8-aligned lengths (/70, /83, /50, /0 …):
      # the whole module rests on derive/2 not MatchError-ing on a
      # non-byte host_bits and still landing strictly inside the prefix.
      prefix = (net_groups |> List.to_tuple() |> :inet.ntoa() |> to_string()) <> "/#{len}"
      key = SourceMapping.client_key(List.to_tuple(key_tuple))

      assert {:ok, ip} = SourceMapping.derive(key, prefix)
      assert SourceMapping.in_prefix?(ip, prefix)
    end
  end

  property "any v4 /32 derives inside the prefix, deterministically" do
    octet = StreamData.integer(0..255)

    check all(v4 <- StreamData.list_of(octet, length: 4)) do
      key = SourceMapping.client_key(List.to_tuple(v4))
      {:ok, ip} = SourceMapping.derive(key, @prefix)
      {:ok, ip2} = SourceMapping.derive(key, @prefix)

      assert SourceMapping.in_prefix?(ip, @prefix)
      assert ip == ip2
      assert String.starts_with?(ip, "2a03:4000:20:2d3:cb:")
    end
  end
end
