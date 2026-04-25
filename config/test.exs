import Config

config :grappa, Grappa.Repo,
  database: Path.expand("../runtime/grappa_test#{System.get_env("MIX_TEST_PARTITION")}.db", __DIR__),
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: System.schedulers_online() * 2,
  # SQLite has a single writer; with `async: true` tests + `max_cases: 8`,
  # write-heavy tests (e.g. ScrollbackTest's 505-row insertion loop) can
  # hit `Database busy` if a sibling test holds the writer when our turn
  # arrives. `busy_timeout` makes the second writer wait up to N ms for
  # the lock instead of erroring immediately. 5s comfortably covers any
  # realistic test-suite contention without masking actual deadlocks.
  busy_timeout: 5_000

config :grappa, GrappaWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "test-secret-key-base-replace-me-in-prod-12345678901234567890123456789012",
  server: false

config :logger, level: :warning

# Test runs invoke Grappa.Bootstrap explicitly via Bootstrap.run/1; we
# don't want the application start to autoload grappa.toml and try to
# connect to real upstream IRC servers during `mix test`.
config :grappa, :start_bootstrap, false
config :phoenix, :plug_init_mode, :runtime
config :phoenix, :json_library, Jason

# Cloak vault key — non-secret, test-only. Distinct from dev so a key
# leak in one env doesn't decrypt the other env's data. The test sqlite
# is wiped per-run via Sandbox.
config :grappa, Grappa.Vault,
  ciphers: [
    default:
      {Cloak.Ciphers.AES.GCM,
       tag: "AES.GCM.V1", key: Base.decode64!("Ot80AYbRqJG9htfEztMBqz6Eo9ALMWgu9Ze6w0CbbPg="), iv_length: 12}
  ]
