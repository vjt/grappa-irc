defmodule Grappa.Repo.Migrations.CreateVisitors do
  use Ecto.Migration

  def change do
    create table(:visitors, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :nick, :string, null: false
      add :network_slug, :string, null: false
      add :password_encrypted, :binary
      add :expires_at, :utc_datetime_usec, null: false
      add :ip, :string

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:visitors, [:nick, :network_slug])
    create index(:visitors, [:expires_at])
    create index(:visitors, [:ip])
  end
end
