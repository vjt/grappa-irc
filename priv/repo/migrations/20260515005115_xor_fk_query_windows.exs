defmodule Grappa.Repo.Migrations.XorFkQueryWindows do
  @moduledoc """
  visitor-parity V1.a — promotes `query_windows` to the XOR FK shape.

  Mirror of `20260502085339_add_visitor_id_to_messages` and
  `20260513133825_create_read_cursors`. `ecto_sqlite3` rejects `modify`
  on existing columns and `create constraint` on existing tables —
  ALTER TABLE ADD CONSTRAINT is unsupported by SQLite — so the only
  path is the table-recreate dance:

    1. Rename existing table.
    2. Create new table with nullable user_id, additive visitor_id FK,
       inline XOR CHECK constraint.
    3. INSERT-SELECT preserves existing rows (all carry `user_id NOT
       NULL` today, so visitor_id = NULL satisfies the new XOR).
    4. Drop temp table.
    5. Rebuild partial unique indexes (one per subject branch) +
       per-subject FK lookup indexes.
  """
  use Ecto.Migration

  def up do
    execute("ALTER TABLE query_windows RENAME TO query_windows_old")

    execute("""
    CREATE TABLE "query_windows" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "query_windows_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "query_windows_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "query_windows_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "target_nick" TEXT NOT NULL,
      "opened_at" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "query_windows_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    execute("""
    INSERT INTO query_windows
      (id, user_id, visitor_id, network_id, target_nick, opened_at, inserted_at, updated_at)
    SELECT
      id, user_id, NULL, network_id, target_nick, opened_at, inserted_at, updated_at
    FROM query_windows_old
    """)

    execute("DROP TABLE query_windows_old")

    create unique_index(:query_windows, ["user_id", "network_id", "lower(target_nick)"],
             name: :query_windows_user_network_nick_lower_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:query_windows, ["visitor_id", "network_id", "lower(target_nick)"],
             name: :query_windows_visitor_network_nick_lower_index,
             where: "visitor_id IS NOT NULL"
           )

    create index(:query_windows, [:user_id], where: "user_id IS NOT NULL")
    create index(:query_windows, [:visitor_id], where: "visitor_id IS NOT NULL")
    create index(:query_windows, [:network_id])
  end

  def down do
    execute("ALTER TABLE query_windows RENAME TO query_windows_new")

    execute("""
    CREATE TABLE "query_windows" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NOT NULL CONSTRAINT "query_windows_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "query_windows_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "target_nick" TEXT NOT NULL,
      "opened_at" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL
    )
    """)

    execute("""
    INSERT INTO query_windows
      (id, user_id, network_id, target_nick, opened_at, inserted_at, updated_at)
    SELECT
      id, user_id, network_id, target_nick, opened_at, inserted_at, updated_at
    FROM query_windows_new
    WHERE user_id IS NOT NULL
    """)

    execute("DROP TABLE query_windows_new")

    create unique_index(:query_windows, ["user_id", "network_id", "lower(target_nick)"],
             name: :query_windows_user_network_nick_lower_index
           )

    create index(:query_windows, [:user_id])
    create index(:query_windows, [:network_id])
  end
end
