import Config

# This file is loaded at runtime (after compile-time config).
# Read environment variables here, NOT in compile-time config files.
#
# ===
# Runtime env-var registry. Every System.get_env(...) read in this
# file MUST appear in:
#   * compose.yaml `environment:` block (so Docker propagates it)
#   * .env.example with a comment describing the value (so operators know)
#   * (when applicable) the CSP allowlist in GrappaWeb.Plugs.SecurityHeaders
#     for any host this env var configures (#485 moved the CSP off nginx
#     into the app — the plug is the single source of truth now)
# Drift in any of these breaks the deploy in a way only real-browser
# e2e catches (per CP11 S22 deploy-time bug post-mortem).
# ENFORCED by test/grappa/config/env_registry_drift_test.exs (#369 X1):
# it DERIVES this registry from the env-var reads below (+ the
# bin/start.sh shell knobs) and pins it against compose.yaml + .env.example
# — no hand-kept manifest to drift.
# ===

# Public hostname the bouncer is reached at via nginx. ONE read, one
# empty-means-unset semantic — every PHX_HOST consumer below derives
# from this binding (review 2026-06-11: three sites previously read
# the env with three different empty-string semantics; `PHX_HOST=""`
# produced a `check_origin: ["//"]` entry).
phx_host =
  case System.get_env("PHX_HOST") do
    empty when empty in [nil, ""] -> nil
    host -> host
  end

# Extra origins accepted by the WebSocket handshake's `check_origin`
# gate alongside the canonical PHX_HOST, AND — with PHX_HOST — the
# source of the deployment's HTTP host-alias set (#324, derived in the
# `if phx_host` block below → Grappa.HttpHosts). Comma-separated, full
# origin form (no trailing slash). Use case: operators reaching the
# bouncer via raw IP or a secondary hostname (LAN testing, dev VLAN
# bindings, a second public vhost) without rewriting nginx + DNS.
# Hoisted OUT of the prod block (all envs) so the alias set is
# derivable in the e2e harness (MIX_ENV=dev). Empty / unset = no extras.
extra_origins =
  case System.get_env("EXTRA_CHECK_ORIGINS") do
    nil -> []
    "" -> []
    raw -> raw |> String.split(",") |> Enum.map(&String.trim/1) |> Enum.reject(&(&1 == ""))
  end

case System.get_env("GRAPPA_PASSKEY_ORIGIN") do
  origin when origin in [nil, ""] -> :ok
  origin -> config :grappa, :passkey_origin, origin
end

# Public-origin URL config — ALL envs, gated on PHX_HOST presence.
# nginx terminates TLS at https://PHX_HOST, so URLs Phoenix generates
# (today: only `UploadsController.public_url/1`, which lands in IRC
# message bodies as `📸 https://host/uploads/<slug>`) must be rooted
# at the PUBLIC origin, not the BEAM's listen socket. The pre-fix
# prod shape (`url: [host: phx_host, port: 80]`, no scheme key)
# minted http:// links onto the https PWA — every pre-fix upload link
# in scrollback history carries that scheme, which is why cic's
# mediaLink classifier matches on host and re-roots the scheme
# (media-link viewer entry, DESIGN_NOTES 2026-06-11).
# Hoisted OUT of the prod block so the e2e harness (MIX_ENV=dev,
# PHX_HOST=nginx-test in cicchetto/e2e/compose.yaml) mints
# origin-faithful URLs too. Local dev: compose.yaml passes
# `PHX_HOST: ${PHX_HOST:-}` — unset keeps the config.exs localhost
# default.
if phx_host do
  config :grappa, GrappaWeb.Endpoint, url: [host: phx_host, scheme: "https", port: 443]

  # #324 — the deployment's HTTP host aliases: every hostname nginx
  # reverse-proxies to this ONE instance (shared /uploads store, e.g.
  # irc.sindro.me + irc.sniffo.org). Derived from the SAME env inputs
  # that build `check_origin` below (PHX_HOST + EXTRA_CHECK_ORIGINS) —
  # single source of truth, no second hand-maintained list. Bare,
  # lowercased hostnames (URI.parse drops scheme / `//` AND port).
  # Deployment aliases that mint uploads are default-port https, whose
  # `new URL().host` in cic is bare too → they match. A non-default-port
  # EXTRA_CHECK_ORIGINS entry (a raw-IP LAN escape hatch) won't match a
  # link on that explicit port — acceptable: it just falls back to the
  # plain anchor (never a WRONG re-root, since the page origin is always
  # admitted and the re-root always targets the page origin). Stashed
  # into `:persistent_term` by `Grappa.HttpHosts.boot/1` at app start and
  # advertised to cic via `ServerSettings.public_view/0`, so cic's
  # media-link classifier opens the in-app viewer for an upload link
  # carrying ANY alias, not just the page origin.
  http_host_aliases =
    [phx_host | Enum.map(extra_origins, fn origin -> URI.parse(origin).host end)]
    |> Enum.reject(&(&1 in [nil, ""]))
    |> Enum.map(&String.downcase/1)
    |> Enum.uniq()

  config :grappa, :http_host_aliases, http_host_aliases
