defmodule Grappa.Repo.Migrations.CreateSessions do
  use Ecto.Migration

  def change do
    # No `timestamps()` here — sessions has explicit `created_at` +
    # `last_seen_at` semantics distinct from inserted_at/updated_at, and
    # mixing the two would invite confusion at the schema layer about
    # which timestamp the sliding-7d-idle policy reads.
    create table(:sessions, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :created_at, :utc_datetime_usec, null: false
      add :last_seen_at, :utc_datetime_usec, null: false
      add :revoked_at, :utc_datetime_usec, null: true
      add :user_agent, :text, null: true
      add :ip, :string, null: true
    end

    create index(:sessions, [:user_id])
    # last_seen_at index supports the Phase 5 housekeeping cron that
    # purges idle-expired rows in bulk.
    create index(:sessions, [:last_seen_at])
  end
end
