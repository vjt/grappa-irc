defmodule Grappa.Repo.Migrations.CreateNetworks do
  use Ecto.Migration

  def change do
    # Drop the unused Phase 1 stub tables. `init.exs` provisioned
    # `networks` (string PK) + `channels` for an early plan that never
    # made it into code — the runtime read `grappa.toml` directly,
    # leaving these as orphan DDL with no schema or context. Phase 2
    # reuses the `networks` name for the real, irssi-shape design
    # below; rather than keep a dead table around or rename the new
    # one, we drop them here so the schema stays single-source.
    drop_if_exists table(:channels)
    drop_if_exists table(:networks)

    create table(:networks) do
      add :slug, :string, null: false

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:networks, [:slug])

    create table(:network_servers) do
      add :network_id, references(:networks, on_delete: :delete_all), null: false
      add :host, :string, null: false
      add :port, :integer, null: false
      add :tls, :boolean, null: false, default: true
      add :priority, :integer, null: false, default: 0
      add :enabled, :boolean, null: false, default: true

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:network_servers, [:network_id, :host, :port])
    create index(:network_servers, [:network_id])

    # Composite PK (user_id, network_id). `:restrict` on the network FK so
    # an orphaned credential can never silently lose its parent — the
    # cascade-on-empty path lives in `Grappa.Networks.unbind_credential/2`
    # so the LAST binding's removal explicitly tears down the network +
    # servers it pinned.
    create table(:network_credentials, primary_key: false) do
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all),
        null: false,
        primary_key: true

      add :network_id, references(:networks, on_delete: :restrict),
        null: false,
        primary_key: true

      add :nick, :string, null: false
      add :realname, :string, null: true
      add :sasl_user, :string, null: true
      add :password_encrypted, :binary, null: true
      add :auth_method, :string, null: false, default: "auto"
      add :auth_command_template, :text, null: true
      # sqlite has no array type; the schema layer codes/decodes JSON.
      add :autojoin_channels, :text, null: false, default: "[]"

      timestamps(type: :utc_datetime_usec)
    end

    create index(:network_credentials, [:user_id])
    create index(:network_credentials, [:network_id])
  end
end
