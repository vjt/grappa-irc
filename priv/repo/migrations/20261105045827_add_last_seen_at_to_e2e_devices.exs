defmodule Grappa.Repo.Migrations.AddLastSeenAtToE2eDevices do
  use Ecto.Migration

  # issue 2547: a browser that holds no keys for the account's identity
  # says when one of the devices grappa lists was last active, so the user
  # learns their keys live on somewhere before starting over. A device is
  # active when it reads its own inbox; the stamp moves at most once a
  # minute (`Grappa.E2eKeys.seen/1`). NULL for a device that has not read
  # it since this column exists.
  def change do
    alter table(:e2e_devices) do
      add :last_seen_at, :utc_datetime, null: true
    end
  end
end
