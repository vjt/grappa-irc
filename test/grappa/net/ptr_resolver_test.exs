defmodule Grappa.Net.PtrResolverTest do
  @moduledoc """
  #252 — reverse-DNS name construction for the vhost PTR resolver. The
  `reverse_dns_name/1` transform (IP tuple → in-addr.arpa / ip6.arpa) is
  the PURE, network-free half of the resolver and the only part that's
  unit-tested here; `resolve/1` itself is thin `:inet_res` glue exercised
  only through the injected-resolver seam in `Grappa.Net.PtrCache` tests
  (CLAUDE.md — NEVER hit real DNS in the suite).
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.Net.PtrResolver

  describe "reverse_dns_name/1 — IPv4" do
    test "reverses the octets and appends in-addr.arpa" do
      assert PtrResolver.reverse_dns_name({192, 0, 2, 1}) == "1.2.0.192.in-addr.arpa"
    end

    test "handles the all-zero and max-octet edges" do
      assert PtrResolver.reverse_dns_name({0, 0, 0, 0}) == "0.0.0.0.in-addr.arpa"
      assert PtrResolver.reverse_dns_name({255, 255, 255, 255}) == "255.255.255.255.in-addr.arpa"
    end
  end

  describe "reverse_dns_name/1 — IPv6" do
    # Expectations are built with String.duplicate so the (error-prone) run
    # of zero-nibbles is counted mechanically, not by hand.
    test "::1 → single 1 nibble then 31 zeros + ip6.arpa" do
      assert PtrResolver.reverse_dns_name({0, 0, 0, 0, 0, 0, 0, 1}) ==
               "1." <> String.duplicate("0.", 31) <> "ip6.arpa"
    end

    test "2001:db8:: → 24 zero nibbles then the reversed prefix nibbles + ip6.arpa" do
      assert PtrResolver.reverse_dns_name({0x2001, 0x0DB8, 0, 0, 0, 0, 0, 0}) ==
               String.duplicate("0.", 24) <> "8.b.d.0.1.0.0.2.ip6.arpa"
    end
  end

  # A v6 reverse name is ALWAYS 32 single-hex-char labels followed by
  # `ip6.arpa` — 34 dot-separated labels total. A malformed nibble count
  # would silently query the wrong name and return no PTR, so pin it.
  property "every v6 tuple yields 32 single-nibble labels + ip6.arpa" do
    check all(group <- StreamData.list_of(StreamData.integer(0..0xFFFF), length: 8)) do
      tuple = List.to_tuple(group)
      name = PtrResolver.reverse_dns_name(tuple)
      labels = String.split(name, ".")

      assert List.last(labels, nil) == "arpa"
      assert Enum.at(labels, -2) == "ip6"
      nibbles = Enum.take(labels, 32)
      assert length(labels) == 34
      assert Enum.all?(nibbles, &(String.length(&1) == 1 and String.match?(&1, ~r/^[0-9a-f]$/)))
    end
  end
end
