import Config

config :grappa, Grappa.Repo,
  database: Path.expand("../runtime/grappa_test#{System.get_env("MIX_TEST_PARTITION")}.db", __DIR__),
  pool: Ecto.Adapters.SQL.Sandbox,
  # SQLite has a single writer at the file level. With async: true tests
  # checking out separate connections from the Sandbox pool, every conn
  # racing on `BEGIN IMMEDIATE; INSERT;` queues on the file lock —
  # cascading "Database busy" once host parallelism (max_cases =
  # schedulers_online * 2 = 16 on the 8-core box) exceeds what the file
  # can serialize within busy_timeout, despite the 30s budget. The
  # canonical ecto_sqlite3 Sandbox pattern is pool_size: 1: a single
  # connection which the Sandbox checkout serializes per-test. async:
  # true still works — Sandbox owns the conn per test; concurrency
  # comes from interleaved checkouts, not concurrent file writes.
  pool_size: 1,
  busy_timeout: 30_000,
  # REV-B / C3 (2026-05-22 codebase review): pin PRAGMAs in lockstep
  # with config/runtime.exs and config/dev.exs. See runtime.exs for
  # the full rationale — dep major-version default flip would silently
  # subvert WAL durability or CASCADE FK invariants without a diff.
  synchronous: :normal,
  foreign_keys: :on,
  # CI runner is slower than local dev (single-vCPU + coveralls
  # instrumentation overhead). Default DBConnection queue_target=50ms /
  # queue_interval=1000ms triggers `queue_timeout` on Sandbox checkout
  # under sustained load even though the conn would have become
  # available shortly. Bumped both to give CI headroom; the cap is
  # still bounded so genuine deadlocks surface as failures rather
  # than infinite hangs.
  queue_target: 5_000,
  queue_interval: 30_000

config :grappa, GrappaWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "test-secret-key-base-replace-me-in-prod-12345678901234567890123456789012",
  # Mirror of dev.exs — codebase audit web W10 + cross-infra L7.
  session_signing_salt: "test-signing-salt-not-secret-fixed-for-deterministic-runs",
  server: false

config :logger, level: :warning

# Test-infra cluster (2026-05-12, post-mega-cluster): force ExUnit to
# run one test case at a time. The Application starts ONCE per
# `mix test` process, so `Grappa.Session.Backoff`,
# `Grappa.Admission.NetworkCircuit`, `Grappa.WSPresence`, and
# `Grappa.SessionRegistry` are singletons shared across every test.
# `Ecto.Adapters.SQL.Sandbox` covers the Repo, but those GenServer +
# ETS singletons have no per-test sandbox — two concurrent tests
# colliding on a recycled sqlite rowid (network_id) produce
# `{:error, :network_cap_exceeded}` instead of `{:ok, :spawned, _}`
# from `SpawnOrchestrator.spawn/4`, surfacing as intermittent CI
# failures across files that don't directly touch each other (bucket
# I `spawn_orchestrator_test:251` 2026-05-12 was the latest instance;
# bucket H `BootstrapTest:413`, lifecycle/S5 6-test fan-out, and
# spawn_orchestrator_test:157 were prior surfaces of the same class).
#
# Picking `max_cases: 1` over per-test singleton instances (the
# alternative considered) per CLAUDE.md "Lightweight over heavyweight":
# 1-line config beats touching 3 production GenServers + 30+ test
# setups for a class that surfaces ~once-per-mega-cluster. Acceptance
# criterion: ALL ci.yml + integration.yml GREEN ON FIRST RUN, no
# `gh run rerun --failed` ever (memory
# `feedback_no_ci_retries_on_first_failure`).
#
# Cost: ~22s async → ~45s sequential test-suite latency.
config :ex_unit, max_cases: 1

# Test runs invoke Grappa.Bootstrap explicitly via Bootstrap.run/0; we
# don't want the application start to autoload bound credentials and
# try to connect to real upstream IRC servers during `mix test`.
config :grappa, :start_bootstrap, false

