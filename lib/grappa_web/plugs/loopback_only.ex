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

  ## Interaction with `RemoteIpFromProxy`

  `GrappaWeb.Endpoint`'s `RemoteIpFromProxy` plug runs FIRST and may
  rewrite `conn.remote_ip` from `X-Forwarded-For` when the peer is
  loopback AND XFF is present (the local-nginx-as-reverse-proxy
  shape — bastille jail + docker prod). That means a loopback peer
  who sets `X-Forwarded-For: 127.0.0.1` will reach this plug with
  `conn.remote_ip = {127, 0, 0, 1}` and pass the gate. This is
  **explicitly accepted**: anyone with shell access on the host
  (`sudo bastille cmd grappa`, `docker exec grappa`) already has
  root-equivalent access — they can kill the BEAM, drop sqlite,
  rewrite the codebase. POST /admin/reload is the least interesting
  thing they could do. The defense at this layer is network
  reachability (nginx doesn't proxy /admin/*, grappa binds 127.0.0.1
  only), NOT input validation against an attacker with the keys.
  See `RemoteIpFromProxy` moduledoc for the full trust matrix.
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
