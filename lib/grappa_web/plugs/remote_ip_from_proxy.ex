defmodule GrappaWeb.Plugs.RemoteIpFromProxy do
  @moduledoc """
  Conditionally rewrite `conn.remote_ip` from the X-Forwarded-For /
  X-Real-IP chain, BYPASSING the rewrite when the TCP peer is
  loopback.

  Wraps the `RemoteIp` hex package. Same option shape: `headers:` +
  `proxies:` + `clients:` etc. are forwarded verbatim.

  ## Why the loopback bypass

  The `RemoteIp` plug never inspects `conn.remote_ip` (the TCP
  peer) — it operates purely on the request headers and the
  `:clients` / `:proxies` / reserved-range lists, walking the chain
  right-to-left. That's correct for a normal proxy-fronted
  deployment, but it leaves a SECURITY HOLE for the loopback path:

      $ docker exec grappa curl -H "X-Forwarded-For: 1.2.3.4" \\
          http://localhost:4000/admin/reload

  Without intervention, `RemoteIp` walks the X-F-F chain and finds
  `{1, 2, 3, 4}` (non-reserved → terminal client) and rewrites
  `conn.remote_ip` to it. The downstream `Plugs.LoopbackOnly` plug
  (which gates `/admin/reload` + `/admin/cic-bundle-changed`) sees
  `{1, 2, 3, 4}`, returns 403 — by coincidence the spoof FAILS
  the gate (because the spoofed IP isn't loopback either), but a
  spoofed `X-Forwarded-For: 127.0.0.1` from the same shell context
  WOULD bypass the gate. The principled fix is to recognize that
  loopback peers are operator/container-shell access; they NEVER
  legitimately carry forwarded headers, so the headers are always
  spoof attempts.

  ## How it works

  Inspect `conn.remote_ip` (the TCP peer). If it's `{127, 0, 0, 1}`
  or `{0, 0, 0, 0, 0, 0, 0, 1}` (the only two loopback shapes that
  reach Phoenix — Bandit normalizes everything else), skip the
  wrapped `RemoteIp.call/2` entirely. Otherwise delegate.

  The IPv6 loopback `::1` is matched as the bare 8-tuple; the
  IPv4-mapped IPv6 form (`::ffff:127.0.0.1`) is NOT loopback per
  RFC 4291 — it's an IPv4 address in IPv6 transport, and Bandit
  surfaces it as the 8-tuple `{0, 0, 0, 0, 0, 0xffff, hi, lo}`,
  which doesn't match the loopback pattern. That's the right
  behavior: if a client legitimately reaches Phoenix via the
  v4-mapped form, the peer is still a real client and X-F-F (if
  any) should be honored as the proxy-traversal record.

  ## Loopback peer with no headers

  Sanity case: a loopback peer that didn't send X-F-F passes through
  with `conn.remote_ip` already set to the loopback tuple. No
  behavior change from the wrapped plug (which would be a no-op
  anyway).
  """
  @behaviour Plug

  @impl Plug
  def init(opts), do: RemoteIp.init(opts)

  @impl Plug
  def call(%Plug.Conn{remote_ip: {127, _, _, _}} = conn, _), do: conn
  def call(%Plug.Conn{remote_ip: {0, 0, 0, 0, 0, 0, 0, 1}} = conn, _), do: conn
  def call(%Plug.Conn{} = conn, opts), do: RemoteIp.call(conn, opts)
end