# UX-6-B1 (2026-05-20): embedded image uploader storage dir for
# `mix test`. The Reaper child in the application supervisor mkdir_p's
# this at boot; per-test isolation comes from `start_supervised`-ing
# a fresh Reaper with a per-test temp dir, not from the global one.
# `MIX_TEST_PARTITION` partitions the global dir per test run so
# parallel CI shards don't collide.
config :grappa,
       :uploads_storage_root,
       Path.expand(
         "../runtime/uploads_test#{System.get_env("MIX_TEST_PARTITION")}",
         __DIR__
       )

# M-11 — AdminEvents telemetry attach disabled in test env. The global
# `:telemetry.attach_many/4` handler routes every admission event from
# every async test pid to the AdminEvents singleton; the singleton's
# `Wire.lookup_slug/1` Repo call then crashes because the sandbox
# connection is owned by the EMITTING test, not AdminEvents. Tests
# that exercise the telemetry adapter explicitly start the handler
# via `Process.whereis(AdminEvents) |> Ecto.Adapters.SQL.Sandbox.allow/3`
# (see `test/grappa/admin_events_test.exs`).
config :grappa, :attach_admin_telemetry, false
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

# Session.Backoff — shrink the curve so tests that exercise the
# delayed-start-client path (or accidentally touch the Backoff
# module) don't drag. The math (base × 2^(count-1) capped, ±25%
# jitter) is identical; only the magnitude shrinks.
config :grappa, :session_backoff,
  base_ms: 5,
  cap_ms: 100

# Push notifications cluster B2 (2026-05-14) — fixed VAPID keypair for
# the `:web_push_elixir` library so `Push.Sender` tests don't need to
# generate a fresh pair per run (and so the lib's
# `Application.get_env(:web_push_elixir, ...)` reads succeed under
# `mix test`). Real ECDSA P-256 pair (NOT random bytes — JOSE.JWS
# rejects malformed keys at sign time, which would surface as
# misleading test failures). Non-secret + dev/test-only; rotating
# requires no operator action. Mirrored byte-for-byte by config/dev.exs
# (B5 added the dev mirror so the integration harness's MIX_ENV=dev
# grappa-test boots with VAPID set). When rotating, update both files
# in lockstep.
config :web_push_elixir,
  vapid_public_key: "BH4P62bQOEfkSsfjpCyBWnz88Nnlyn2mtwapDEXWswb1cwR9YDE-3E-aBjNhwY2e3ErL410rgSNUBD7nQyPXGSY",
  vapid_private_key: "MIC0fm1A_ZcPF0P3ffUizcNUYwMyU-AklNw2e4aPXGw",
  vapid_subject: "mailto:test@example.org"

# T31 NetworkCircuit — shrink threshold/window/cooldown so circuit-
# transition tests don't drag. Math is identical, only magnitudes
# shrink.
config :grappa, :admission,
  default_max_per_ip_per_network: 10,
  captcha_provider: Grappa.Admission.Captcha.Disabled,
  captcha_site_key: nil,
  network_circuit_threshold: 3,
  network_circuit_window_ms: 100,
  network_circuit_cooldown_ms: 50,
  # U-2 (UD7): default test budgets shrunk to keep timeout-path tests
  # snappy. Test-specific overrides ride the new `:login_*_timeout_ms`
  # opts on `Login.login/2`.
  login_connect_timeout_ms: 100,
  login_welcome_timeout_ms: 100,
  login_probe_timeout_ms: 500

# Cloak vault key — non-secret, test-only. Distinct from dev so a key
# leak in one env doesn't decrypt the other env's data. The test sqlite
# is wiped per-run via Sandbox.
config :grappa, Grappa.Vault,
  ciphers: [
    default:
      {Cloak.Ciphers.AES.GCM,
       tag: "AES.GCM.V1", key: Base.decode64!("Ot80AYbRqJG9htfEztMBqz6Eo9ALMWgu9Ze6w0CbbPg="), iv_length: 12}
  ]
