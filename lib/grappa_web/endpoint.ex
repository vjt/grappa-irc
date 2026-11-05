defmodule GrappaWeb.Endpoint do
  @moduledoc """
  Phoenix endpoint — HTTP + WebSocket entry point under Bandit.

  Pipeline order matters: `RequestId` runs first so every downstream
  log line carries `[request_id]`; `Telemetry` straddles `Parsers` so
  request duration includes body decoding; `MethodOverride` runs
  after `Parsers` because it reads `_method` from the parsed body;
  `Plug.Head` lets HEAD share GET routes; `Session` runs before the
  router so handlers can call `get_session/2`.

  ## Session signing-salt runtime resolution (REV-C / H21)

  `signing_salt` is read at RUNTIME from `:grappa,
  GrappaWeb.Endpoint, :session_signing_salt`. Pre-REV-C the value was
  read at COMPILE time via `Application.compile_env!/2`, which baked
  the build-time `SECRET_SIGNING_SALT` env value into the prod
  release; an operator rotating the salt via `.env` + auto-deploy
  saw no effect until the image was rebuilt with a fresh `mix
  compile`. H21 moves the read to `config/runtime.exs` alongside
  `SECRET_KEY_BASE` so rotation works the same way as the sibling
  key — bump value, COLD-deploy, salt picks up at boot.

  The runtime read is cached in `:persistent_term` on first request
  (lazy init in the `session/2` plug). Subsequent requests are
  lock-free reads. Per CLAUDE.md "Application.{put,get}_env: boot-
  time only" — this is the boundary site for the keyspace; the rest
  of the codebase never sees the raw env value. First-request races
  are benign (multiple writers, same value).

  WebSocket transport at `/socket/websocket` is the only streaming
  surface. No longpoll fallback — Phase 1 clients are evergreen
  browsers, and the Phase 6 IRCv3 listener facade will need full
  WS framing anyway.
  """
  use Phoenix.Endpoint, otp_app: :grappa

  @session_key "_grappa_key"
  @session_persistent_term_key {__MODULE__, :session_opts}

  # #399 — cached `Plug.Static` opts (keyed on the resolved dist root).
  @cic_static_persistent_term_key {__MODULE__, :cic_static_opts}

  # Top-level entries the vite build emits at the dist root (`base=/`),
  # matched on the FIRST path segment: the hashed `assets/` chunks +
  # everything copied verbatim from `cicchetto/public/` (`backgrounds/`,
  # `fonts/`, `radio-logos/`, the `icon*.{svg,png}` set,
  # `apple-touch-icon.png`, `favicon.ico`) + the pwa-plugin
  # `manifest.webmanifest`. Kept in
  # lockstep with `cicchetto/public/` — a NEW root-level public asset MUST
  # be added here or it falls through to the SPA fallback (served as
  # index.html / text/html for a browser navigation) instead of as its own
  # bytes. #485 regression (issue274/issue294 e2e): the maskable PNGs,
  # `apple-touch-icon.png`, and `favicon.ico` were absent, so once the BEAM
  # became the sole origin (nginx demoted to a dumb proxy) the PWA manifest
  # icons + the iOS home-screen icon + the legacy favicon all arrived as
  # HTML. `index.html` (SPA fallback route) and `service-worker.js`
  # (dedicated no-cache route) are deliberately OUT so they fall through to
  # the router.
  #
  # #1739 added `radio-logos/` — the vendored station artwork the radio picker
  # draws, mirrored into the tree by `bun run sync:radio-logos` so no viewer
  # ever fetches a logo from api.somafm.com. It is the same regression class as
  # the #485 icons above and it would have been QUIETER: #1739 also removed the
  # `onError` fallback from the picker's `<img>` (a same-origin asset the
  # offline gate proves is present cannot fail the way a third-party URL
  # could), so a logo arriving as `index.html` draws the browser's broken glyph
  # with nothing in any gate to say why. Measured on `spa_serving_test.exs`
  # before this line existed: `content-type: text/html; charset=utf-8`.
  #
  # #1906 added `badge-96.png` — the Web Push notification `badge`, the alpha
  # silhouette Android paints into the status bar. Same regression class
  # again, and quieter still: the SW fetches it with no page to show a broken
  # glyph on, and the platform's answer to an HTML document where it expected
  # an image is to draw its own fallback in the status bar. Measured before
  # this line existed: `text/html; charset=utf-8`, index.html.
  #
  # issue 2088 added `sounds/` — the five file-backed notification samples
  # #1480 ships (the four synthesised presets are oscillator recipes and
  # fetch nothing, which is why only five of nine went silent). FOURTH
  # instance of the class, measured on staging exactly like the three
  # above: `/sounds/xp-ding.mp3` -> `200 text/html; charset=utf-8`, and a
  # path that exists nowhere answered the same 200 — the status never
  # discriminated, only the content-type did.
  #
  # A list forgotten four times is itself the defect, so the lockstep is
  # no longer a promise in this comment: `spa_serving_test.exs` walks
  # every file under `cicchetto/public/` and fails on the first one that
  # comes back as the shell. A fifth entry added below without that walk
  # going green is a contradiction the suite will not let through.
  @cic_static_only ~w(assets backgrounds fonts radio-logos sounds
                      manifest.webmanifest
                      icon.svg icon-192.png icon-512.png
                      icon-192-maskable.png icon-512-maskable.png
                      apple-touch-icon.png favicon.ico badge-96.png)

  # #485 — the far-future cache window (10 years, in seconds) for the
  # system-owned, content-keyed `/backgrounds/` assets. Shared by the
  # `Cache-Control: max-age` and the `Expires` HTTP-date in
  # `cache_backgrounds/2` so the two can never drift apart.
  @backgrounds_max_age 315_360_000

  # #95 — accept the bearer via the `Sec-WebSocket-Protocol` subprotocol
  # (`auth_token: true`) so it no longer has to ride `?token=` on the WS
  # upgrade URL (pre-redaction URL exposure). Phoenix decodes the
  # `base64url.bearer.phx.<token>` subprotocol into
  # `connect_info.auth_token` and echoes the selected subprotocol back on
  # the handshake; phoenix.js sends it via `new Socket(ep, {authToken})`.
  # `auth_token: true` MUST be a TOP-LEVEL socket option, NOT nested
  # under `websocket:` — `Phoenix.Endpoint`'s `put_auth_token/2` reads
  # `opts[:auth_token]` (the socket-level key) and merges it into the
  # transport config itself; nesting it under `websocket:` leaves
  # `opts[:auth_token]` nil, silently disables decoding, and every
  # subprotocol handshake 403s (found via e2e — the WS refused in ~11µs
  # because `connect_info.auth_token` was never populated). `connect_info:
  # [:auth_token]` on the websocket transport then surfaces the decoded
  # token to `UserSocket.connect/3`.
  #
  # #202 dropped the legacy `params["token"]` query-string path that #95
  # had retained as a one-deploy-cycle fallback: with prod telemetry
  # showing sustained zero query-string auth, the subprotocol is now the
  # SOLE bearer source and the token never rides the WS upgrade URL.
  # #447 — a custom `error_handler` turns a `{:error, :upgrade_required}`
  # return from `UserSocket.connect/3` (a client declaring a wire protocol
  # below `Grappa.Protocol.min_version/0` via the `?client_proto=` query
  # param) into a clean `426 Upgrade Required` instead of the transport's
  # default opaque 403. `Phoenix.Socket.Transport.load_config/2` merges
  # `websocket:` opts OVER the transport's `default_config/0`, so this key
  # overrides the default `{Phoenix.Transports.WebSocket, :handle_error}`.
  # It fires ONLY for `{:error, reason}` returns; a bare `:error` (auth
  # failure) still gets the default 403, keeping the two failures distinct.
  # #543 Part C — `:peer_data` (transport peer IP) + `:x_headers` (the
  # forwarded `x-*` request headers) are surfaced to `UserSocket.connect/3`
  # so it can resolve the TRUSTED client IP (via the `RemoteIpFromProxy`
  # SSOT) and feed it to `Vhosts.record_client_source/2`. A WS `connect/3`
  # gets `connect_info` (a map built ONLY from the declared keys), NOT a
  # `Plug.Conn`, so the `RemoteIpFromProxy` PLUG above never runs for the
  # socket — these keys are the socket's only path to the client IP. Additive
  # to `:auth_token`; ordering of the other socket opts is untouched.
  socket "/socket", GrappaWeb.UserSocket,
    auth_token: true,
    websocket: [
      connect_info: [:auth_token, :peer_data, :x_headers],
      error_handler: {GrappaWeb.UserSocket, :handle_ws_error, []}
    ],
    longpoll: false

  plug Plug.RequestId

  # Honor X-Forwarded-For / X-Real-IP from nginx so `conn.remote_ip`
  # resolves to the real client (not the docker-bridge or jail-loopback
  # nginx IP). Placed AFTER RequestId so the request-id log prefix is
  # set first, BEFORE Telemetry so every telemetry event already sees
  # the rewritten IP. The wrapper plug overwrites `conn.remote_ip`
  # in-place; downstream code (Logger metadata, captcha verify,
  # visitor.ip audit) needs no changes.
  #
  # `RemoteIpFromProxy` is a thin wrapper around `RemoteIp` with one
  # extra rule: peer-loopback + no-XFF → trust the peer (operator
  # shell, healthcheck). All other shapes — including peer-loopback
  # + has-XFF — delegate to RemoteIp so the local reverse-proxy path
  # (the bastille jail, or any deployment an operator fronts with a
  # same-host proxy — grappa bound to 127.0.0.1:4000; #485 dropped the
  # in-stack docker nginx, so docker prod is this shape ONLY when the
  # operator adds their own proxy) surfaces the real client IP instead
  # of `127.0.0.1`. See the wrapper's moduledoc for
  # the full trust matrix and the explicitly-accepted shell-spoof
  # residual risk.
  plug GrappaWeb.Plugs.RemoteIpFromProxy,
    headers: ~w[x-forwarded-for x-real-ip]

  # #485 — the security-header set (CSP + siblings) is emitted by the app on
  # EVERY response, the single source of truth after the nginx container was
  # dropped (docker), the jail/e2e nginx became a dumb proxy, and an operator's
  # own TLS front door — which never got our headers before — now inherits them.
  # BEFORE `:serve_cic_static` ON PURPOSE: a static HIT sends + halts, so the
  # plug's `register_before_send` must already be registered to ride that
  # response. See GrappaWeb.Plugs.SecurityHeaders for the CSP allowlist rationale.
  plug GrappaWeb.Plugs.SecurityHeaders

  # #485 — far-future immutable cache for the built-in theme backgrounds,
  # replicating nginx's `location /backgrounds/ { expires max; }`. Registered
  # before `:serve_cic_static` so the before_send overwrites Plug.Static's
  # default `cache-control: public` on the way out. Skipped when the request
  # falls through to the SPA shell (a missing key), so index.html is never
  # cached as immutable.
  plug :cache_backgrounds

  # #399 — self-serve the built cicchetto SPA static assets from the
  # embedded web server so a plain `bin/grappa start` on an HTTP port
  # yields a working instance without nginx in front (nginx stays
  # RECOMMENDED for TLS + static fronting in production, not required).
  # Runtime-configured (`Grappa.Cic.Bundle.root/0`, boot `:persistent_term`)
  # via the same cached-opts pattern as the `:session` plug below —
  # `Plug.Static` init compiles the `:only` matcher, so we cache the opts
  # keyed on the resolved root and rebuild only when it changes (boot /
  # tests). Placed BEFORE Telemetry/Parsers/Session/Router: a static HIT
  # sends + halts, skipping body parsing and the router; a MISS falls
  # through untouched (so nginx-fronted prod, where these paths never
  # reach the BEAM, is unaffected). `index.html` is served by the SPA
  # history-fallback route and `service-worker.js` by a dedicated
  # no-cache route (nginx parity) — both EXCLUDED from `:only` here so
  # they fall through to the router.
  plug :serve_cic_static

  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  # No multipart parser here (issue 2529). A multipart body crosses the
  # endpoint unread (`pass: ["*/*"]` leaves `body_params` unfetched) and is
  # parsed by the route that takes it, in the router, after `:authn`:
  # `:upload_body` for the two upload doors, `:multipart_body` for the rest
  # (`GrappaWeb.MultipartLimits` holds both ceilings). A route that takes a
  # file without one of those pipelines gets params without the body, which
  # is why `GrappaWeb.MultipartBodyTest` fails on any such route.
  plug Plug.Parsers,
    parsers: [:urlencoded, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug :session
  plug GrappaWeb.Router

  # #399 — serve the built cic SPA static assets from the runtime-
  # resolved dist root. Same cached-opts pattern as `session/2`:
  # `Plug.Static.init/1` compiles the `:only` matcher, so cache the opts
  # keyed on the current root + rebuild only when it changes (a boot
  # `Grappa.Cic.Bundle.boot/1`, or a test pointing at a different dist).
  defp serve_cic_static(conn, _) do
    Plug.Static.call(conn, cached_cic_static_opts())
  end

  defp cached_cic_static_opts do
    root = Grappa.Cic.Bundle.root()

    case :persistent_term.get(@cic_static_persistent_term_key, nil) do
      {^root, opts} ->
        opts

      _ ->
        opts = Plug.Static.init(at: "/", from: root, only: @cic_static_only)
        :persistent_term.put(@cic_static_persistent_term_key, {root, opts})
        opts
    end
  end

  # #485 — the app-side answer to nginx's `location /backgrounds/ { expires
  # max; }`: it emits BOTH `Cache-Control: public, max-age=<10y>, immutable`
  # (the `immutable` an improvement over nginx — it suppresses revalidation
  # entirely, which `expires max` did NOT) AND a matching far-future
  # `Expires` HTTP-date. nginx's `expires max` set both headers; under #485
  # the BEAM is the sole origin (nginx demoted to a dumb proxy), so it must
  # carry `Expires` itself — the issue294 e2e asserts it on the wire, and a
  # cache-control-only response regressed it to absent. The before_send
  # overwrites Plug.Static's default `cache-control: public` at send time.
  # Skipped for the SPA-shell fallback (a missing key served as index.html),
  # so the shell is never pinned as immutable under a /backgrounds/ URL.
  defp cache_backgrounds(%Plug.Conn{request_path: "/backgrounds/" <> _} = conn, _) do
    Plug.Conn.register_before_send(conn, fn conn ->
      if conn.status == 200 and not spa_shell?(conn) do
        conn
        |> Plug.Conn.put_resp_header(
          "cache-control",
          "public, max-age=#{@backgrounds_max_age}, immutable"
        )
        |> Plug.Conn.put_resp_header("expires", far_future_http_date())
      else
        conn
      end
    end)
  end

  defp cache_backgrounds(conn, _), do: conn

  # The `Expires` twin of the far-future `Cache-Control: max-age` above:
  # `now + @backgrounds_max_age` as an RFC 7231 IMF-fixdate
  # (`Sun, 06 Nov 1994 08:49:37 GMT`). `Calendar.strftime/2` emits the
  # English day/month abbreviations HTTP requires; the value is always UTC,
  # so the literal `GMT` suffix is correct.
  defp far_future_http_date do
    DateTime.utc_now()
    |> DateTime.add(@backgrounds_max_age, :second)
    |> Calendar.strftime("%a, %d %b %Y %H:%M:%S GMT")
  end

  defp spa_shell?(conn) do
    match?(["text/html" <> _], Plug.Conn.get_resp_header(conn, "content-type"))
  end

  # Custom session plug that reads `signing_salt` at runtime from
  # `:grappa, __MODULE__, :session_signing_salt`. Cached after first
  # request — see moduledoc for the H21 rationale.
  defp session(conn, _) do
    Plug.Session.call(conn, cached_session_opts())
  end

  defp cached_session_opts do
    case :persistent_term.get(@session_persistent_term_key, nil) do
      nil ->
        opts = build_session_opts()
        :persistent_term.put(@session_persistent_term_key, opts)
        opts

      opts ->
        opts
    end
  end

  defp build_session_opts do
    salt =
      :grappa
      |> Application.fetch_env!(__MODULE__)
      |> Keyword.fetch!(:session_signing_salt)

    Plug.Session.init(
      store: :cookie,
      key: @session_key,
      signing_salt: salt,
      same_site: "Lax"
    )
  end

  # REV-C reviewer MED-1/MED-2 + round-2 HIGH-1: invalidate the
  # session-opts cache when `:session_signing_salt` changes at
  # runtime. `:persistent_term.put/2` OVERWRITES the existing key —
  # avoids the `:persistent_term.erase/1` process-wide GC scan
  # documented at https://www.erlang.org/doc/man/persistent_term.html.
  #
  # `changed` arrives application-scoped from
  # `Application.config_change/3`:
  #
  #   [{GrappaWeb.Endpoint, [session_signing_salt: ..., url: ...]},
  #    {OtherKey, ...}]
  #
  # — NOT flat. The predicate must descend into our own module's
  # keyword first (Phoenix's own `Phoenix.Config.config_change/3`
  # uses `changed[module]` for the same reason). `removed` is the
  # outer-keys list; presence of `__MODULE__` there means the whole
  # endpoint env was removed (full rotation as if a fresh boot).
  #
  # `Phoenix.Endpoint.__phoenix_endpoint__/3` macros generate the
  # base `config_change/2`; we wrap with super/2 + the cache hop.
  defoverridable config_change: 2

  @impl Phoenix.Endpoint
  def config_change(changed, removed) do
    our_changed = Keyword.get(changed, __MODULE__, [])

    if Keyword.has_key?(our_changed, :session_signing_salt) or
         __MODULE__ in removed do
      :persistent_term.put(@session_persistent_term_key, build_session_opts())
    end

    super(changed, removed)
  end
end
