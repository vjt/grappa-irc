import Config

# This file is loaded at runtime in releases (after compile-time config).
# Read environment variables here, NOT in compile-time config files.

if config_env() == :prod do
  database_path =
    System.get_env("DATABASE_PATH") ||
      raise "environment variable DATABASE_PATH is missing"

  config :grappa, Grappa.Repo,
    database: database_path,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10"),
    journal_mode: :wal,
    cache_size: -64_000,
    temp_store: :memory

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      Generate one with: scripts/mix.sh phx.gen.secret
      """

  port = String.to_integer(System.get_env("PORT") || "4000")

  config :grappa, GrappaWeb.Endpoint,
    http: [ip: {0, 0, 0, 0}, port: port],
    secret_key_base: secret_key_base,
    server: true

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
end
