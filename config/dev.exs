import Config

config :grappa, Grappa.Repo,
  database: Path.expand("../runtime/grappa_dev.db", __DIR__),
  pool_size: 5,
  show_sensitive_data_on_connection_error: true

config :grappa, GrappaWeb.Endpoint,
  http: [ip: {0, 0, 0, 0}, port: 4000],
  check_origin: false,
  debug_errors: true,
  code_reloader: true,
  watchers: [],
  secret_key_base: "dev-secret-key-base-replace-me-in-prod-12345678901234567890123456789012"

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

config :logger, :console, format: "[$level] $message\n"
config :phoenix, :stacktrace_depth, 20
config :phoenix, :plug_init_mode, :runtime
