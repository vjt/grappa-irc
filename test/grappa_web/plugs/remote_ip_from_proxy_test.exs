defmodule GrappaWeb.Plugs.RemoteIpFromProxyTest do
  @moduledoc """
  `RemoteIpFromProxy` — endpoint-level wrapper plug that delegates
  to the `RemoteIp` hex package EXCEPT when the TCP peer is loopback
  (`127.0.0.0/8` or `::1`). Loopback peers are operator/container-
  shell access; X-F-F headers from that surface are always spoof
  attempts and MUST be ignored to keep `Plugs.LoopbackOnly` honest.

  Tests instantiate the wrapper with the SAME options the Endpoint
  installs so a config-shape drift (someone deletes the wrapper, or
  swaps the plug back to bare `RemoteIp`) fails here before it ships
  to prod.
  """
  use ExUnit.Case, async: true

  alias GrappaWeb.Plugs.RemoteIpFromProxy

  @plug_opts [headers: ~w[x-forwarded-for x-real-ip]]

  defp call(peer_ip, headers) when is_tuple(peer_ip) and is_list(headers) do
    conn = %Plug.Conn{remote_ip: peer_ip, req_headers: headers}
    opts = RemoteIpFromProxy.init(@plug_opts)
    RemoteIpFromProxy.call(conn, opts)
  end

  describe "nginx-shaped request (peer = docker bridge, real client behind X-F-F)" do
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

  describe "loopback peer (container-shell context — LoopbackOnly defense)" do
    test "leaves remote_ip as loopback when peer is 127.0.0.1, even with X-F-F set" do
      # SECURITY CRITICAL: `docker exec grappa curl -H "X-Forwarded-For:
      # 1.2.3.4" http://localhost:4000/admin/reload`. Without the
      # wrapper's loopback bypass, bare RemoteIp would rewrite
      # conn.remote_ip to {1,2,3,4} (or worse, {127,0,0,1} on a
      # `X-Forwarded-For: 127.0.0.1` spoof) and bypass
      # Plugs.LoopbackOnly.
      conn = call({127, 0, 0, 1}, [{"x-forwarded-for", "1.2.3.4"}])
      assert conn.remote_ip == {127, 0, 0, 1}
    end

    test "leaves remote_ip as 127.0.0.1 when X-F-F spoofs another loopback IP" do
      # Tighter: a loopback peer spoofing X-Forwarded-For: 127.0.0.1
      # would, under bare RemoteIp + permissive client allowlist, pass
      # the LoopbackOnly gate. The wrapper bypass prevents the rewrite
      # so the gate sees the genuine loopback peer (which IS allowed),
      # but no rewrite happened — the audit log line tied to the
      # request would still show 127.0.0.1 as the true source.
      conn = call({127, 0, 0, 1}, [{"x-forwarded-for", "127.0.0.1"}])
      assert conn.remote_ip == {127, 0, 0, 1}
    end

    test "any 127/8 peer (not just 127.0.0.1) bypasses the rewrite" do
      conn = call({127, 5, 5, 5}, [{"x-forwarded-for", "1.2.3.4"}])
      assert conn.remote_ip == {127, 5, 5, 5}
    end

    test "leaves remote_ip as ::1 when peer is IPv6 loopback, even with X-F-F set" do
      conn = call({0, 0, 0, 0, 0, 0, 0, 1}, [{"x-forwarded-for", "1.2.3.4"}])
      assert conn.remote_ip == {0, 0, 0, 0, 0, 0, 0, 1}
    end

    test "loopback peer with X-Real-IP set is also ignored" do
      conn = call({127, 0, 0, 1}, [{"x-real-ip", "1.2.3.4"}])
      assert conn.remote_ip == {127, 0, 0, 1}
    end

    test "loopback peer WITHOUT proxy headers stays loopback (sanity)" do
      conn = call({127, 0, 0, 1}, [])
      assert conn.remote_ip == {127, 0, 0, 1}
    end
  end

  describe "no proxy headers" do
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
