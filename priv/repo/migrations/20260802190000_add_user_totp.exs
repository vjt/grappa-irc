defmodule Grappa.Repo.Migrations.AddUserTotp do
  use Ecto.Migration

  def change do
    alter table(:users) do
      add :totp_secret_encrypted, :binary
      add :totp_enabled_at, :utc_datetime_usec
      add :totp_last_used_step, :integer
    end

    create table(:user_totp_recovery_codes, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :code_hash, :binary, null: false
      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create unique_index(:user_totp_recovery_codes, [:user_id, :code_hash])
  end
end
