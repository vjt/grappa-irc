defmodule Grappa.Repo.Migrations.AllowNullPasswordHashOnUsers do
  @moduledoc """
  #1911c — `users.password_hash` becomes nullable: an OIDC-provisioned
  account's only credential is the provider's `sub`, so
  `Accounts.provision_user/1` inserts a row with NO hash
  (`User.provisioned_changeset/2` leaves the field `nil`, and
  `Accounts.verify_password/2` answers `{:error, :invalid_credentials}`
  on a nil hash instead of crashing Argon2).

  ## Why writable_schema, not the rename dance

  SQLite cannot drop a NOT NULL in place. The first attempt followed the
  `XorFkUserSettings` precedent — rename `users` out of the way under
  `PRAGMA legacy_alter_table=ON`, recreate, copy, drop — and both e2e
  runs died right AFTER the migration with
  `no such table: main.users_old` on the first `INSERT INTO sessions`:
  MEASURED on the bundled SQLite 3.53.3, `legacy_alter_table=ON` (the
  pragma reads back 1) does NOT suppress the REFERENCES rewrite while
  `PRAGMA foreign_keys=ON`, in or out of a transaction — only
  `foreign_keys=OFF` keeps the children put, and THAT pragma is a no-op
  inside the transaction ecto wraps a migration in. The rename therefore
  rewrote all ten ON DELETE CASCADE children onto the throwaway name,
  the DROP orphaned them, and the schema was poisoned the moment the
  rename landed.

  The fix is the `VisitorsExpiresAtNullable` (V7) precedent: the
  sqlite-documented `PRAGMA writable_schema` edit — REPLACE the column
  definition inside `sqlite_master` — which touches no child, moves no
  row, and needs no FK-off window.

  ## Pool caveats

  `PRAGMA writable_schema` is connection-scoped, so the PRAGMA + UPDATE
  pair must share one pooled connection: `repo().checkout/1` pins it
  (V7's finding, kept verbatim).

  A direct `sqlite_master` write does NOT bump the schema cookie, so a
  connection that already parsed the old `users` DDL keeps enforcing
  the NOT NULL from its cached schema. V7 could skip this because its
  migrate ran in a separate process; `Grappa.HotReload` runs the
  Migrator on the APP'S OWN pool and the editing connection goes right
  back to serving traffic — so this migration bumps `schema_version`
  explicitly, forcing every pooled connection (this one included) to
  reload.

  `@disable_ddl_transaction true` mirrors V7: the toggle is
  transaction-hostile, and with the whole body autocommitting per
  statement the single-statement UPDATE stays atomic on its own. The
  pre/post-shape asserts make a REPLACE that matched nothing fail
  loudly instead of reporting success over an unfixed schema.
  """

  use Ecto.Migration

  @disable_ddl_transaction true
  @disable_migration_lock true

  @not_null ~s("password_hash" TEXT NOT NULL)
  @nullable ~s("password_hash" TEXT NULL)

  def up do
    repo().checkout(fn ->
      assert_users_column!(@not_null)

      repo().query!("PRAGMA writable_schema = ON")

      repo().query!("""
      UPDATE sqlite_master
      SET sql = REPLACE(sql, '#{@not_null}', '#{@nullable}')
      WHERE type = 'table' AND name = 'users'
      """)

      repo().query!("PRAGMA writable_schema = OFF")

      bump_schema_version()
      assert_users_column!(@nullable)
      assert_no_violations()
    end)
  end

  def down do
    %{rows: [[n]]} =
      repo().query!("SELECT COUNT(*) FROM users WHERE password_hash IS NULL")

    if n > 0,
      do: raise("cannot restore NOT NULL: #{n} passwordless users exist")

    repo().checkout(fn ->
      assert_users_column!(@nullable)

      repo().query!("PRAGMA writable_schema = ON")

      repo().query!("""
      UPDATE sqlite_master
      SET sql = REPLACE(sql, '#{@nullable}', '#{@not_null}')
      WHERE type = 'table' AND name = 'users'
      """)

      repo().query!("PRAGMA writable_schema = OFF")

      bump_schema_version()
      assert_users_column!(@not_null)
      assert_no_violations()
    end)
  end

  # The stored CREATE TABLE must carry the expected column shape, so a
  # REPLACE whose arguments drifted from the real DDL fails the migration
  # instead of reporting success over an unfixed schema.
  defp assert_users_column!(snippet) do
    %{rows: [[sql]]} =
      repo().query!("SELECT sql FROM sqlite_master WHERE name = 'users'")

    if is_nil(sql) or not String.contains?(sql, snippet) do
      raise("users schema does not contain #{snippet}: #{inspect(sql)}")
    end
  end

  defp bump_schema_version do
    %{rows: [[version]]} = repo().query!("PRAGMA schema_version")
    repo().query!("PRAGMA schema_version = #{version + 1}")
  end

  defp assert_no_violations do
    %{rows: fk_rows} = repo().query!("PRAGMA foreign_key_check")
    if fk_rows != [], do: raise("users rebuild left foreign key violations")

    %{rows: [["ok"]]} = repo().query!("PRAGMA integrity_check")
    :ok
  end
end
