import Config

config :grappa, Grappa.Repo,
  database: Path.expand("../runtime/grappa_test#{System.get_env("MIX_TEST_PARTITION")}.db", __DIR__),
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: System.schedulers_online() * 2,
  # SQLite has a single writer; with `async: true` tests + `max_cases: 8`,
  # write-heavy tests (ScrollbackTest's 505-row insert loop) plus the
  # ~100 ms Argon2 hash inside Accounts test setup can stack the writer
  # queue deep enough to trip the busy timeout. The original 5_000 ms
  # value started cascading "Database busy" failures once Phase 2's
  # Sessions + Authn tests added more concurrent inserts; 30_000 ms
  # gives the queue enough headroom that legitimate contention waits
  # instead of erroring, while still surfacing a real deadlock loudly.
  busy_timeout: 30_000

config :grappa, GrappaWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "test-secret-key-base-replace-me-in-prod-12345678901234567890123456789012",
  server: false

config :logger, level: :warning

# Test runs invoke Grappa.Bootstrap explicitly via Bootstrap.run/0; we
# don't want the application start to autoload bound credentials and
# try to connect to real upstream IRC servers during `mix test`.
config :grappa, :start_bootstrap, false
config :phoenix, :plug_init_mode, :runtime
config :phoenix, :json_library, Jason

# Visitor self-service config (cluster visitor-auth, Task 9). The slug
# matches the test fixture network created by `network_with_server/1`
# in `Grappa.AuthFixtures` when no slug override is given to test
# helpers that assume the visitor-default network. The per-IP cap is
# kept low so the cap-exceeded test path stays cheap (provision 2 →
# 3rd fails). Production values land in `config/runtime.exs`; bootstrap
# (Task 20 W7) is the boot-time gate that rejects an unconfigured slug.
config :grappa, :visitor_network, "azzurra"
config :grappa, :max_visitors_per_ip, 2

# IRC.Client connect-failure pre-crash sleep — shrunk so the C2
# init-non-blocking failure-surfaces-async assertion stays under its 1s
# `assert_receive` window AND so per-test connect-refused tear-downs
# (Visitors.Login case 1 :upstream_unreachable) don't drag.
config :grappa, :irc_client_connect_failure_sleep_ms, 50

# Cloak vault key — non-secret, test-only. Distinct from dev so a key
# leak in one env doesn't decrypt the other env's data. The test sqlite
# is wiped per-run via Sandbox.
config :grappa, Grappa.Vault,
  ciphers: [
    default:
      {Cloak.Ciphers.AES.GCM,
       tag: "AES.GCM.V1", key: Base.decode64!("Ot80AYbRqJG9htfEztMBqz6Eo9ALMWgu9Ze6w0CbbPg="), iv_length: 12}
  ]
