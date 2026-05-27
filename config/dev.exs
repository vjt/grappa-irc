import Config

config :grappa, Grappa.Repo,
  database: Path.expand("../runtime/grappa_dev.db", __DIR__),
  pool_size: 5,
  # CP24 cluster `post-cr-review` bucket B, persistence/S2: mirror prod's
  # 30s busy_timeout so iex sessions + integration scripts hit the same
  # "database is locked" cushion as prod. Default ~2s otherwise.
  busy_timeout: 30_000,
  # REV-B / C3 (2026-05-22 codebase review): pin PRAGMAs in lockstep
  # with config/runtime.exs and config/test.exs. See runtime.exs for
  # the full rationale — dep major-version default flip would silently
  # subvert WAL durability or CASCADE FK invariants without a diff.
  synchronous: :normal,
  foreign_keys: :on,
  show_sensitive_data_on_connection_error: true

# UX-6-B1 (2026-05-20): embedded image uploader storage dir. Sibling
# of the sqlite DB under `runtime/` so the existing host bind-mount
# covers both.
config :grappa, :uploads_storage_root, Path.expand("../runtime/uploads_dev", __DIR__)

# Logger file sink — Application.start attaches a :logger_std_h handler
# writing to `<log_dir>/grappa.log` with rotation. Sibling of the
# sqlite DB under `runtime/` so the host bind-mount covers it without
# a compose.yaml edit. Set to `nil` to disable (test env).
config :grappa, :log_dir, Path.expand("../runtime/log", __DIR__)

config :grappa, GrappaWeb.Endpoint,
  http: [ip: {0, 0, 0, 0}, port: 4000],
  check_origin: false,
  debug_errors: true,
  code_reloader: true,
  watchers: [],
  secret_key_base: "dev-secret-key-base-replace-me-in-prod-12345678901234567890123456789012",
  # codebase audit web W10 + cross-infra L7 — was hardcoded "rotate-me"
  # in lib/grappa_web/endpoint.ex; now config-driven so prod env can
  # set it without a recompile (see runtime.exs).
  session_signing_salt: "dev-signing-salt-not-secret-known-to-the-repo"

config :grappa, dev_routes: true

# Cloak vault key — non-secret, dev-only. Anyone with the repo has it;
# the dev sqlite file is gitignored. Prod reads from GRAPPA_ENCRYPTION_KEY
# env var (see config/runtime.exs).
config :grappa, Grappa.Vault,
  ciphers: [
    default:
      {Cloak.Ciphers.AES.GCM,
       tag: "AES.GCM.V1", key: Base.decode64!("zHwj0qQ8nqXvDIcSIGlqjOIMtQ8aPnSNqSc8MVhQbkY="), iv_length: 12}
  ]

config :phoenix, :stacktrace_depth, 20
config :phoenix, :plug_init_mode, :runtime

# Push notifications cluster B5 (2026-05-14) — fixed VAPID keypair
# for dev/e2e. The integration harness (cicchetto/e2e/compose.yaml)
# boots grappa-test under MIX_ENV=dev; without this, Application.
# fetch_env!(:web_push_elixir, :vapid_public_key) crashes the
# PushVapidController and any e2e push-trigger spec. Mirrors
# config/test.exs's keypair byte-for-byte so the dev + test surfaces
# share the same fixture (rotating either MUST update the other —
# both are non-secret + dev/test-only). Real ECDSA P-256 pair (NOT
# random bytes — JOSE.JWS rejects malformed keys at sign time, which
# would mask trigger failures behind misleading sign errors).
config :web_push_elixir,
  vapid_public_key: "BH4P62bQOEfkSsfjpCyBWnz88Nnlyn2mtwapDEXWswb1cwR9YDE-3E-aBjNhwY2e3ErL410rgSNUBD7nQyPXGSY",
  vapid_private_key: "MIC0fm1A_ZcPF0P3ffUizcNUYwMyU-AklNw2e4aPXGw",
  vapid_subject: "mailto:dev@example.org"
