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

config :logger, :console, format: "[$level] $message\n"
config :phoenix, :stacktrace_depth, 20
config :phoenix, :plug_init_mode, :runtime