end

# #399 / #485 — the built cicchetto SPA dist the embedded web server
# self-serves (Plug.Static + SPA history-fallback) AND re-reads to
# broadcast the refresh-banner hash (Grappa.Cic.Bundle). Stashed into
# `:persistent_term` via Grappa.Cic.Bundle.boot/1 at app start (boot
# time only — a change needs a BEAM restart, not a hot reload).
# Defaults to the `runtime/cicchetto-dist` build anchor, resolved against
# the BEAM's CWD (like UPLOADS_STORAGE_ROOT below). That relative default
# is ONLY correct where the CWD is the repo root: Docker (WORKDIR /app,
# and compose sets CIC_DIST_ROOT explicitly anyway) and native systemd
# (WorkingDirectory=<repo>). The FreeBSD jail is the exception (#526) —
# rc.d/grappa starts the release via `su -m grappa -c '.../bin/grappa
# daemon'` and sets NO WorkingDirectory, so the CWD is NOT the repo root;
# the jail MUST set an absolute CIC_DIST_ROOT in grappa.env (exactly like
# it already does for DATABASE_PATH / UPLOADS_STORAGE_ROOT for the same
# reason). Unset on the jail, the relative default missed the dist and
# /admin/cic-bundle-changed returned 204 with no banner broadcast —
# issue #526. A packaged install (deb/rpm/Arch) likewise sets
# CIC_DIST_ROOT to an absolute data path.
#
# Broadened from prod-only (its #399 origin) to every env EXCEPT :test so
# the e2e harness serves the SPA too: #485 made the e2e nginx a DUMB proxy,
# so the BEAM — grappa-test, which runs MIX_ENV=dev — is now the ONLY thing
# serving the SPA. With the read prod-gated, `:cic_dist_root` stayed unset
# under MIX_ENV=dev, `Grappa.Cic.Bundle.root/0` fell back to the CWD default
# `runtime/cicchetto-dist` (empty in the container; the dist is mounted at
# CIC_DIST_ROOT=/app/cicchetto-dist), and every browser spec timed out on
# an unserved SPA. Same broadening precedent as `extra_origins` +
# `http_host_aliases` above. Empty / unset = the CWD default (local dev).
#
# :test is EXCLUDED on purpose: `config/test.exs` pins `:cic_dist_root` at
# the committed fixture bundle, and runtime config runs LAST — so setting
# it here would clobber the fixture and SpaServingTest would serve an empty
# dist (the 7-failure regression this exclusion prevents).
if config_env() != :test do
  cic_dist_root =
    System.get_env("CIC_DIST_ROOT") || "runtime/cicchetto-dist"

  config :grappa, :cic_dist_root, cic_dist_root
end

