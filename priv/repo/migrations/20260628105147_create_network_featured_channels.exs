defmodule Grappa.Repo.Migrations.CreateNetworkFeaturedChannels do
  use Ecto.Migration

  def change do
    create table(:network_featured_channels) do
      add :network_id, references(:networks, on_delete: :delete_all), null: false
      add :name, :string, null: false
      add :description, :string, null: true
      add :position, :integer, null: false, default: 0
      add :enabled, :boolean, null: false, default: true

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:network_featured_channels, [:network_id, :name])
    create index(:network_featured_channels, [:network_id])
  end
end
