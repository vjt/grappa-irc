defmodule Grappa.Net.SsrfTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

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

    test "blocks the reserved ::/8 block, discard-only, site-local and the local-use NAT64 prefix (#2401)" do
      blocked = [
        # IPv4-compatible ::127.0.0.1 — deprecated, under ::/8
        {0, 0, 0, 0, 0, 0, 0x7F00, 0x0001},
        # 64:ff9b:1::/48 (RFC 8215 local-use translation), under ::/8
        {0x0064, 0xFF9B, 0x0001, 0, 0, 0, 0x0A00, 0x0001},
        # 100::/64 discard-only
        {0x0100, 0, 0, 0, 0, 0, 0, 1},
        # fec0::/10 site-local (deprecated, still routable inside a site)
        {0xFEC0, 0, 0, 0, 0, 0, 0, 1}
      ]

      for ip <- blocked, do: refute(Ssrf.safe_public_ip?(ip), "expected #{inspect(ip)} blocked")
    end

    test "the decoded v4-mapped and NAT64 /96 forms still pass when their v4 is public" do
      assert Ssrf.safe_public_ip?({0, 0, 0, 0, 0, 0xFFFF, 0x0101, 0x0101})
      assert Ssrf.safe_public_ip?({0x0064, 0xFF9B, 0, 0, 0, 0, 0x0101, 0x0101})
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

  describe "blocked_literal_host?/1 (#2401)" do
    test "an unsafe strict IP literal is blocked, v6 and v4-mapped included" do
      for host <- ["127.0.0.1", "10.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "::ffff:127.0.0.1"] do
        assert Ssrf.blocked_literal_host?(host), "expected #{host} blocked"
      end
    end

    test "localhost and any name under .localhost are blocked without a lookup" do
      for host <- ["localhost", "LOCALHOST", "push.localhost", "a.b.localhost."] do
        assert Ssrf.blocked_literal_host?(host), "expected #{host} blocked"
      end
    end

    test "a public literal and an ordinary hostname are not blocked here" do
      for host <- ["1.1.1.1", "2606:4700:4700::1111", "fcm.googleapis.com", "notlocalhost.example"] do
        refute Ssrf.blocked_literal_host?(host), "expected #{host} allowed"
      end
    end

    test "a loose literal is a hostname, not a decoded address" do
      # Never decoded into 127.0.0.1 — the send-time resolve is what refuses it.
      refute Ssrf.blocked_literal_host?("017700000001")
    end

    property "every strict v4 literal is blocked exactly when safe_public_ip?/1 refuses it" do
      check all(a <- integer(0..255), b <- integer(0..255), c <- integer(0..255), d <- integer(0..255)) do
        ip = {a, b, c, d}
        host = ip |> :inet.ntoa() |> List.to_string()
        assert Ssrf.blocked_literal_host?(host) == not Ssrf.safe_public_ip?(ip)
      end
    end
  end

  describe "pinned_url/2 (#2401)" do
    test "swaps the host for the resolved v4 address and keeps scheme, port, path and query" do
      uri = URI.parse("https://push.example:8443/wp/abc?x=1")
      assert Ssrf.pinned_url(uri, {93, 184, 216, 34}) == "https://93.184.216.34:8443/wp/abc?x=1"
    end

    test "brackets a v6 address in the authority" do
      uri = URI.parse("https://push.example/wp")
      assert Ssrf.pinned_url(uri, {0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111}) == "https://[2606:4700::1111]/wp"
    end
  end
end
