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
    # many session starts succeeded vs. failed.
    :credentials,
    :started,
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
    :to
  ]

import_config "#{config_env()}.exs"
