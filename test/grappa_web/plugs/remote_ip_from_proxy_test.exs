defmodule GrappaWeb.Plugs.RemoteIpFromProxyTest do
  @moduledoc """
  `RemoteIpFromProxy` — endpoint-level wrapper plug that delegates
  to the `RemoteIp` hex package, with a loopback-peer rule:

      | peer        | XFF present | trust  | conn.remote_ip after  |
      |-------------|-------------|--------|-----------------------|
      | loopback    | no          | peer   | loopback (untouched)  |
      | loopback    | yes         | XFF    | rewritten from chain  |
      | non-loopback| any         | RemoteIp default (chain walk if XFF set, peer otherwise) |

  The loopback+XFF row is the bastille-jail (and Docker) shape:
  nginx runs on the same host and proxies via loopback. Tests pin
  the matrix so a config-shape drift fails here before it ships.
  """
  use ExUnit.Case, async: true

  alias GrappaWeb.Plugs.RemoteIpFromProxy

  @plug_opts [headers: ~w[x-forwarded-for x-real-ip]]

  defp call(peer_ip, headers) when is_tuple(peer_ip) and is_list(headers) do
    conn = %Plug.Conn{remote_ip: peer_ip, req_headers: headers}
    opts = RemoteIpFromProxy.init(@plug_opts)
    RemoteIpFromProxy.call(conn, opts)
  end

  describe "non-loopback peer (docker bridge, public client, etc)" do
    test "rewrites conn.remote_ip to the X-Forwarded-For client" do
      conn = call({172, 17, 0, 2}, [{"x-forwarded-for", "203.0.113.42"}])
      assert conn.remote_ip == {203, 0, 113, 42}
    end

    test "honors X-Real-IP as a fallback shape" do
      conn = call({172, 17, 0, 2}, [{"x-real-ip", "198.51.100.7"}])
      assert conn.remote_ip == {198, 51, 100, 7}
    end

    test "right-to-left walk skips reserved-range proxy chain" do
      # Real client = 203.0.113.42, then through a corporate proxy at
      # 10.0.0.5 (RFC1918 — reserved-proxy), then through nginx at
      # 172.17.0.2 (peer, also reserved). Walk surfaces the leftmost
      # non-reserved IP.
      conn =
        call(
          {172, 17, 0, 2},
          [{"x-forwarded-for", "203.0.113.42, 10.0.0.5"}]
        )

      assert conn.remote_ip == {203, 0, 113, 42}
    end

    test "spoofed X-F-F from non-reserved client surfaces the spoofer's real public IP" do
      # Attacker on 198.51.100.99 injects `X-Forwarded-For: 1.2.3.4` to
      # nginx; nginx APPENDS the attacker's real IP, so the chain
      # becomes "1.2.3.4, 198.51.100.99". The walk treats 198.51.100.99
      # (public, non-reserved) as a client and STOPS — the injected
      # 1.2.3.4 sits left and is never reached.
      conn =
        call(
          {172, 17, 0, 2},
          [{"x-forwarded-for", "1.2.3.4, 198.51.100.99"}]
        )

      assert conn.remote_ip == {198, 51, 100, 99}
    end
  end

  describe "loopback peer WITHOUT proxy headers (operator shell / direct curl)" do
    test "v4 loopback peer with no headers passes through unchanged" do
      conn = call({127, 0, 0, 1}, [])
      assert conn.remote_ip == {127, 0, 0, 1}
    end

    test "v6 loopback peer with no headers passes through unchanged" do
      conn = call({0, 0, 0, 0, 0, 0, 0, 1}, [])
      assert conn.remote_ip == {0, 0, 0, 0, 0, 0, 0, 1}
    end

    test "any 127/8 peer with no headers stays loopback" do
      conn = call({127, 5, 5, 5}, [])
      assert conn.remote_ip == {127, 5, 5, 5}
    end
  end

  describe "loopback peer WITH proxy headers (local nginx reverse-proxying)" do
    test "v4 loopback peer with X-F-F is rewritten to the real client IP" do
      # bastille jail + docker prod both have nginx on the same host as
      # grappa, proxying via 127.0.0.1:4000. Without this row, every
      # legitimate user session would persist `ip = "127.0.0.1"` (the
      # cp52 S2 incident — user sessions across all of post-bastille
      # showed loopback in the audit trail).
      conn = call({127, 0, 0, 1}, [{"x-forwarded-for", "203.0.113.42"}])
      assert conn.remote_ip == {203, 0, 113, 42}
    end

    test "v4 loopback peer with X-Real-IP is rewritten too" do
      conn = call({127, 0, 0, 1}, [{"x-real-ip", "198.51.100.7"}])
      assert conn.remote_ip == {198, 51, 100, 7}
    end

    test "v6 loopback peer with X-F-F is rewritten" do
      conn = call({0, 0, 0, 0, 0, 0, 0, 1}, [{"x-forwarded-for", "203.0.113.42"}])
      assert conn.remote_ip == {203, 0, 113, 42}
    end

    test "loopback peer with X-F-F chain walks like a normal proxy" do
      conn =
        call(
          {127, 0, 0, 1},
          [{"x-forwarded-for", "203.0.113.42, 10.0.0.5"}]
        )

      assert conn.remote_ip == {203, 0, 113, 42}
    end
  end

  describe "no proxy headers, non-loopback peer" do
    test "peer IP passes through unchanged" do
      conn = call({203, 0, 113, 42}, [])
      assert conn.remote_ip == {203, 0, 113, 42}
    end
  end

  describe "config wiring (drift detection)" do
    test "Endpoint installs RemoteIpFromProxy with the configured headers" do
      # If a future refactor swaps the wrapper for bare RemoteIp, the
      # runtime config diff is silent — the spoof vulnerability returns
      # with no test failure. This test pins the exact options shape so
      # the config drift surfaces as a test failure before deploy.
      endpoint_source = File.read!("lib/grappa_web/endpoint.ex")

      assert endpoint_source =~ "plug GrappaWeb.Plugs.RemoteIpFromProxy"
      assert endpoint_source =~ ~s|headers: ~w[x-forwarded-for x-real-ip]|
    end
  end
end
