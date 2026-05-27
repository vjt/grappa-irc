defmodule GrappaWeb.Plugs.RemoteIpFromProxy do
  @moduledoc """
  Conditionally rewrite `conn.remote_ip` from the X-Forwarded-For /
  X-Real-IP chain, treating loopback peers as legitimate proxies
  when they carry forwarded headers.

  Wraps the `RemoteIp` hex package. Same option shape: `headers:` +
  `proxies:` + `clients:` etc. are forwarded verbatim.

  ## Trust model

  Three cases, decided by `(peer_loopback?, has_xff?)`:

      | peer        | XFF present | action                                    |
      |-------------|-------------|-------------------------------------------|
      | loopback    | no          | trust peer (direct curl from inside box)  |
      | loopback    | yes         | trust XFF (local nginx is reverse-proxying) |
      | non-loopback| any         | trust peer (direct client, ignore headers) |

  The middle row is the load-bearing one for the bastille jail
  (cp52 S2 incident): nginx runs in the same jail as grappa and
  proxies via `127.0.0.1:4000`. Every legitimate user request
  surfaces with `peer = 127.0.0.1` AND nginx-set X-F-F. Without
  the rewrite, every user session would persist `ip = "127.0.0.1"`
  instead of the real client IP — silent data loss on the audit
  trail. The Docker substrate (`scripts/deploy.sh`) has the same
  shape: nginx publishes on `0.0.0.0:80`, grappa publishes on
  `127.0.0.1:4000`, nginx proxies via the docker bridge but local
  curls from the container also hit loopback — same rule applies.

  The first row covers the operator's healthcheck/admin-poke shape:
  `sudo bastille cmd grappa curl http://127.0.0.1:4000/admin/reload`
  (or `docker exec grappa curl ...`) — loopback peer, no proxy
  headers, trust the peer. `Plugs.LoopbackOnly` gates on the result.

  ## Shell-spoof: explicitly accepted residual risk

  An attacker with shell access on the host CAN spoof
  `X-Forwarded-For: 127.0.0.1` from a loopback peer; the wrapper
  trusts XFF in that case and `Plugs.LoopbackOnly` would accept
  the result. The earlier (cp51-era) version of this plug blocked
  that spoof at the cost of breaking nginx-as-local-proxy. The
  trade-off is intentional: anyone who can run `sudo bastille cmd
  grappa <anything>` or `docker exec grappa <anything>` already
  has root-equivalent access (kill the BEAM, drop the sqlite DB,
  write the codebase). `POST /admin/reload` is the least
  interesting thing they could do. The defense at this layer is
  network reachability (nginx doesn't proxy `/admin/reload`,
  grappa binds 127.0.0.1 only), NOT input validation against an
  attacker who already has the keys.

  ## Loopback shapes

  `{127, _, _, _}` and `{0, 0, 0, 0, 0, 0, 0, 1}` are the only two
  loopback shapes that reach Phoenix. The IPv4-mapped IPv6 form
  `{0, 0, 0, 0, 0, 0xffff, hi, lo}` is NOT loopback per RFC 4291 —
  it's an IPv4 address in IPv6 transport. Real clients that hit
  Phoenix via the v4-mapped form get treated as non-loopback
  peers, which is correct.
  """
  @behaviour Plug

  @impl Plug
  def init(opts) do
    headers = Keyword.get(opts, :headers, ~w[x-forwarded-for x-real-ip])
    {headers, RemoteIp.init(opts)}
  end

  @impl Plug
  def call(%Plug.Conn{remote_ip: peer} = conn, {headers, remote_ip_opts}) do
    if loopback?(peer) and not has_forwarded_header?(conn, headers) do
      conn
    else
      RemoteIp.call(conn, remote_ip_opts)
    end
  end

  defp loopback?({127, _, _, _}), do: true
  defp loopback?({0, 0, 0, 0, 0, 0, 0, 1}), do: true
  defp loopback?(_), do: false

  defp has_forwarded_header?(conn, headers) do
    Enum.any?(headers, fn name ->
      case Plug.Conn.get_req_header(conn, name) do
        [] -> false
        _ -> true
      end
    end)
  end
end