if config_env() == :prod do
  database_path =
    System.get_env("DATABASE_PATH") ||
      raise "environment variable DATABASE_PATH is missing"

  # UX-6-B1 (2026-05-20): embedded image uploader storage dir. Read
  # at boot, stashed in :persistent_term via Grappa.Uploads.boot/1.
  # Defaults to `runtime/uploads` (the sibling of the sqlite DB) so
  # the existing bind-mount covers it without a compose.yaml edit.
  uploads_storage_root =
    System.get_env("UPLOADS_STORAGE_ROOT") || "runtime/uploads"

  config :grappa, :uploads_storage_root, uploads_storage_root

  # NB: `:cic_dist_root` is derived ABOVE, hoisted out of this prod block
  # (all envs except :test) since #485 — see the comment there, which
  # folds in the #526 jail-CWD knowledge that used to live here.

  config :grappa, Grappa.Repo,
    database: database_path,
    # SQLite is single-writer at the file level. `pool_size: 10` is a
    # READ-concurrency cap — every connection in the pool can serve a
    # SELECT in parallel under WAL (`journal_mode: :wal` below). Writes
    # always serialize at the file lock regardless of pool size; the
    # `busy_timeout` below is what gives them a wait-for-the-writer-
    # ahead budget. Lower than 10 starves cic's per-(user, network)
    # query fan-out under multi-tab load; higher would mostly idle.
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10"),
    # CP24 cluster `post-cr-review` bucket B, persistence/S2: SQLite's
    # default `busy_timeout` is ~2s. With `pool_size: 10` + WAL +
    # single-writer file lock, transient contention from concurrent
    # writes (Bootstrap spawning N sessions, channel-mode batches,
    # last_joined_channels writes) cascades into `database is locked`
    # exceptions before the writer ahead releases. The CP23 S4 e2e
    # flake (`cp15-b6-kicked` + `m9-cicchetto-part-x-click` retries on
    # `Database busy`) was a direct symptom. 30_000ms mirrors
    # `config/test.exs` which has carried this value since the Sandbox
    # cascading-busy investigation. Read concurrency stays uncapped;
    # this only delays the write-side raise, not block reads.
    busy_timeout: 30_000,
    journal_mode: :wal,
    cache_size: -64_000,
    temp_store: :memory,
    # REV-B / C3 (2026-05-22 codebase review): pin PRAGMAs that today
    # happen to be the correct ecto_sqlite3 defaults — `synchronous:
    # :normal` (correct under WAL — fsync on checkpoint, not every
    # commit) and `foreign_keys: :on` (the visitor-reap CASCADE chain
    # walks 8 tables and silently no-ops without it). Defaults are
    # "right by accident" — a dep major-version flip would silently
    # convert every prod commit into a fsync-deferred best-effort
    # write OR break CASCADE without a migration, log line, or diff.
    # Insurance against future dep upgrades; zero runtime behavior
    # change today.
    synchronous: :normal,
    foreign_keys: :on

  # Every missing-secret raise routes through here (#862). The per-site
  # messages used to name `scripts/mix.sh …`, which exists in exactly ONE of
  # the four install flavours — and NOT in the release image, where that line
  # was the only guidance a `docker run ghcr.io/vjt/grappa:<tag> start`
  # operator ever saw before the process died. The recipe is substrate-neutral
  # (`openssl` is a hard dependency everywhere: the .deb/.rpm depend on it,
  # the release image apk-installs it, the BEAM links libcrypto anyway) and
  # the placement hints name all four rather than one.
  #
  # Keep the shapes in lockstep with infra/packaging/gen-secrets.sh, the ONE
  # generator the packaged, containerised and deploy.sh paths all run.
  env_placement = """
    .deb / .rpm   /etc/grappa/grappa.env — or `sudo grappa gen-secrets`,
                  which fills every missing secret in one go
    docker image  docker run -e ... — or give the container a WRITABLE
                  /data volume and it generates its own on first boot
    FreeBSD jail  the grappa_env_file named in rc.conf
    from source   .env beside compose.yaml\
  """

  missing_secret = fn var, recipe ->
    raise """
    environment variable #{var} is missing.

    Generate one with:  #{recipe}

    Then set #{var} where this install reads its environment:
    #{env_placement}
    """
  end

  # VAPID is the one secret openssl cannot produce as a one-liner, and the
  # one where a half-answer is worse than none: a public key from one
  # generation and a private key from another is a silently unusable pair.
  missing_vapid = fn var ->
    raise """
    environment variable #{var} is missing (Web Push signing, RFC 8292).

    VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are two halves of ONE P-256
    keypair — generate them together, never one at a time:
      from source   scripts/mix.sh grappa.gen_vapid
      .deb / .rpm   sudo grappa gen-secrets
      docker image  give the container a writable /data volume

    Then set BOTH where this install reads its environment:
    #{env_placement}
    """
  end

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      missing_secret.("SECRET_KEY_BASE", "openssl rand -base64 48")

  # T-2: enforce a real RELEASE_COOKIE in prod. The cookie itself is
  # consumed by the BEAM at boot via `-setcookie` (bin/start.sh) — Elixir
  # never reads it. This block exists to enroll RELEASE_COOKIE in the
  # runtime.exs registry (per the comment block at top of file: every
  # System.get_env in compose.yaml MUST appear here) AND to HARD-CRASH
  # the boot when an operator deploys prod without rotating off the dev
  # sentinel. Symptom of a missing check: prod boots happily with a
  # cookie any contributor can find in compose.yaml — same-host operator
  # gate is broken.
  case String.trim(System.get_env("RELEASE_COOKIE") || "") do
    "" ->
      missing_secret.("RELEASE_COOKIE", "openssl rand -hex 32")

    "grappa-dev-cookie-do-not-use-in-prod" ->
      raise """
      RELEASE_COOKIE is set to the compose.yaml dev sentinel — that value is
      public, and it is the same-host operator gate.

      Generate a real one with:  openssl rand -hex 32
      """

    # Operator-rotated value — proceed.
    _ ->
      :ok
  end

  # SECRET_SIGNING_SALT: salt for signing the Plug.Session cookie.
  # Pre-REV-C this was read at COMPILE TIME in config.exs — operator
  # rotation via `.env` + auto-deploy was silently broken (review
  # H21). Runtime read + first-request `:persistent_term` cache in
  # `GrappaWeb.Endpoint` makes rotation a normal COLD-deploy bump
  # like SECRET_KEY_BASE. Phase 5: when an auth surface starts using
  # the cookie (PushVapidController? Future REST auth?) this becomes
  # load-bearing for real.
  secret_signing_salt =
    System.get_env("SECRET_SIGNING_SALT") ||
      missing_secret.("SECRET_SIGNING_SALT", "openssl rand -base64 32")

  config :grappa, GrappaWeb.Endpoint, session_signing_salt: secret_signing_salt

  port = String.to_integer(System.get_env("PORT") || "4000")

  # PHX_HOST is MANDATORY in prod (read once at the top of this file).
  # Both its roles are load-bearing: `url:` roots generated links at
  # the public https origin (a missing value would silently fall back
  # to config.exs `host: "localhost"` and mint dead
  # `http://localhost/uploads/<slug>` links into permanent IRC
  # scrollback bodies), and `check_origin:` below gates every
  # Channels WS handshake. The old `|| "grappa.bad.ass"` fallback was
  # equally broken on the url side, just quieter — raise instead,
  # same contract as DATABASE_PATH / SECRET_KEY_BASE above. The `//`
  # prefix in check_origin matches both http and https so the Phase 5
  # TLS upgrade does not silently break Channels.
  # The one prod variable nothing can generate for you: it is the public
  # hostname clients reach, and grappa cannot know it. Every other missing
  # value has a generator (#862 wired the release image's); this one is the
  # deliberate remaining stop on a bare `docker run`.
  phx_host =
    phx_host ||
      raise """
      environment variable PHX_HOST is missing.

      Set it to the public hostname this bouncer is served at
      (e.g. PHX_HOST=grappa.example.org). Unlike the secrets, it cannot be
      generated — nothing knows your domain but you.

      Where it goes:
      #{env_placement}
      """

  # `extra_origins` (hoisted to the top of this file, all envs) feeds
  # both the WS `check_origin` gate here and the #324 HTTP host-alias
  # set. Production should pin to PHX_HOST only — EXTRA_CHECK_ORIGINS is
  # an escape-hatch (raw IP / secondary vhost), not a default.
  config :grappa, GrappaWeb.Endpoint,
    http: [ip: {0, 0, 0, 0}, port: port],
    check_origin: ["//#{phx_host}" | extra_origins],
    secret_key_base: secret_key_base,
    server: true,
    # CP23 cluster `code-reload` B2 — enable Phoenix.CodeReloader in
    # prod so `Phoenix.CodeReloader.reload!/1` (called by the admin
    # endpoint, B3) can hot-swap modules in the running container.
    # Default in `config/dev.exs` is `true`; flipping it on in prod
    # is the only-line-of-config change that unlocks the cluster's
    # whole hot-deploy story. The reloader does file IO only on the
    # explicit reload! call, not on every request — attack surface is
    # the admin endpoint itself (loopback-only via
    # GrappaWeb.Plugs.LoopbackOnly).
    code_reloader: true,
    reloadable_apps: [:grappa]

  # Cloak vault key — base64-encoded 32 bytes. Generate once with
  # `scripts/mix.sh grappa.gen_encryption_key` and back up separately.
  # Losing the key means losing all stored upstream credentials.
  encryption_key =
    System.get_env("GRAPPA_ENCRYPTION_KEY") ||
      missing_secret.(
        "GRAPPA_ENCRYPTION_KEY",
        "openssl rand -base64 32   # BACK IT UP: losing it loses every stored credential"
      )

  config :grappa, Grappa.Vault,
    ciphers: [
      default: {Cloak.Ciphers.AES.GCM, tag: "AES.GCM.V1", key: Base.decode64!(encryption_key), iv_length: 12}
    ]

  # VAPID keypair for Web Push delivery (RFC 8292) — push notifications
  # cluster B2 (2026-05-14). Generated once with
  # `scripts/mix.sh grappa.gen_vapid` and pasted into
  # `compose.override.yaml`'s `grappa` service `environment:` block.
  #
  # `fetch_env!` so missing keys crash Bootstrap loudly rather than
  # silently dropping push delivery — same loud-failure posture as
  # SECRET_KEY_BASE / GRAPPA_ENCRYPTION_KEY above.
  #
  # The keys live in the `:web_push_elixir` application environment
  # because that's where the upstream library reads them from at
  # request time (see `WebPushElixir.send_notification/2` —
  # `Application.get_env(:web_push_elixir, :vapid_public_key)`).
  # Routing through the library's namespace avoids keeping a
  # parallel `:grappa, :vapid` mirror that would have to be kept in
  # sync at boot. The cic-facing controller reads from the SAME
  # `:web_push_elixir` namespace so the two consumers cannot drift.
  vapid_public_key =
    System.get_env("VAPID_PUBLIC_KEY") || missing_vapid.("VAPID_PUBLIC_KEY")

  vapid_private_key =
    System.get_env("VAPID_PRIVATE_KEY") || missing_vapid.("VAPID_PRIVATE_KEY")

  vapid_subject =
    case System.get_env("VAPID_SUBJECT") do
      nil -> "mailto:admin@example.org"
      "" -> "mailto:admin@example.org"
      subject -> subject
    end

  config :web_push_elixir,
    vapid_public_key: vapid_public_key,
    vapid_private_key: vapid_private_key,
    vapid_subject: vapid_subject

  config :logger, level: String.to_existing_atom(System.get_env("LOG_LEVEL") || "info")

  # T31 admission captcha — operator-set provider, secret, and public
  # site key. Read at boot by FallbackController + Admission.verify_captcha
  # via Application.get_env (the documented exception, see those modules'
  # docstrings). Default provider is Disabled so a deploy without the env
  # vars boots clean and never emits captcha_required at the boundary.
  captcha_provider =
    case System.get_env("GRAPPA_CAPTCHA_PROVIDER", "disabled") do
      "turnstile" -> Grappa.Admission.Captcha.Turnstile
      "hcaptcha" -> Grappa.Admission.Captcha.HCaptcha
      _ -> Grappa.Admission.Captcha.Disabled
    end

  captcha_site_key = System.get_env("GRAPPA_CAPTCHA_SITE_KEY")
  captcha_secret = System.get_env("GRAPPA_CAPTCHA_SECRET")

  config :grappa, :admission,
    captcha_provider: captcha_provider,
    captcha_secret: captcha_secret,
    captcha_site_key: captcha_site_key

  # Belt-and-braces softer signal: Grappa.Admission.Config.boot/0 will
  # hard-crash on missing secret/site_key for non-Disabled providers,
  # but emitting a Logger.warning here surfaces the misconfiguration at
  # runtime.exs evaluation time — earlier in the boot sequence and
  # before the Application.start cascade — which is friendlier when
  # tailing prod logs after a botched env update.
  if captcha_provider != Grappa.Admission.Captcha.Disabled do
    require Logger

    if is_nil(captcha_secret) or captcha_secret == "" do
      Logger.warning(
        "captcha provider #{inspect(captcha_provider)} configured but GRAPPA_CAPTCHA_SECRET is missing/blank — Admission.Config.boot/0 will refuse to start"
      )
    end

    if is_nil(captcha_site_key) or captcha_site_key == "" do
      Logger.warning(
        "captcha provider #{inspect(captcha_provider)} configured but GRAPPA_CAPTCHA_SITE_KEY is missing/blank — Admission.Config.boot/0 will refuse to start"
      )
    end
  end

  # #543 INC-5 — source-alias platform substrate. Selects the outbound
  # source-binding adapter (`:jail` FreeBSD wrapper / `:linux` AnyIP no-op /
  # `:docker` Disabled). Explicit env, NOT `:os.type` autodetect (a Docker
  # container reports linux yet is not the AnyIP host). Unknown/absent →
  # `:docker` (Disabled → mode 2 refuses to arm), which is the safe default;
  # a non-empty unknown value is surfaced, never silently coerced.
  substrate =
    case System.get_env("GRAPPA_SUBSTRATE") do
      "jail" ->
        :jail

      "linux" ->
        :linux

      "docker" ->
        :docker

      nil ->
        :docker

      "" ->
        :docker

      other ->
        require Logger

        Logger.warning(
          "unknown GRAPPA_SUBSTRATE #{inspect(other)} — source-alias defaulting to :docker (mode 2 disarmed)"
        )

        :docker
    end

  config :grappa, :source_alias, substrate: substrate
end
