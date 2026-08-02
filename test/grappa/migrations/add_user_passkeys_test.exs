defmodule Grappa.PasskeyMigrationSmokeRepo do
  use Ecto.Repo, otp_app: :grappa, adapter: Ecto.Adapters.SQLite3
end

defmodule Grappa.Migrations.AddUserPasskeysTest do
  use ExUnit.Case, async: false

  alias Grappa.PasskeyMigrationSmokeRepo, as: SmokeRepo

  @totp_version 20_260_802_190_000
  @passkey_version 20_260_803_090_000

  setup do
    path = Path.join(System.tmp_dir!(), "grappa-passkey-migration-#{System.unique_integer([:positive])}.db")
    Application.put_env(:grappa, SmokeRepo, database: path, pool_size: 1, foreign_keys: :on)
    start_supervised!(SmokeRepo)
    migrations = Application.app_dir(:grappa, "priv/repo/migrations")
    Ecto.Migrator.run(SmokeRepo, migrations, :up, to: @totp_version, log: false)

    on_exit(fn ->
      Application.delete_env(:grappa, SmokeRepo)
      File.rm(path)
      File.rm(path <> "-shm")
      File.rm(path <> "-wal")
    end)

    %{migrations: migrations}
  end

  test "preserves populated users and TOTP recovery rows", %{migrations: migrations} do
    user_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    code_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    query!("INSERT INTO users (id,name,password_hash,is_admin,inserted_at,updated_at) VALUES (?,?,?,?,?,?)", [
      user_id,
      "legacy",
      "hash",
      0,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z"
    ])

    query!("INSERT INTO user_totp_recovery_codes (id,user_id,code_hash,inserted_at) VALUES (?,?,?,?)", [
      code_id,
      user_id,
      <<1, 2, 3>>,
      "2026-01-01T00:00:00Z"
    ])

    assert [@passkey_version] = Ecto.Migrator.run(SmokeRepo, migrations, :up, to: @passkey_version, log: false)
    assert %{rows: [["disabled"]]} = query!("SELECT passkey_mode FROM users WHERE id = ?", [user_id])
    assert %{rows: [[^code_id, ^user_id]]} = query!("SELECT id,user_id FROM user_recovery_codes")
    assert %{rows: [[0]]} = query!("SELECT COUNT(*) FROM user_passkeys")
  end

  defp query!(sql, params \\ []), do: Ecto.Adapters.SQL.query!(SmokeRepo, sql, params)
end
