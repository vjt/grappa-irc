defmodule Grappa.Repo.Migrations.Init do
  use Ecto.Migration

  def change do
    create table(:networks, primary_key: false) do
      add :id, :string, primary_key: true
      add :user_name, :string, null: false
      add :host, :string, null: false
      add :port, :integer, null: false
      add :tls, :boolean, null: false
      add :nick, :string, null: false
      timestamps(type: :utc_datetime_usec)
    end

    create table(:channels, primary_key: false) do
      add :network_id, references(:networks, type: :string), null: false, primary_key: true
      add :name, :string, null: false, primary_key: true
      add :joined_at, :utc_datetime_usec, null: false
      timestamps(type: :utc_datetime_usec)
    end

    # Intentional: no FK from messages.network_id to networks.id.
    # Scrollback is operator-archival — when a network is removed from
    # grappa.toml, its historical messages stay so the operator can
    # re-add the network or audit history. Channels FK on (lifecycle
    # tied to network), messages don't.
    create table(:messages) do
      add :network_id, :string, null: false
      add :channel, :string, null: false
      add :server_time, :integer, null: false
      # `kind` enforcement lives at the schema layer via Ecto.Enum.
      # SQLite doesn't support ALTER TABLE ADD CONSTRAINT, and Ecto's
      # migration DSL doesn't expose inline column CHECK clauses for the
      # SQLite adapter, so a DB-level guard would need raw `execute/1`
      # — which trades reversibility + readability for a backstop against
      # a code path (raw SQL INSERT) that CLAUDE.md already forbids.
      add :kind, :string, null: false
      add :sender, :string, null: false
      add :body, :text, null: false
      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create index(:messages, [:network_id, :channel, :server_time])
  end
end
