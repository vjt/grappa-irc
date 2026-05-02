defmodule Grappa.Repo.Migrations.CreateVisitorChannels do
  use Ecto.Migration

  def change do
    create table(:visitor_channels, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :visitor_id, references(:visitors, type: :binary_id, on_delete: :delete_all), null: false
      add :network_slug, :string, null: false
      add :name, :string, null: false

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:visitor_channels, [:visitor_id, :network_slug, :name])
    create index(:visitor_channels, [:visitor_id])
  end
end
