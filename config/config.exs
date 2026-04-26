import Config

config :grappa,
  ecto_repos: [Grappa.Repo],
  generators: [timestamp_type: :utc_datetime_usec]

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
    # Bootstrap summary: how many users we processed and how many
    # session starts succeeded vs. failed; the config path that was
    # (or wasn't) read.
    :path,
    :users,
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
    # Bootstrap (Phase 2): per-user-skipped count when a TOML user
    # has no DB row — the operator must `mix grappa.create_user`
    # before grappa.toml-driven Bootstrap can spawn that user's
    # sessions. `:skipped` rides the structured "bootstrap done"
    # summary line, separate from `:failed` so operator response
    # ("create the user" vs "investigate the network") doesn't have
    # to grep warning lines to disambiguate.
    :networks,
    :skipped,
    # IRC client (Phase 2 sub-task 2f): SASL handshake numerics
    # (904 / 905 failures, etc.) ride this key so operator log search
    # can grep "sasl" + numeric in a single pass.
    :numeric
  ]

import_config "#{config_env()}.exs"
