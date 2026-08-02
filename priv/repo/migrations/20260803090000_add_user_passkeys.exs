defmodule Grappa.Repo.Migrations.AddUserPasskeys do
  use Ecto.Migration

  def change do
    alter table(:users) do
      add :passkey_mode, :string, null: false, default: "disabled"
    end

    rename table(:user_totp_recovery_codes), to: table(:user_recovery_codes)

    create table(:user_passkeys, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :credential_id, :binary, null: false
      add :public_key, :binary, null: false
      add :sign_count, :integer, null: false, default: 0
      add :name, :string, null: false
      add :transports, :map, null: false, default: %{}
      add :last_used_at, :utc_datetime_usec
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:user_passkeys, [:credential_id])
    create index(:user_passkeys, [:user_id])
  end
end
