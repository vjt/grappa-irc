import Config

config :grappa,
  ecto_repos: [Grappa.Repo],
  generators: [timestamp_type: :utc_datetime_usec]

# Visitor-auth cluster (Phase 4) defaults. `visitor_network` is the
# slug of the upstream IRC network anonymous visitors land on; W3
# `max_visitors_per_ip` is the per-source-IP active-visitor cap. Both
# are read via `Application.compile_env/2` from `Grappa.Visitors.Login`
# and `Grappa.Visitors.Reaper` (Task 22), so they MUST be defined at
# every compile env — `config/test.exs` overrides
# `max_visitors_per_ip` to 2 for the cap-exceeded test path. A `nil`
# `@visitor_network` at compile time narrows `Login.login/2`'s success
# typing to only `:network_unconfigured`, cascading "pattern can never
# match" warnings across `auth_controller.ex`'s error mapper.
config :grappa, :visitor_network, "azzurra"
config :grappa, :max_visitors_per_ip, 5

# Cluster visitor-auth hotfix: pre-crash throttle for `Grappa.IRC.Client`'s
# `handle_continue({:connect, _})` failure path. Read at compile-time via
# `Application.compile_env/3`; production default is 30_000 ms (~2 restart
# attempts per minute per session). The original 5_000 ms still autokilled
# under multi-session load (3 sessions × 0.2/s = 0.6/s sustained tripped
# azzurra's connection-rate filter), so 30_000 is the floor for safety
# margin even under cluster-restart cycling. `config/test.exs` shrinks
# this to 50 ms so the C2 init-non-blocking test stays snappy. Phase 5
# replaces with proper exponential backoff + per-session health.
config :grappa, :irc_client_connect_failure_sleep_ms, 30_000

# `Grappa.Session.Backoff` — per-(subject, network_id) exponential
# backoff curve for IRC reconnect after Session.Server crashes. Layer
# ABOVE the IRC.Client per-attempt throttle: failure count survives
# Session.Server's :transient restart so a k-line bouncing the
# bouncer's IP doesn't loop at restart-rate. See the module doc for
# the full curve table. `config/test.exs` shrinks both values so test
# delays don't drag.
config :grappa, :session_backoff,
  base_ms: 5_000,
  cap_ms: 30 * 60 * 1_000

# T31 admission control. Defaults match the design (CP11 S20 →
# CP11 S21 brainstorm). All values configurable per-env via
# config/runtime.exs at deployment time.
#
#   * default_max_per_client_per_network — global per-(client_id,
#     network_id) cap. Operator can override per-network via the
#     networks.max_per_client column.
#   * captcha_provider — module implementing Grappa.Admission.Captcha
#     behaviour. Disabled = always :ok (test/dev/private deployments).
#     Plan 2 adds Turnstile + HCaptcha modules.
#   * captcha_secret — provider's verify-side secret (env var in prod).
#   * captcha_site_key — provider's public site key (env var in prod;
#     Task 13.A). Read at request time by FallbackController so a
#     runtime.exs change picks up at boot without a recompile.
#   * login_probe_timeout_ms — Visitors.Login probe-connect budget.
#     3s default leaves nginx 30s upstream timeout plenty of slack.
#     Was hard-coded 8s pre-T31; Plan 2 wires this in.
#   * network_circuit_threshold / window_ms / cooldown_ms — see
#     Grappa.Admission.NetworkCircuit moduledoc.
config :grappa, :admission,
  default_max_per_client_per_network: 1,
  captcha_provider: Grappa.Admission.Captcha.Disabled,
  captcha_secret: nil,
  captcha_site_key: nil,
  login_probe_timeout_ms: 3_000,
  network_circuit_threshold: 5,
  network_circuit_window_ms: 60_000,
  network_circuit_cooldown_ms: 5 * 60_000

