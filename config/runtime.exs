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

if config_env() == :prod do
  database_path =
    System.get_env("DATABASE_PATH") ||
      raise "environment variable DATABASE_PATH is missing"

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
    temp_store: :memory

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      Generate one with: scripts/mix.sh phx.gen.secret
      """

  # Note: SECRET_SIGNING_SALT is read at COMPILE time via config.exs
  # (Plug.Session's @session_options module-attribute is compile-time;
  # `Application.compile_env!/2` validates compile == runtime so the
  # value MUST come from the build env). Operator sets the var in .env
  # BEFORE scripts/deploy.sh; the value bakes into the prod release.
  # Rotation = bump value + scripts/deploy.sh full rebuild.

  port = String.to_integer(System.get_env("PORT") || "4000")

  # Public hostname the bouncer is reached at via nginx (e.g. grappa.bad.ass).
  # Two roles, both load-bearing in prod:
  #   * `url:` — Phoenix URL helpers generate links rooted at this host.
  #   * `check_origin:` — WebSocket handshake validates the browser's
  #     `Origin` header against this allowlist. Phoenix's default is to
  #     require Origin == endpoint URL host; without an explicit allow
  #     listing the public hostname, every Channels connect is rejected
  #     in prod (origin == http://grappa.bad.ass, endpoint URL host ==
  #     localhost). The `//` prefix matches both http and https so the
  #     Phase 5 TLS upgrade does not silently break Channels.
  phx_host = System.get_env("PHX_HOST") || "grappa.bad.ass"

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
    url: [host: phx_host, port: 80],
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
