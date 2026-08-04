defmodule Grappa.TotpMigrationSmokeRepo do
  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3
end

defmodule Grappa.Migrations.AddUserTotpTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias Grappa.TotpMigrationSmokeRepo, as: SmokeRepo

  @previous_version 20_260_729_130_000
  @totp_version 20_260_802_190_000
  @row_count 5_000

  @timestamp "2026-01-01T00:00:00.000000Z"
  @user_a "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  @user_b "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  @code_1 "e0000000-0000-4000-8000-000000000001"
  @code_2 "e0000000-0000-4000-8000-000000000002"
  @code_3 "e0000000-0000-4000-8000-000000000003"
  @code_4 "e0000000-0000-4000-8000-000000000004"

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

    assert [["legacy-04200", "legacy-secret"]] ==
             query!("SELECT name, password_hash FROM users WHERE name = 'legacy-04200'").rows
  end

  # The row-preservation test above proves the migration does not lose
  # data. These prove the other half: that what it creates actually
  # refuses. Stated as the incident each constraint prevents rather than
  # as a reading of the catalogue — the smoke repo runs `foreign_keys: :on`
  # (see setup), so the FK is enforced here and not merely declared.
  describe "constraints the migration creates" do
    setup %{migrations_path: migrations_path} do
      assert [@totp_version] =
               Ecto.Migrator.run(SmokeRepo, migrations_path, :up, to: @totp_version, log: false)

      insert_user!(@user_a, "alice")
      insert_user!(@user_b, "bob")

      :ok
    end

    test "a recovery code is unique per account, not globally and not per account alone" do
      insert_recovery_code!(@code_1, @user_a, <<1, 2, 3>>)

      # Same account, different hash: an account holds ten of these, so a
      # unique index on [user_id] alone would break enrollment outright.
      insert_recovery_code!(@code_2, @user_a, <<4, 5, 6>>)

      # Different account, same hash: two people may draw the same code
      # and neither may lock the other out, so the index cannot be on
      # [code_hash] alone either.
      insert_recovery_code!(@code_3, @user_b, <<1, 2, 3>>)

      # Same account, same hash: the one combination that must not exist,
      # or a code already spent still opens the door.
      assert_raise Exqlite.Error, ~r/UNIQUE constraint failed/, fn ->
        insert_recovery_code!(@code_4, @user_a, <<1, 2, 3>>)
      end
    end

    test "deleting an account takes its recovery codes with it" do
      insert_recovery_code!(@code_1, @user_a, <<1, 2, 3>>)
      insert_recovery_code!(@code_2, @user_b, <<4, 5, 6>>)

      SQL.query!(SmokeRepo, "DELETE FROM users WHERE id = ?", [@user_a])

      assert query!("SELECT id FROM user_totp_recovery_codes").rows == [[@code_2]]
    end

    test "every recovery-code column is NOT NULL" do
      # Whole set, so a column losing `null: false` and a column gaining
      # it are equally loud. `id` is absent on purpose: SQLite does not
      # imply NOT NULL for a non-INTEGER PRIMARY KEY, so a binary_id key
      # reads as nullable — an engine quirk, not a defect here.
      assert not_null_columns("user_totp_recovery_codes") ==
               MapSet.new(~w[user_id code_hash inserted_at])
    end

    test "down drops the table and the user columns; up restores the constraint", %{
      migrations_path: migrations_path
    } do
      insert_recovery_code!(@code_1, @user_a, <<1, 2, 3>>)

      assert [@totp_version] =
               Ecto.Migrator.run(SmokeRepo, migrations_path, :down, step: 1, log: false)

      refute "user_totp_recovery_codes" in tables()
      refute "totp_secret_encrypted" in user_columns()
      refute "totp_enabled_at" in user_columns()
      refute "totp_last_used_step" in user_columns()
      # The accounts outlive the rollback; only what this migration added
      # goes away. Counted by id rather than in total, because the
      # migration graph seeds a `system` user of its own.
      assert [["alice"], ["bob"]] ==
               SQL.query!(
                 SmokeRepo,
                 "SELECT name FROM users WHERE id IN (?,?) ORDER BY name",
                 [@user_a, @user_b]
               ).rows

      assert [@totp_version] =
               Ecto.Migrator.run(SmokeRepo, migrations_path, :up, to: @totp_version, log: false)

      assert "totp_secret_encrypted" in user_columns()
      insert_recovery_code!(@code_1, @user_a, <<1, 2, 3>>)

      # The table came back — but a table restored without its unique
      # index would satisfy any column-shaped check, so the refusal is
      # the assertion.
      assert_raise Exqlite.Error, ~r/UNIQUE constraint failed/, fn ->
        insert_recovery_code!(@code_2, @user_a, <<1, 2, 3>>)
      end
    end
  end

  defp insert_user!(id, name) do
    SQL.query!(
      SmokeRepo,
      "INSERT INTO users (id, name, password_hash, is_admin, inserted_at, updated_at) VALUES (?,?,?,?,?,?)",
      [id, name, "hash", 0, @timestamp, @timestamp]
    )
  end

  defp insert_recovery_code!(id, user_id, code_hash) do
    SQL.query!(
      SmokeRepo,
      "INSERT INTO user_totp_recovery_codes (id, user_id, code_hash, inserted_at) VALUES (?,?,?,?)",
      [id, user_id, code_hash, @timestamp]
    )
  end

  defp not_null_columns(table) do
    SmokeRepo
    |> SQL.query!(~s|SELECT name FROM pragma_table_info(?) WHERE "notnull" = 1|, [table])
    |> Map.fetch!(:rows)
    |> List.flatten()
    |> MapSet.new()
  end

  defp tables do
    "SELECT name FROM sqlite_master WHERE type = 'table'" |> query!() |> Map.fetch!(:rows) |> List.flatten()
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

  defp query!(sql), do: SQL.query!(SmokeRepo, sql, [])
end
