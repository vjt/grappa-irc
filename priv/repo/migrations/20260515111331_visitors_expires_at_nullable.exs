defmodule Grappa.Repo.Migrations.VisitorsExpiresAtNullable do
  @moduledoc """
  V7: NickServ-identified visitors persist forever — `commit_password/2`
  writes `expires_at = NULL` to mark a row as never-expires. The
  Reaper's IS-NOT-NULL guard (V5, `Grappa.Visitors.list_expired/0`)
  already skips NULL rows; this migration completes the design by
  flipping the column to nullable.

  Anon rows (`password_encrypted IS NULL`) keep their `now + 48h`
  value — no data backfill needed.

  ## SQLite limitations

  ecto_sqlite3 does not support `modify` (ALTER COLUMN). The canonical
  sqlite "rename + create + copy + drop" dance does NOT work cleanly
  here because `visitors` has SEVEN dependent tables with
  `REFERENCES visitors` FKs (`messages`, `sessions`, `visitor_channels`,
  `query_windows`, `push_subscriptions`, `user_settings`,
  `read_cursors`). Modern sqlite (>= 3.25) auto-rewrites those FK refs
  to point at the renamed `visitors_old` during the parent rename;
  dropping `visitors_old` would then leave seven dangling refs (the
  same trap solved in `20260504020002` by recreating each dependent —
  far too heavy here for a single column-nullability flip).

  The lighter, sqlite-documented path for "change column nullability
  without touching schema relationships" is the `PRAGMA writable_schema`
  hack: directly edit `sqlite_master` to remove `NOT NULL` from the
  `expires_at` column definition. Documented at
  https://www.sqlite.org/lang_altertable.html (section "Making Other
  Kinds Of Table Schema Changes" — "Step 4" alternative approach).

  ## Pool / connection caveat

  `PRAGMA writable_schema = ON` is connection-scoped. With Ecto's
  default pool (size > 1) a `execute("PRAGMA ...")` followed by a
  separate `execute("UPDATE ...")` may run on different pool
  connections — the PRAGMA is set on connection A, the UPDATE runs
  on connection B without it, and sqlite rejects with
  `table sqlite_master may not be modified`.

  Workaround: pass the PRAGMA + UPDATE + PRAGMA OFF + integrity_check
  as a single multi-statement query via `repo().query!/1` so they
  share one driver round-trip and one connection. `Exqlite` accepts
  semicolon-separated statements in a single execute. Wrapped in
  `repo().checkout/1` for belt-and-braces connection pinning.

  `@disable_ddl_transaction true` because `PRAGMA writable_schema`
  cannot toggle inside a transaction.
  """
  use Ecto.Migration

  @disable_ddl_transaction true
  @disable_migration_lock true

  def up do
    repo().checkout(fn ->
      repo().query!("PRAGMA writable_schema = ON")

      repo().query!("""
      UPDATE sqlite_master
      SET sql = REPLACE(sql, '"expires_at" TEXT NOT NULL', '"expires_at" TEXT NULL')
      WHERE type = 'table' AND name = 'visitors'
      """)

      repo().query!("PRAGMA writable_schema = OFF")
      repo().query!("PRAGMA integrity_check")
    end)
  end

  def down do
    # Identified visitors created post-V7 carry NULL `expires_at`.
    # Backfill them to a far-future timestamp so the NOT NULL flip
    # succeeds; the rollback DOES NOT preserve "never expires"
    # semantics — it materializes the synthetic infinity into a real
    # 1000-year window. Acceptable for a destructive rollback.
    repo().checkout(fn ->
      repo().query!(
        "UPDATE visitors SET expires_at = '9999-12-31 23:59:59.999999' WHERE expires_at IS NULL"
      )

      repo().query!("PRAGMA writable_schema = ON")

      repo().query!("""
      UPDATE sqlite_master
      SET sql = REPLACE(sql, '"expires_at" TEXT NULL', '"expires_at" TEXT NOT NULL')
      WHERE type = 'table' AND name = 'visitors'
      """)

      repo().query!("PRAGMA writable_schema = OFF")
      repo().query!("PRAGMA integrity_check")
    end)
  end
end
