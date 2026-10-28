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
      | non-loopback| any         | delegate to `RemoteIp`: the forwarded-chain client if XFF is present (walked right-to-left, reserved ranges skipped), else the peer |

  The `non-loopback` row is NOT "ignore headers and trust the peer":
  a non-loopback peer WITH an XFF still has its chain walked (the
  docker-bridge / operator-fronted-proxy shape) — see the plug tests.
  The single source of truth for all three rows is
  `trusted_client_ip/3`; the socket and HTTP doors both delegate to it.

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
  headers, trust the peer. This row is ALSO the shape
  `Plugs.LoopbackOnly` gates on — but it gates on the predicate below,
  never on this row's resolved value.

  ## The resolved client IP is NOT an authorization signal

  `trusted_client_ip/3`'s answer is the best available *attribution* of
  a request — it is not a capability. A resolved value of `127.0.0.1`
  can mean "the operator's shell curled us directly" OR "a forwarded
  chain resolved to nothing and the peer happened to be the local
  reverse proxy". Those two are not equally privileged, and no consumer
  can tell them apart from the resolved value alone.

  So `Plugs.LoopbackOnly` does NOT read `conn.remote_ip`. It reads
  `direct_loopback_peer?/1`, the row-1 predicate this plug stamps as an
  assign: transport peer is loopback AND the request carries no
  forwarded header at all. That is exactly the operator-shell shape and
  it is a property of the TRANSPORT, so it cannot be produced by
  anything a request body or header says. Every reverse proxy this
  project ships sets a forwarded header unconditionally
  (`infra/snippets/locations-api.conf`), so a request that arrived
  through one can never satisfy the predicate.

  **Residual, named:** the predicate's tightness rests on the fronting
  proxy setting a forwarded header. An operator who fronts grappa with
  their own proxy that sets none AND proxies over loopback presents
  every request as the operator shell. That is unchanged from the
  earlier behaviour rather than introduced here, and it is why
  operators should keep grappa's port bound away from untrusted
  networks regardless. Shell access on the host also remains
  root-equivalent by construction (kill the BEAM, drop the sqlite DB,
  rewrite the codebase), so this layer never claimed to defend against
  it.

  ## Loopback shapes

  `{127, _, _, _}` and `{0, 0, 0, 0, 0, 0, 0, 1}` are the only two
  loopback shapes that reach Phoenix. The IPv4-mapped IPv6 form
  `{0, 0, 0, 0, 0, 0xffff, hi, lo}` is NOT loopback per RFC 4291 —
  it's an IPv4 address in IPv6 transport. Real clients that hit
  Phoenix via the v4-mapped form get treated as non-loopback
  peers, which is correct.

  ## Shared trust SSOT (#543 Part C)

  The trust DECISION lives in exactly one place — `trusted_client_ip/3`
  — so callers OUTSIDE the plug pipeline reuse it verbatim instead of
  reimplementing this (subtle, security-load-bearing) matrix. The HTTP
  `call/2` delegates to it; `GrappaWeb.UserSocket.connect/3` calls the
  zero-config `trusted_client_ip/2` with the `peer_data`/`x_headers` it
  reads from `connect_info` (a WS `connect/3` gets `connect_info`, NOT a
  `Plug.Conn`, so `RemoteIp` can't run as a plug there). Both paths land
  the SAME trusted client IP — one door, one matrix.
  """
  @behaviour Plug

  # The header allowlist SSOT — `init/1`'s default AND the set the
  # zero-config `trusted_client_ip/2` uses. The endpoint plug is wired with
  # this exact literal (`headers: ~w[x-forwarded-for x-real-ip]`), pinned by
  # `RemoteIpFromProxyTest`'s "config wiring" drift test, so the HTTP and WS
  # doors can't drift onto different header sets.
  @default_headers ~w[x-forwarded-for x-real-ip]

  # The assign carrying the row-1 predicate. Private on purpose: readers go
  # through `direct_loopback_peer?/1` so exactly ONE module knows both the
  # key and the fail-closed default.
  @direct_peer_assign :direct_loopback_peer

  @typedoc "Packed plug options: the header allowlist + the `RemoteIp` keyword opts."
  @type opts :: {[binary()], keyword()}

  @impl Plug
  @spec init(keyword()) :: opts()
  def init(opts) do
    headers = Keyword.get(opts, :headers, @default_headers)
    # Keep the RAW keyword opts (not `RemoteIp.init/1`'s packed form): the
    # SSOT resolves via `RemoteIp.from/2`, which re-packs internally and is
    # the blessed non-`Plug.Conn` entry (RemoteIp moduledoc). `:headers` is
    # forced so `from/2` honours the same allowlist the plug advertises.
    {headers, Keyword.put(opts, :headers, headers)}
  end

  @impl Plug
  @spec call(Plug.Conn.t(), opts()) :: Plug.Conn.t()
  def call(%Plug.Conn{remote_ip: peer, req_headers: req_headers} = conn, {headers, _} = opts) do
    ip = trusted_client_ip(peer, req_headers, opts)
    # Preserve `RemoteIp.call/2`'s side-effect: it stamped the `:remote_ip`
    # Logger metadata (config allowlists it — the HTTP log line carries the
    # post-rewrite client IP). `RemoteIp.from/2` does NOT, so re-stamp it
    # here. This is an HTTP-request logging concern local to the plug, not
    # part of the shared trust decision.
    put_remote_ip_metadata(ip)

    # Stamp the row-1 predicate here — this is the only point in the pipeline
    # that still sees the transport peer, which `remote_ip` is about to lose.
    direct? = direct_loopback_peer?(peer, req_headers, headers)

    Plug.Conn.assign(%{conn | remote_ip: ip}, @direct_peer_assign, direct?)
  end

  @doc """
  Whether the request reached the BEAM DIRECTLY from inside the box: the
  transport peer is loopback and no forwarded header is present.

  This is the authorization-grade signal `Plugs.LoopbackOnly` gates on —
  distinct from `conn.remote_ip`, which after `call/2` is an attribution
  and can be loopback for reasons that carry no privilege. Reads the assign
  `call/2` stamps and **fails closed**: a conn the plug never touched
  answers `false`.
  """
  @spec direct_loopback_peer?(Plug.Conn.t()) :: boolean()
  def direct_loopback_peer?(%Plug.Conn{assigns: assigns}),
    do: Map.get(assigns, @direct_peer_assign, false)

  @doc """
  Row 1 of the trust matrix, as a predicate: loopback transport peer AND no
  forwarded header among the `headers` allowlist.

  Both a resolution input (row 1 returns the peer verbatim) and the
  authorization signal `call/2` stamps for `Plugs.LoopbackOnly` — one
  definition, so the gate can never drift onto a different header allowlist
  than the resolver. Takes the allowlist itself, not the packed `opts()`:
  the decision has no business reading `RemoteIp`'s keyword options.
  """
  @spec direct_loopback_peer?(:inet.ip_address(), [{binary(), binary()}], [binary()]) ::
          boolean()
  def direct_loopback_peer?(peer_ip, req_headers, headers) do
    loopback?(peer_ip) and not has_forwarded_header?(req_headers, headers)
  end

  @doc """
  Resolves the trusted client IP for a caller OUTSIDE the plug pipeline
  (the WS `connect/3`), using the SAME default header allowlist the
  endpoint plug is wired with. `req_headers` is the forwarded-header list
  (`connect_info.x_headers`); `peer_ip` is `connect_info.peer_data.address`.
  """
  @spec trusted_client_ip(:inet.ip_address(), [{binary(), binary()}]) :: :inet.ip_address()
  def trusted_client_ip(peer_ip, req_headers) when is_tuple(peer_ip) and is_list(req_headers) do
    trusted_client_ip(peer_ip, req_headers, init([]))
  end

  @doc """
  The trust-matrix SSOT: given the transport peer IP + the request's
  forwarded headers, return the IP to trust as the client.

      | peer         | XFF present | trusted                                   |
      |--------------|-------------|-------------------------------------------|
      | loopback     | no          | the peer (operator shell / direct curl)   |
      | loopback     | yes         | the header-chain client (local nginx)     |
      | non-loopback | any         | the header-chain client, else the peer    |

  The non-loopback rows delegate to `RemoteIp.from/2`, which walks the
  forwarded chain right-to-left and stops at the first non-reserved IP —
  so a trusted proxy's appended real client wins over any forged leftmost
  entry, and a header yielding no client falls back to the peer.

  That last fallback is a known ATTRIBUTION limitation, still open: when
  every entry in the chain is a reserved address the walk yields nothing,
  and the answer collapses onto the transport peer — so such clients
  share one identity for throttle keys, the `sessions.ip` audit column
  and the #543 mode-2 source derivation. Do NOT read a return value of
  this function as a privilege; `Plugs.LoopbackOnly` gates on
  `direct_loopback_peer?/1` precisely so this limitation cannot become an
  authorization decision.
  """
  @spec trusted_client_ip(:inet.ip_address(), [{binary(), binary()}], opts()) ::
          :inet.ip_address()
  def trusted_client_ip(peer_ip, req_headers, {headers, remote_ip_opts}) do
    if direct_loopback_peer?(peer_ip, req_headers, headers) do
      peer_ip
    else
      case RemoteIp.from(req_headers, remote_ip_opts) do
        nil -> peer_ip
        client -> client
      end
    end
  end

  defp loopback?({127, _, _, _}), do: true
  defp loopback?({0, 0, 0, 0, 0, 0, 0, 1}), do: true
  defp loopback?(_), do: false

  defp has_forwarded_header?(req_headers, headers) do
    Enum.any?(req_headers, fn {name, _} -> name in headers end)
  end

  # Replicates `RemoteIp.call/2`'s `add_metadata/1` (a private dep helper):
  # stamp the client IP as `:remote_ip` Logger metadata via `:inet.ntoa/1`,
  # skipping a malformed tuple rather than crashing the request.
  defp put_remote_ip_metadata(ip) do
    case :inet.ntoa(ip) do
      {:error, _} -> :ok
      str -> Logger.metadata(remote_ip: to_string(str))
    end
  end
end
