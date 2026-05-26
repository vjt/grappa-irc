defmodule GrappaWeb.Plugs.LoopbackOnly do
  @moduledoc """
  Halts any request whose `remote_ip` isn't `127.0.0.1` (or `::1`) with
  a uniform 403 JSON body.

  Used to gate the admin reload endpoint (`POST /admin/reload`) so it's
  only callable from inside the running container — `docker exec grappa
  curl -X POST http://localhost:4000/admin/reload`. nginx (the only
  LAN-facing service) doesn't proxy `/admin/*`, and grappa's compose
  service publishes on `127.0.0.1:4000` by default + sits on the
  `grappa_internal` bridge only — so the loopback gate is the third
  layer of defense after compose port-publish defaults and nginx's
  proxy allowlist.

  Why a plug instead of an env-var bearer: stateless, no rotation
  ceremony, and matches the operator workflow (the reload trigger IS
  always going to be `docker exec grappa curl ...`). When Phase 5
  hardening adds an admin auth surface (Phoenix.LiveDashboard with
  basic-auth or session-cookie), this plug stays as the inner gate;
  the auth layer is the outer one.

  ## Interaction with `RemoteIp` plug

  `GrappaWeb.Endpoint`'s `RemoteIp` plug rewrites `conn.remote_ip`
  from the `X-Forwarded-For` chain BEFORE this plug fires. The
  endpoint configures `clients: ["127.0.0.0/8", "::1/128"]` so
  loopback peers are treated as terminal clients — X-F-F headers
  arriving from loopback are IGNORED, keeping this gate honest.
  Without that `clients:` override, an attacker with container
  shell could spoof `curl -H "X-Forwarded-For: 1.2.3.4"
  http://localhost:4000/admin/reload` and `conn.remote_ip` would
  become `{1, 2, 3, 4}`, bypassing the gate. See `endpoint.ex` for
  the security-critical config.
  """
  @behaviour Plug

  import Plug.Conn

  @loopback_v4 {127, 0, 0, 1}
  @loopback_v6 {0, 0, 0, 0, 0, 0, 0, 1}

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _) do
    case conn.remote_ip do
      @loopback_v4 -> conn
      @loopback_v6 -> conn
      _ -> conn |> send_resp(403, ~s({"error":"loopback_only"})) |> halt()
    end
  end
end
