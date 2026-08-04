defmodule Grappa.PasskeyMigrationSmokeRepo do
  use Ecto.Repo, otp_app: :grappa, adapter: Ecto.Adapters.SQLite3
end

defmodule Grappa.Migrations.AddUserPasskeysTest do
  use ExUnit.Case, async: false

  alias Grappa.PasskeyMigrationSmokeRepo, as: SmokeRepo

  @totp_version 20_260_802_190_000
  @passkey_version 20_260_803_090_000

  @timestamp "2026-01-01T00:00:00Z"
  @user_a "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  @user_b "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  @key_1 "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  @key_2 "ffffffff-ffff-4fff-8fff-ffffffffffff"

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

  # Columns existing is not the claim worth making — the constraints are.
  # These assert what the database REFUSES, in the shape of the incident
  # each constraint exists to prevent, rather than reading the declaration
  # back out of the catalogue. The smoke repo runs with `foreign_keys: :on`
  # (see setup), so the FK is actually enforced here and not merely
  # recorded.
  describe "constraints the migration creates" do
    setup %{migrations: migrations} do
      assert [@passkey_version] =
               Ecto.Migrator.run(SmokeRepo, migrations, :up, to: @passkey_version, log: false)

      :ok
    end

    test "one credential id belongs to at most one account, across accounts" do
      insert_user!(@user_a, "alice")
      insert_user!(@user_b, "bob")
      insert_passkey!(@key_1, @user_a, <<1, 2, 3>>)

      # The incident: without `unique_index(:user_passkeys, [:credential_id])`
      # two accounts hold the same credential id and
      # `Repo.get_by(Passkey, credential_id: ..., user_id: ...)` starts
      # resolving ambiguously. A unique index over [credential_id, user_id]
      # would allow exactly this, so the second row must be someone ELSE's.
      assert_raise Exqlite.Error, ~r/UNIQUE constraint failed: user_passkeys\.credential_id/, fn ->
        insert_passkey!(@key_2, @user_b, <<1, 2, 3>>)
      end
    end

    test "deleting an account takes its passkeys with it" do
      insert_user!(@user_a, "alice")
      insert_user!(@user_b, "bob")
      insert_passkey!(@key_1, @user_a, <<1, 2, 3>>)
      insert_passkey!(@key_2, @user_b, <<4, 5, 6>>)

      query!("DELETE FROM users WHERE id = ?", [@user_a])

      # Without `on_delete: :delete_all` this row outlives the account it
      # authenticated — a live credential belonging to nobody.
      assert %{rows: [[@key_2]]} = query!("SELECT id FROM user_passkeys")
    end

    test "every passkey column but the optional one is NOT NULL" do
      # Asserted as a whole set, so a column losing `null: false` and a
      # column gaining it are both loud. `id` is absent on purpose: SQLite
      # does not imply NOT NULL for a non-INTEGER PRIMARY KEY, so the
      # binary_id key reads as nullable here — a quirk of the engine, not
      # a defect of this migration, and pinning it keeps the next reader
      # from "fixing" it.
      assert not_null_columns("user_passkeys") ==
               MapSet.new(~w[
                 user_id credential_id public_key sign_count name transports inserted_at updated_at
               ])
    end
  end

  # `change` is only as reversible as its least reversible step, and this
  # migration's middle step is a table RENAME — the one most likely to
  # strand a database halfway. Rolling back and forward proves the down
  # path exists AND that the constraints come back with the second up:
  # re-running the refusal is the assertion, because a table restored
  # without its unique index would satisfy any column-shaped check.
  test "down reverses the rename, the table and the column; up restores the constraint", %{
    migrations: migrations
  } do
    insert_user!(@user_a, "alice")
    assert [@passkey_version] = Ecto.Migrator.run(SmokeRepo, migrations, :up, to: @passkey_version, log: false)
    insert_passkey!(@key_1, @user_a, <<1, 2, 3>>)

    assert [@passkey_version] = Ecto.Migrator.run(SmokeRepo, migrations, :down, step: 1, log: false)

    refute "user_passkeys" in tables()
    refute "user_recovery_codes" in tables()
    assert "user_totp_recovery_codes" in tables()
    refute "passkey_mode" in columns("users")
    assert %{rows: [["alice"]]} = query!("SELECT name FROM users WHERE id = ?", [@user_a])

    assert [@passkey_version] = Ecto.Migrator.run(SmokeRepo, migrations, :up, to: @passkey_version, log: false)

    assert "user_recovery_codes" in tables()
    assert %{rows: [["disabled"]]} = query!("SELECT passkey_mode FROM users WHERE id = ?", [@user_a])

    insert_user!(@user_b, "bob")
    insert_passkey!(@key_1, @user_a, <<1, 2, 3>>)

    assert_raise Exqlite.Error, ~r/UNIQUE constraint failed: user_passkeys\.credential_id/, fn ->
      insert_passkey!(@key_2, @user_b, <<1, 2, 3>>)
    end
  end

  defp insert_user!(id, name) do
    query!("INSERT INTO users (id,name,password_hash,is_admin,inserted_at,updated_at) VALUES (?,?,?,?,?,?)", [
      id,
      name,
      "hash",
      0,
      @timestamp,
      @timestamp
    ])
  end

  defp insert_passkey!(id, user_id, credential_id) do
    query!(
      """
      INSERT INTO user_passkeys
        (id,user_id,credential_id,public_key,sign_count,name,transports,inserted_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      """,
      [id, user_id, credential_id, <<9, 9, 9>>, 0, "key", "{}", @timestamp, @timestamp]
    )
  end

  defp not_null_columns(table) do
    ~s|SELECT name FROM pragma_table_info(?) WHERE "notnull" = 1|
    |> query!([table])
    |> Map.fetch!(:rows)
    |> List.flatten()
    |> MapSet.new()
  end

  defp columns(table) do
    "SELECT name FROM pragma_table_info(?)" |> query!([table]) |> Map.fetch!(:rows) |> List.flatten()
  end

  defp tables do
    "SELECT name FROM sqlite_master WHERE type = 'table'" |> query!() |> Map.fetch!(:rows) |> List.flatten()
  end

  defp query!(sql, params \\ []), do: Ecto.Adapters.SQL.query!(SmokeRepo, sql, params)
end
