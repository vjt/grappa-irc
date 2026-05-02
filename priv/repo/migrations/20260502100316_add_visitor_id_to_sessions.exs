defmodule Grappa.Repo.Migrations.AddVisitorIdToSessions do
  @moduledoc """
  visitor_id additive migration on sessions (cluster visitor-auth Q-A).

  Adds a nullable `visitor_id` FK to `Grappa.Visitors.Visitor` and makes
  `user_id` nullable so a session row binds to either an authenticated
  user OR a visitor — never both, never neither. The XOR invariant is
  enforced at the DB level (CHECK constraint) and at the application
  layer (`Session.changeset/2` calls `validate_subject_xor/1`).

  ## SQLite limitations

  ecto_sqlite3 does not support `modify` (ALTER COLUMN) or
  `create constraint` (ALTER TABLE ADD CONSTRAINT). Making `user_id`
  nullable and adding a table-level XOR CHECK requires a full
  table-recreate via raw SQL — same pattern as Task 4's messages
  migration (20260502085339).
  """
  use Ecto.Migration

  def up do
    execute("ALTER TABLE sessions RENAME TO sessions_old")

    execute("""
    CREATE TABLE "sessions" (
      "id" TEXT PRIMARY KEY,
      "user_id" TEXT NULL CONSTRAINT "sessions_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "sessions_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "created_at" TEXT NOT NULL,
      "last_seen_at" TEXT NOT NULL,
      "revoked_at" TEXT NULL,
      "user_agent" TEXT NULL,
      "ip" TEXT NULL,
      CONSTRAINT "sessions_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    # Existing rows are all user-bound (visitor_id NULL satisfies XOR).
    execute("""
    INSERT INTO sessions (id, user_id, created_at, last_seen_at, revoked_at, user_agent, ip)
    SELECT id, user_id, created_at, last_seen_at, revoked_at, user_agent, ip
    FROM sessions_old
    """)

    execute("DROP TABLE sessions_old")

    create index(:sessions, [:user_id])
    create index(:sessions, [:last_seen_at])
    create index(:sessions, [:visitor_id])
  end

  def down do
    execute("ALTER TABLE sessions RENAME TO sessions_new")

    execute("""
    CREATE TABLE "sessions" (
      "id" TEXT PRIMARY KEY,
      "user_id" TEXT NOT NULL CONSTRAINT "sessions_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "created_at" TEXT NOT NULL,
      "last_seen_at" TEXT NOT NULL,
      "revoked_at" TEXT NULL,
      "user_agent" TEXT NULL,
      "ip" TEXT NULL
    )
    """)

    # Visitor-bound sessions are dropped on rollback (no user_id to project to).
    execute("""
    INSERT INTO sessions (id, user_id, created_at, last_seen_at, revoked_at, user_agent, ip)
    SELECT id, user_id, created_at, last_seen_at, revoked_at, user_agent, ip
    FROM sessions_new
    WHERE user_id IS NOT NULL
    """)

    execute("DROP TABLE sessions_new")

    create index(:sessions, [:user_id])
    create index(:sessions, [:last_seen_at])
  end
end
