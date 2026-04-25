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
    # raw bytes that triggered a parse failure, supervision-tree pid.
    :command,
    :reason,
    :raw,
    :error,
    :pid,
    # Bootstrap summary: how many users we processed and how many
    # session starts succeeded vs. failed; the config path that was
    # (or wasn't) read.
    :path,
    :users,
    :started,
    :failed
  ]

import_config "#{config_env()}.exs"
