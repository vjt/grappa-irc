defmodule Grappa.Net.SsrfTest do
  use ExUnit.Case, async: true

  alias Grappa.Net.Ssrf

  describe "safe_public_ip?/1 — IPv4" do
    test "blocks private / loopback / link-local / metadata / reserved ranges" do
      blocked = [
        {0, 0, 0, 0},
        {10, 0, 0, 1},
        {100, 64, 0, 1},
        {127, 0, 0, 1},
        {169, 254, 0, 1},
        {169, 254, 169, 254},
        {172, 16, 0, 1},
        {172, 31, 255, 255},
        {192, 0, 0, 1},
        {192, 168, 1, 1},
        {198, 18, 0, 1},
        {224, 0, 0, 1},
        {240, 0, 0, 1},
        {255, 255, 255, 255}
      ]

      for ip <- blocked, do: refute(Ssrf.safe_public_ip?(ip), "expected #{inspect(ip)} blocked")
    end

    test "allows normal public v4 addresses" do
      allowed = [{1, 1, 1, 1}, {8, 8, 8, 8}, {93, 184, 216, 34}, {172, 15, 0, 1}, {172, 32, 0, 1}]
      for ip <- allowed, do: assert(Ssrf.safe_public_ip?(ip), "expected #{inspect(ip)} allowed")
    end
  end

  describe "safe_public_ip?/1 — IPv6" do
    test "blocks unspecified / loopback / ULA / link-local / multicast / doc" do
      blocked = [
        {0, 0, 0, 0, 0, 0, 0, 0},
        {0, 0, 0, 0, 0, 0, 0, 1},
        {0xFC00, 0, 0, 0, 0, 0, 0, 1},
        {0xFD12, 0, 0, 0, 0, 0, 0, 1},
        {0xFE80, 0, 0, 0, 0, 0, 0, 1},
        {0xFF02, 0, 0, 0, 0, 0, 0, 1},
        {0x2001, 0x0DB8, 0, 0, 0, 0, 0, 1}
      ]

      for ip <- blocked, do: refute(Ssrf.safe_public_ip?(ip), "expected #{inspect(ip)} blocked")
    end

    test "allows a normal public v6 address" do
      assert Ssrf.safe_public_ip?({0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111})
    end

    test "blocks a v4-mapped address pointing at loopback (::ffff:127.0.0.1)" do
      # ::ffff:127.0.0.1 = {0,0,0,0,0,0xffff, 0x7f00, 0x0001}
      refute Ssrf.safe_public_ip?({0, 0, 0, 0, 0, 0xFFFF, 0x7F00, 0x0001})
    end

    test "allows a v4-mapped address pointing at a public v4 (::ffff:1.1.1.1)" do
      assert Ssrf.safe_public_ip?({0, 0, 0, 0, 0, 0xFFFF, 0x0101, 0x0101})
    end

    test "blocks a NAT64 address embedding a private v4 (64:ff9b::10.0.0.1)" do
      refute Ssrf.safe_public_ip?({0x0064, 0xFF9B, 0, 0, 0, 0, 0x0A00, 0x0001})
    end
  end

  describe "resolve_safe/1" do
    test "an IP-literal host is checked directly" do
      assert {:ok, {1, 1, 1, 1}} = Ssrf.resolve_safe("1.1.1.1")
      assert {:error, :ssrf_blocked} = Ssrf.resolve_safe("127.0.0.1")
      assert {:error, :ssrf_blocked} = Ssrf.resolve_safe("10.0.0.1")
    end

    test "localhost resolves to loopback and is blocked" do
      assert {:error, :ssrf_blocked} = Ssrf.resolve_safe("localhost")
    end

    test "a loose/octal literal does not slip through as a parsed IP" do
      # Not a strict literal → treated as a hostname → fails to resolve → dns_error
      # (never parsed loosely into 127.0.0.1).
      assert {:error, reason} = Ssrf.resolve_safe("017700000001")
      assert reason in [:dns_error, :ssrf_blocked]
    end
  end
end
