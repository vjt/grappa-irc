defmodule GrappaWeb.RemoteIPTest do
  @moduledoc """
  L-web-2: `format/1` formats `Plug.Conn.remote_ip` (or a raw
  `:inet.ip_address()` tuple) into a wire-shape string. IPv4-mapped
  IPv6 addresses (e.g. `::ffff:127.0.0.1`, the form Bandit/Cowboy
  surface when a v4 client hits a dual-stack listener) get unwrapped
  to dotted-quad — so persisted session-row IPs and
  upstream-captcha-verify `remoteip` values stay in canonical
  client-shape regardless of socket-side dual-stack quirks.
  """
  use ExUnit.Case, async: true

  alias GrappaWeb.RemoteIP

  describe "format/1" do
    test "nil → nil" do
      assert RemoteIP.format(nil) == nil
    end

    test "IPv4 tuple → dotted-quad" do
      assert RemoteIP.format({127, 0, 0, 1}) == "127.0.0.1"
      assert RemoteIP.format({192, 168, 1, 1}) == "192.168.1.1"
    end

    test "IPv6 (real) → colon form" do
      assert RemoteIP.format({0x2001, 0xDB8, 0, 0, 0, 0, 0, 1}) == "2001:db8::1"
    end

    test "IPv4-mapped IPv6 ::ffff:127.0.0.1 → 127.0.0.1 (L-web-2)" do
      # 0xffff in the 6th word, then 32 bits of the v4 address split
      # across the last two words (high byte / low byte each).
      ipv4_mapped = {0, 0, 0, 0, 0, 0xFFFF, 0x7F00, 0x0001}
      assert RemoteIP.format(ipv4_mapped) == "127.0.0.1"
    end

    test "IPv4-mapped IPv6 ::ffff:192.168.1.1 → 192.168.1.1 (L-web-2)" do
      ipv4_mapped = {0, 0, 0, 0, 0, 0xFFFF, 0xC0A8, 0x0101}
      assert RemoteIP.format(ipv4_mapped) == "192.168.1.1"
    end

    test "IPv4-mapped IPv6 with all-zero v4 still unwraps" do
      assert RemoteIP.format({0, 0, 0, 0, 0, 0xFFFF, 0, 0}) == "0.0.0.0"
    end

    test "IPv6 starting with zeros but NOT mapped is left alone" do
      # ::1 (IPv6 loopback) is not a v4-mapped address.
      assert RemoteIP.format({0, 0, 0, 0, 0, 0, 0, 1}) == "::1"
    end
  end
end