config :grappa, Grappa.Repo,
  adapter: Ecto.Adapters.SQLite3,
  database: "runtime/grappa_dev.db"

# Phoenix endpoint compile-time config — actual values set per-env.
config :grappa, GrappaWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: GrappaWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Grappa.PubSub

config :phoenix, :json_library, Jason

# Phoenix.Logger redacts these keys from the params it logs on every
# request + every Channels socket connect. The bearer token rides
# `?token=…` on the WS upgrade URL because Phoenix.Socket transports
# params as a query string — without this filter, the `[info] CONNECTED
# TO …` line prints the bearer verbatim. Bearer is the entire identity
# in this design; anything that lands in stdout persists across container
# restarts and ships out with any log forwarder. Per CLAUDE.md Security:
# "credentials … never logged."
config :phoenix, :filter_parameters, ["password", "token"]

config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [
    # Identity / location: who, where in the IRC topology, what HTTP request.
    :request_id,
    :user,
    :network,
    :channel,
    # Structured debug context: command being processed, error reason,
    # raw bytes that triggered a parse failure, supervision-tree pid,
    # inspect/1 of an unexpected mailbox message that hit a catch-all.
    :command,
    :reason,
    :raw,
    :error,
    :pid,
    :unexpected,
    # Bootstrap summary: how many credentials we enumerated and how
    # many session starts were freshly spawned, skipped (admission
    # cap-tripped or already-running idempotent NO-OP), or failed
    # (M-life-4 tri-counter — see Grappa.Bootstrap moduledoc).
    # `:visitors` is the parallel count for the visitor-respawn pass.
    :credentials,
    :visitors,
    :spawned,
    :skipped,
    :failed,
    # Per-IRC-event context: who/what an event refers to (KICK target,
    # NICK_CHANGE new-nick, MODE arg, etc. — mirrors the Meta.@known_keys
    # allowlist so the same shape that hits the DB also hits the log line.
    # Drift caught at test time by Grappa.Scrollback.MetaTest "known_keys
    # ↔ Logger metadata allowlist").
    :sender,
    :target,
    :new_nick,
    :modes,
    :args,
    # Auth context (Phase 2): bearer-token session lifecycle. `session_id`
    # rides every authn-plug failure and revoke; `affected` rides the
    # revoke audit log so a typo'd-id revoke is greppable.
    :session_id,
    :affected,
    :authn_failure,
    # Visitor identity (Phase 4 — Task 15): visitor_id rides the
    # +r-observed → commit_password log lines so operator can grep
    # the visitor lifecycle across login + first-IDENTIFY.
    :visitor_id,
    # IRC client (Phase 2 sub-task 2f): SASL handshake numerics
    # (904 / 905 failures, etc.) ride this key so operator log search
    # can grep "sasl" + numeric in a single pass. `:sasl_user` is the
    # SASL identity the failed exchange used (NOT the password — the
    # struct redacts that). `:nick` rides nick-rejection (432/433)
    # log lines to surface the rejected nick directly.
    :numeric,
    :sasl_user,
    :nick,
    # Nick-mutation tracing (C6 / S13): on RPL_WELCOME reconcile and
    # self-NICK rename, log lines pair `from: old-nick, to: new-nick`
    # so the operator can grep the lifecycle of a nick across a
    # session — the Scrollback rows preserve the moment-of-write
    # nick, but the upstream-driven mutations only land in the log.
    :from,
    :to,
    # Session.Backoff context — observability for the exponential
    # delay applied before a Client respawn. `delay_ms` is the chosen
    # wait window; `failure_count` is the consecutive-failure depth
    # the curve fed off.
    :delay_ms,
    :failure_count,
    # T31 admission — rides admission rejection / circuit transition log
    # lines so operator can grep cap-exceeded events.
    :cap_kind,
    :cap_value,
    :cap_observed,
    :circuit_state,
    :retry_after_seconds
  ]

import_config "#{config_env()}.exs"
