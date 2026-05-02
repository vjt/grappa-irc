defmodule Grappa.Repo.Migrations.AddVisitorIdToMessages do
  @moduledoc """
  visitor_id additive migration on messages (cluster visitor-auth W2).

  Adds a nullable `visitor_id` FK and makes `user_id` nullable so a row
  can be owned by either an authenticated user OR a visitor — never both,
  never neither. The XOR invariant is enforced both at the DB level (CHECK
  constraint) and at the application layer (`Message.changeset/2` calls
  `validate_subject_xor/1`).

  ## SQLite limitations

  ecto_sqlite3 does not support `modify` (ALTER COLUMN) or
  `create constraint` (ALTER TABLE ADD CONSTRAINT) — SQLite's ALTER TABLE
  only supports `ADD COLUMN`. Making `user_id` nullable and adding a
  table-level XOR CHECK constraint requires a full table-recreate via raw
  SQL. This is the same pattern SQLite itself recommends for schema changes
  that aren't supported natively.

  The up/down pair uses SQLite's `ALTER TABLE ... RENAME` + `CREATE TABLE`
  + `INSERT INTO ... SELECT` dance:
    1. Rename old table to a temp name.
    2. Create new table with the updated schema.
    3. Copy all rows across.
    4. Drop the temp table.

  No rows exist in the dev DB at this point (Phase 1 walking skeleton).
  The copy step is O(0) in practice but is included for correctness.
  """
  use Ecto.Migration

  def up do
    # 1. Rename old table.
    execute("ALTER TABLE messages RENAME TO messages_old")

    # 2. Create new table with nullable user_id, visitor_id FK, XOR CHECK.
    execute("""
    CREATE TABLE "messages" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "channel" TEXT NOT NULL,
      "server_time" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "sender" TEXT NOT NULL,
      "body" TEXT NULL,
      "meta" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "user_id" TEXT NULL CONSTRAINT "messages_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "messages_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "messages_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT,
      CONSTRAINT "messages_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    # 3. Copy existing rows (user_id was NOT NULL before, so all existing
    #    rows satisfy the XOR constraint with visitor_id = NULL).
    execute("""
    INSERT INTO messages (id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, network_id)
    SELECT id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, network_id
    FROM messages_old
    """)

    # 4. Drop the old table.
    execute("DROP TABLE messages_old")

    # 5. Rebuild indexes.
    create index(:messages, [:user_id, :network_id, :channel, :server_time])
    create index(:messages, [:visitor_id])
  end

  def down do
    # 1. Rename new table.
    execute("ALTER TABLE messages RENAME TO messages_new")

    # 2. Restore original schema (user_id NOT NULL, no visitor_id, no CHECK).
    execute("""
    CREATE TABLE "messages" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "channel" TEXT NOT NULL,
      "server_time" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "sender" TEXT NOT NULL,
      "body" TEXT NULL,
      "meta" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "user_id" TEXT NOT NULL CONSTRAINT "messages_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "messages_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT
    )
    """)

    # 3. Copy rows that have a user_id (visitor-owned rows are dropped on rollback).
    execute("""
    INSERT INTO messages (id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, network_id)
    SELECT id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, network_id
    FROM messages_new
    WHERE user_id IS NOT NULL
    """)

    # 4. Drop new table.
    execute("DROP TABLE messages_new")

    # 5. Restore original index.
    create index(:messages, [:user_id, :network_id, :channel, :server_time])
  end
end
