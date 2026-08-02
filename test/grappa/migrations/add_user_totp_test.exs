defmodule Grappa.TotpMigrationSmokeRepo do
  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3
end

defmodule Grappa.Migrations.AddUserTotpTest do
  use ExUnit.Case, async: false

  alias Grappa.TotpMigrationSmokeRepo, as: SmokeRepo

  @previous_version 20_260_729_130_000
  @totp_version 20_260_802_190_000
  @row_count 5_000

  setup do
    path = Path.join(System.tmp_dir!(), "grappa-totp-migration-#{System.unique_integer([:positive])}.db")

    Application.put_env(:grappa, SmokeRepo,
      database: path,
      pool_size: 2,
      busy_timeout: 30_000,
      foreign_keys: :on
    )

    start_supervised!(SmokeRepo)
    migrations_path = Application.app_dir(:grappa, "priv/repo/migrations")

    Ecto.Migrator.run(SmokeRepo, migrations_path, :up,
      to: @previous_version,
      log: false
    )

    on_exit(fn ->
      Application.delete_env(:grappa, SmokeRepo)
      File.rm(path)
      File.rm(path <> "-shm")
      File.rm(path <> "-wal")
    end)

    %{migrations_path: migrations_path}
  end

  test "upgrades a populated legacy database without changing existing rows", %{
    migrations_path: migrations_path
  } do
    seed_legacy_rows()

    assert scalar!("SELECT COUNT(*) FROM users") == @row_count + 1
    assert scalar!("SELECT COUNT(*) FROM sessions") == @row_count

    assert scalar!("SELECT SUM(length(password_hash)) FROM users WHERE name != 'system'") ==
             @row_count * 13

    refute "totp_secret_encrypted" in user_columns()

    assert [@totp_version] ==
             Ecto.Migrator.run(SmokeRepo, migrations_path, :up,
               to: @totp_version,
               log: false
             )

    assert scalar!("SELECT COUNT(*) FROM users") == @row_count + 1
    assert scalar!("SELECT COUNT(*) FROM sessions") == @row_count

    assert scalar!("SELECT SUM(length(password_hash)) FROM users WHERE name != 'system'") ==
             @row_count * 13

    assert scalar!("SELECT COUNT(*) FROM users WHERE totp_secret_encrypted IS NOT NULL") == 0
    assert scalar!("SELECT COUNT(*) FROM users WHERE totp_enabled_at IS NOT NULL") == 0
    assert scalar!("SELECT COUNT(*) FROM users WHERE totp_last_used_step IS NOT NULL") == 0
    assert scalar!("SELECT COUNT(*) FROM user_totp_recovery_codes") == 0

    assert "totp_secret_encrypted" in user_columns()
    assert "totp_enabled_at" in user_columns()
    assert "totp_last_used_step" in user_columns()

    assert %{name: "legacy-04200", password_hash: "legacy-secret"} =
             SmokeRepo.get_by(Grappa.Accounts.User, name: "legacy-04200")
  end

  defp seed_legacy_rows do
    query!("""
    WITH RECURSIVE n(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM n WHERE value < #{@row_count}
    )
    INSERT INTO users (id, name, password_hash, is_admin, inserted_at, updated_at)
    SELECT
      printf('00000000-0000-4000-8000-%012d', value),
      printf('legacy-%05d', value),
      'legacy-secret',
      0,
      '2026-01-01T00:00:00.000000Z',
      '2026-01-01T00:00:00.000000Z'
    FROM n
    """)

    query!("""
    INSERT INTO sessions (id, user_id, created_at, last_seen_at, user_agent, ip)
    SELECT
      printf('10000000-0000-4000-8000-%012d', rowid),
      id,
      '2026-01-01T00:00:00.000000Z',
      '2026-08-01T00:00:00.000000Z',
      'migration-smoke',
      '192.0.2.1'
    FROM users
    WHERE name != 'system'
    """)
  end

  defp user_columns do
    "PRAGMA table_info(users)"
    |> query!()
    |> Map.fetch!(:rows)
    |> Enum.map(&Enum.at(&1, 1))
  end

  defp scalar!(sql) do
    %{rows: [[value]]} = query!(sql)
    value
  end

  defp query!(sql), do: Ecto.Adapters.SQL.query!(SmokeRepo, sql, [])
end
