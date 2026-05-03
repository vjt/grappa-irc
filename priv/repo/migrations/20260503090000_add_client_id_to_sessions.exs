defmodule Grappa.Repo.Migrations.AddClientIdToSessions do
  use Ecto.Migration

  def change do
    alter table(:sessions) do
      add :client_id, :string, null: true
    end

    create index(:sessions, [:client_id])
  end
end
