defmodule Grappa.Repo.Migrations.SessionClientIdPartialIndex do
  use Ecto.Migration

  def change do
    drop_if_exists index(:sessions, [:client_id])

    create index(:sessions, [:client_id],
             where: "client_id IS NOT NULL AND revoked_at IS NULL",
             name: :sessions_client_id_active_index
           )
  end
end
