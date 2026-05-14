defmodule Grappa.Repo.Migrations.XorFkUserSettings do
  @moduledoc """
  visitor-parity V1.c — promotes `user_settings` to the XOR FK shape.

  Same table-recreate dance as V1.a/b. The `data` JSON column +
  `:utc_datetime` (no `_usec`) timestamps are preserved verbatim
  from the original schema; only the user_id nullability + visitor_id
  FK + XOR CHECK are added.
  """
  use Ecto.Migration

  def up do
    execute("ALTER TABLE user_settings RENAME TO user_settings_old")

    execute("""
    CREATE TABLE "user_settings" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "user_settings_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "user_settings_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "data" TEXT NOT NULL DEFAULT '{}',
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "user_settings_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    execute("""
    INSERT INTO user_settings (id, user_id, visitor_id, data, inserted_at, updated_at)
    SELECT id, user_id, NULL, data, inserted_at, updated_at FROM user_settings_old
    """)

    execute("DROP TABLE user_settings_old")

    create unique_index(:user_settings, [:user_id],
             name: :user_settings_user_id_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:user_settings, [:visitor_id],
             name: :user_settings_visitor_id_index,
             where: "visitor_id IS NOT NULL"
           )
  end

  def down do
    execute("ALTER TABLE user_settings RENAME TO user_settings_new")

    execute("""
    CREATE TABLE "user_settings" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NOT NULL CONSTRAINT "user_settings_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "data" TEXT NOT NULL DEFAULT '{}',
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL
    )
    """)

    execute("""
    INSERT INTO user_settings (id, user_id, data, inserted_at, updated_at)
    SELECT id, user_id, data, inserted_at, updated_at FROM user_settings_new
    WHERE user_id IS NOT NULL
    """)

    execute("DROP TABLE user_settings_new")

    create unique_index(:user_settings, [:user_id])
  end
end
