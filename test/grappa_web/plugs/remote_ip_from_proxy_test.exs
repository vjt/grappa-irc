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

  The plug also stamps `direct_loopback_peer?/1` — row 1 as a boolean,
  the authorization-grade signal `Plugs.LoopbackOnly` gates on. It is
  deliberately NOT the resolved `conn.remote_ip`: that value is an
  attribution and can be loopback for reasons carrying no privilege.
  Its own describe block pins the predicate, the fail-closed default,
  and the named residual.
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

  # #543 Part C — the trust decision is factored into ONE public SSOT
  # (`trusted_client_ip/2,3`) so the WS `connect/3` (which gets
  # `peer_data`/`x_headers` from `connect_info`, NOT a `Plug.Conn`) resolves
  # the trusted client IP through the SAME code the HTTP plug uses. These
  # tests pin the matrix on the socket-facing zero-config entry so a fork
  # (a reimplemented / inverted trust decision) fails here before it ships.
  describe "trusted_client_ip/2 (shared SSOT — the WS connect/3 entry)" do
    test "loopback peer + no forwarded header → the peer (operator shell / direct)" do
      assert RemoteIpFromProxy.trusted_client_ip({127, 0, 0, 1}, []) == {127, 0, 0, 1}

      assert RemoteIpFromProxy.trusted_client_ip({0, 0, 0, 0, 0, 0, 0, 1}, []) ==
               {0, 0, 0, 0, 0, 0, 0, 1}
    end

    test "loopback peer + X-Forwarded-For → the real client (local nginx shape)" do
      assert RemoteIpFromProxy.trusted_client_ip(
               {127, 0, 0, 1},
               [{"x-forwarded-for", "203.0.113.42"}]
             ) == {203, 0, 113, 42}
    end

    test "loopback peer + X-Real-IP → the real client" do
      assert RemoteIpFromProxy.trusted_client_ip(
               {127, 0, 0, 1},
               [{"x-real-ip", "198.51.100.7"}]
             ) == {198, 51, 100, 7}
    end

    test "loopback peer + IPv6 X-Forwarded-For resolves the v6 client" do
      assert RemoteIpFromProxy.trusted_client_ip(
               {0, 0, 0, 0, 0, 0, 0, 1},
               [{"x-forwarded-for", "2001:db8:1:2:3:4:5:6"}]
             ) == {0x2001, 0xDB8, 1, 2, 3, 4, 5, 6}
    end

    test "non-loopback peer + no forwarded header → the peer" do
      assert RemoteIpFromProxy.trusted_client_ip({203, 0, 113, 42}, []) == {203, 0, 113, 42}
    end

    # THREAT: an attacker injects a forged LEFTMOST XFF; the trusted proxy
    # (local nginx) APPENDS the real client to the RIGHT, so the chain reads
    # "1.2.3.4, <real-client>". The right-to-left walk stops at the first
    # non-reserved IP (the appended real client) — the injected 1.2.3.4
    # sits to its LEFT and is NEVER reached. Proves a forged header cannot
    # override the proxy-appended real client, now through the socket SSOT.
    test "forged leftmost XFF cannot override the proxy-appended real client" do
      assert RemoteIpFromProxy.trusted_client_ip(
               {127, 0, 0, 1},
               [{"x-forwarded-for", "1.2.3.4, 198.51.100.99"}]
             ) == {198, 51, 100, 99}
    end

    # THREAT: a forged XFF carrying only a RESERVED (RFC1918) address can't
    # override the real peer — the reserved entry is treated as a proxy and
    # skipped, the header yields no client, resolution falls back to the peer.
    test "forged reserved-only XFF falls back to the peer (non-loopback)" do
      assert RemoteIpFromProxy.trusted_client_ip(
               {203, 0, 113, 7},
               [{"x-forwarded-for", "10.0.0.5"}]
             ) == {203, 0, 113, 7}
    end
  end

  # A caller whose own source address is in a reserved range, fronted by a
  # same-host reverse proxy, arrives with a forwarded chain in which every
  # entry is reserved. The resolver finds no client in such a chain and
  # answers with the transport peer — which in that topology is loopback.
  #
  # No header is forged; the proxy builds the chain itself. The gate must
  # deny anyway, and it does, because it reads the transport predicate and
  # not the resolved value. This pins the GATE, which is the whole point of
  # separating the two.
  #
  # The sibling property — that the RESOLVED value should not collapse onto
  # the peer either — is an attribution concern, still open, and is NOT
  # pinned here: it has no fix in this tree, and a permanently-red test
  # buys nothing. See the `trusted_client_ip/3` moduledoc.
  describe "reserved-only forwarded chain behind a loopback proxy" do
    test "the loopback gate rejects a private-range caller fronted by a loopback proxy" do
      conn =
        :post
        |> Plug.Test.conn("/admin/cic-bundle-changed")
        |> Map.put(:remote_ip, {127, 0, 0, 1})
        |> Plug.Conn.put_req_header("x-forwarded-for", "10.66.6.6")
        |> RemoteIpFromProxy.call(RemoteIpFromProxy.init(@plug_opts))
        |> GrappaWeb.Plugs.LoopbackOnly.call([])

      assert conn.halted, "LoopbackOnly admitted a caller whose real source is 10.66.6.6"
      assert conn.status == 403
    end
  end

  # The authorization-grade signal `Plugs.LoopbackOnly` gates on. Distinct
  # from the resolved `conn.remote_ip`, which is an attribution: it can be
  # loopback for reasons that carry no operator privilege. This predicate is
  # a property of the TRANSPORT, so no header can produce it.
  describe "direct_loopback_peer? — the gate signal" do
    test "fails closed on a conn the plug never touched" do
      refute RemoteIpFromProxy.direct_loopback_peer?(%Plug.Conn{remote_ip: {127, 0, 0, 1}})
    end

    test "true for a loopback peer with no forwarded header (the operator shell)" do
      assert RemoteIpFromProxy.direct_loopback_peer?(call({127, 0, 0, 1}, []))
      assert RemoteIpFromProxy.direct_loopback_peer?(call({0, 0, 0, 0, 0, 0, 0, 1}, []))
    end

    test "false for a loopback peer carrying any allowlisted forwarded header" do
      refute RemoteIpFromProxy.direct_loopback_peer?(call({127, 0, 0, 1}, [{"x-forwarded-for", "10.66.6.6"}]))

      refute RemoteIpFromProxy.direct_loopback_peer?(call({127, 0, 0, 1}, [{"x-real-ip", "10.66.6.6"}]))
    end

    test "false for a non-loopback peer" do
      refute RemoteIpFromProxy.direct_loopback_peer?(call({10, 66, 6, 6}, []))
      refute RemoteIpFromProxy.direct_loopback_peer?(call({203, 0, 113, 42}, []))
    end

    # RESIDUAL, pinned so it is not mistaken for a closed hole: the
    # predicate's tightness rests on the fronting proxy setting a forwarded
    # header. Every proxy config this project ships sets both headers
    # unconditionally, but an operator's own proxy that sets NEITHER while
    # proxying over loopback is indistinguishable from the operator shell.
    # This is unchanged from the prior behaviour rather than introduced by
    # the gate change — it is a reason to keep the port off untrusted
    # networks, not a reason to widen the gate.
    test "a header-less loopback-fronting proxy is indistinguishable from the shell" do
      assert RemoteIpFromProxy.direct_loopback_peer?(call({127, 0, 0, 1}, []))
    end

    # A header OUTSIDE the allowlist must not disqualify: the gate and the
    # resolver read the SAME allowlist, so a random `forwarded:` header
    # can't lock the operator out of their own reload endpoint.
    test "a header outside the allowlist does not disqualify" do
      assert RemoteIpFromProxy.direct_loopback_peer?(call({127, 0, 0, 1}, [{"forwarded", "for=10.66.6.6"}]))
    end
  end

  # #543 Part C — the plug `call/2` MUST delegate to the same SSOT the socket
  # uses (no forked / duplicated trust matrix). If a refactor forks them, this
  # equality fails.
  describe "call/2 delegates to the shared SSOT (no forked matrix)" do
    test "plug call/2 and trusted_client_ip/2 agree on the loopback+XFF-chain shape" do
      peer = {127, 0, 0, 1}
      headers = [{"x-forwarded-for", "203.0.113.42, 10.0.0.5"}]

      conn = call(peer, headers)

      assert conn.remote_ip == RemoteIpFromProxy.trusted_client_ip(peer, headers)
    end

    # The `:remote_ip` Logger metadata (config allowlists it — the HTTP log
    # line carries the post-rewrite client IP) was set by `RemoteIp.call` as
    # a side-effect. The SSOT resolution uses `RemoteIp.from`, which does NOT
    # set metadata, so `call/2` re-sets it explicitly — this drift guard pins
    # that the side-effect survived the factoring.
    test "call/2 preserves the :remote_ip Logger metadata side-effect" do
      Logger.metadata(remote_ip: nil)
      _ = call({127, 0, 0, 1}, [{"x-forwarded-for", "203.0.113.42"}])
      assert Logger.metadata()[:remote_ip] == "203.0.113.42"
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
