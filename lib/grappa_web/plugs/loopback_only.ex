defmodule GrappaWeb.Plugs.LoopbackOnly do
  @moduledoc """
  Halts, with a uniform 403 JSON body, any request that did not reach the
  BEAM directly from inside the container / jail.

  Used to gate the admin reload endpoint (`POST /admin/reload`) so it's
  only callable from inside the running container / jail — `docker exec
  grappa curl -X POST http://localhost:4000/admin/reload` (or `bastille
  cmd grappa ...`). **This gate is now the primary defense (GH #485).**
  Since #485 every nginx substrate is a dumb reverse proxy that forwards
  `/admin/*` unfiltered (the old proxy allowlist was deleted with the
  nginx container), so nothing upstream drops a remote hit on
  `/admin/reload` any more — this plug does, by checking the REAL client
  IP. grappa's compose service also publishes on `127.0.0.1:4000` by
  default + sits on the `grappa_internal` bridge only, so port-publish
  defaults are the outer layer and this loopback gate is the inner one.

  Why a plug instead of an env-var bearer: stateless, no rotation
  ceremony, and matches the operator workflow (the reload trigger IS
  always going to be `docker exec grappa curl ...`). When Phase 5
  hardening adds an admin auth surface (Phoenix.LiveDashboard with
  basic-auth or session-cookie), this plug stays as the inner gate;
  the auth layer is the outer one.

  ## Why NOT `conn.remote_ip`

  `conn.remote_ip` is an *attribution*, not a capability. By the time
  this plug runs, `GrappaWeb.Endpoint`'s `RemoteIpFromProxy` has already
  replaced the transport peer with the best available guess at who the
  client is — and that guess can be loopback for reasons that carry no
  operator privilege whatsoever. A forwarded chain that names only
  reserved addresses yields no client at all, and the resolver then
  answers with the transport peer, which behind a same-host reverse
  proxy (the bastille jail, `proxy_pass 127.0.0.1:4000`) IS loopback.
  Gating on that value made the gate a function of a heuristic.

  So the gate reads `RemoteIpFromProxy.direct_loopback_peer?/1` instead:
  the transport peer was loopback AND the request carried no forwarded
  header. That is a property of the TRANSPORT — nothing a caller can put
  in a header produces it — and it is exactly the operator shape this
  gate exists for (`sudo bastille cmd grappa curl
  http://127.0.0.1:4000/admin/reload`, `docker exec grappa curl ...`).
  Every deploy path that pokes these routes uses exactly that shape.
  A request that came through any proxy this project ships carries a
  forwarded header unconditionally, so it can never satisfy the
  predicate.

  It **fails closed**: a conn that never passed through
  `RemoteIpFromProxy` answers `false` and gets the 403.

  The residual (a fronting proxy that sets no forwarded header at all
  while proxying over loopback) is named in the `RemoteIpFromProxy`
  moduledoc, together with the full trust matrix.
  """
  @behaviour Plug

  import Plug.Conn

  alias GrappaWeb.Plugs.RemoteIpFromProxy

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _) do
    if RemoteIpFromProxy.direct_loopback_peer?(conn) do
      conn
    else
      conn |> send_resp(403, ~s({"error":"loopback_only"})) |> halt()
    end
  end
end
