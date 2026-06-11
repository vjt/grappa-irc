import Config

# This file is loaded at runtime (after compile-time config).
# Read environment variables here, NOT in compile-time config files.
#
# ===
# Runtime env-var registry. Every System.get_env(...) read in this
# file MUST appear in:
#   * compose.yaml `environment:` block (so Docker propagates it)
#   * .env.example with a comment describing the value (so operators know)
#   * (when applicable) infra/nginx.conf CSP allowlist for any host
#     this env var configures
# Drift in any of these breaks the deploy in a way only real-browser
# e2e catches (per CP11 S22 deploy-time bug post-mortem).
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

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      Generate one with: scripts/mix.sh phx.gen.secret
      """

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
      raise """
      environment variable RELEASE_COOKIE is missing.
      Generate a real value with: openssl rand -hex 32
      Then set it in .env (or host shell) before scripts/deploy.sh.
      """

    "grappa-dev-cookie-do-not-use-in-prod" ->
      raise """
      RELEASE_COOKIE is set to the compose.yaml dev sentinel.
      Generate a real value for prod with: openssl rand -hex 32
      Then set it in .env (or host shell) before scripts/deploy.sh.
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
      raise """
      environment variable SECRET_SIGNING_SALT is missing.
      Generate one with: scripts/mix.sh phx.gen.secret 64
      """

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
  phx_host =
    phx_host ||
      raise """
      environment variable PHX_HOST is missing.
      Set it to the public hostname nginx serves the bouncer at
      (e.g. PHX_HOST=grappa.bad.ass) — see .env.example.
      """

  # Extra origins accepted by the WebSocket handshake's `check_origin`
  # gate alongside the canonical PHX_HOST. Comma-separated, full origin
  # form (no trailing slash). Use case: operators reaching the bouncer
  # via raw IP or a secondary hostname (LAN testing, dev VLAN bindings)
  # without rewriting nginx + DNS. Production should pin to PHX_HOST
  # only — this is escape-hatch, not default. Empty / unset = no extras.
  extra_origins =
    case System.get_env("EXTRA_CHECK_ORIGINS") do
      nil -> []
      "" -> []
      raw -> raw |> String.split(",") |> Enum.map(&String.trim/1) |> Enum.reject(&(&1 == ""))
    end

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
      raise """
      environment variable GRAPPA_ENCRYPTION_KEY is missing.
      Generate one with: scripts/mix.sh grappa.gen_encryption_key
      Save the output into your .env as GRAPPA_ENCRYPTION_KEY=...
      Back up the key separately — losing it loses all encrypted creds.
      """

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
    System.get_env("VAPID_PUBLIC_KEY") ||
      raise """
      environment variable VAPID_PUBLIC_KEY is missing.
      Generate a keypair with: scripts/mix.sh grappa.gen_vapid
      Save the output into compose.override.yaml under the grappa
      service's `environment:` block. Required for Web Push delivery.
      """

  vapid_private_key =
    System.get_env("VAPID_PRIVATE_KEY") ||
      raise """
      environment variable VAPID_PRIVATE_KEY is missing.
      Generate alongside VAPID_PUBLIC_KEY via:
      scripts/mix.sh grappa.gen_vapid
      """

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
end

# Outbound v6 source-address pool. CSV of IPv6 addresses; the bouncer
# picks a random entry per upstream connect so each peer IRC server
# sees a rotating rDNS identity. Useful on hosts with multiple v6
# addresses bound (vanity-domain reverse-DNS, multi-IP jails). Empty
# = kernel-default source selection (no behavior change). Parsed
# eagerly so a typo crashes the boot loud rather than silently
# falling back. Lives outside the prod gate: dev operators may set
# it for local testing too.
config :grappa,
       :outbound_v6_pool,
       Grappa.OutboundV6Pool.parse_csv(System.get_env("GRAPPA_OUTBOUND_V6_POOL"))
