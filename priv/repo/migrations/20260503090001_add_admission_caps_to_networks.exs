defmodule Grappa.Repo.Migrations.AddAdmissionCapsToNetworks do
  use Ecto.Migration

  def change do
    alter table(:networks) do
      add :max_concurrent_sessions, :integer, null: true
      add :max_per_client, :integer, null: true
    end
  end
end
