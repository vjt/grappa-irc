defmodule Grappa.Repo.Migrations.CreateSessionLogEvents do
  @moduledoc """
  #215 — persisted IRC session-lifecycle log. One row per lifecycle
  transition (connect / register / +r / -r / disconnect / backoff),
  written by the `Grappa.SessionLog` sink from the
  `[:grappa, :session, :log, _]` telemetry stream.

  Disk-backed so the log survives a restart (the in-Logger line is the
  reliable real-time record; this table is the browsable/tailable history
  the admin viewer reads). Bounded by an on-insert prune in the sink
  (newest `retention` rows kept) — an on-disk ring buffer.

  ## Hot deploy

  New table only. BUT #215 ALSO adds a new supervised child
  (`Grappa.SessionLog` sink) + a Logger metadata allowlist change →
  the feature as a whole is COLD (cluster + config). The migration alone
  is idempotent + additive.
  """
  use Ecto.Migration

  def change do
    create table(:session_log_events) do
      add :session_id, :string, null: false
      add :event, :string, null: false
      add :subject_kind, :string, null: false
      add :network_id, :integer, null: false
      add :network_slug, :string
      add :nick, :string
      # Disconnect extras.
      add :reason, :string
      add :clean, :boolean
      add :duration_ms, :integer
      # Backoff extras.
      add :delay_ms, :integer
      add :attempt, :integer
      # Event wall-clock time (captured at emit, persist-reliable).
      add :at, :utc_datetime_usec, null: false
    end

    # Tail read (list/1) is newest-first by id (PK) — already covered.
    # These support the future per-network / per-session filtered views
    # the admin viewer may add ("this network's disconnects", "this
    # session's history").
    create index(:session_log_events, [:network_id])
    create index(:session_log_events, [:session_id])
  end
end
