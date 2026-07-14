defmodule Grappa.Repo.Migrations.CreateVhosts do
  @moduledoc """
  #228 — per-subject vhost (source-bind) selection tables.

  Two tables sit ABOVE the existing source-bind path (the connect-time
  `ifaddr` bind in `Grappa.IRC.Client` + `network_servers.source_address`
  are untouched — the new layer only changes WHICH address resolves into
  the plan):

    * `vhosts` — the curated inventory. Each row is a host-bound IP
      literal (the universe comes from `:inet.getifaddrs/0`; the DB
      curates which become vhosts). `in_pool` = member of the
      auto-rotation pool that replaces the `GRAPPA_OUTBOUND_V6_POOL` env
      var (vjt 2026-07-14 — DB-driven, no env). `generally_available` =
      any subject may self-select it.
    * `vhost_grants` — per-subject grants (subject XOR FK, mirror of
      `user_settings` / `read_cursors`). A row grants `subject` the right
      to select `vhost`; `pinned = true` makes it an admin-forced fixed
      bind the subject can't change. Visitor grants CASCADE on visitor
      reap (#211 reaper interaction — release is automatic).

  ## Why raw SQL for `vhost_grants`

  The subject-XOR CHECK must be inline in the `CREATE TABLE` — SQLite
  rejects `ALTER TABLE ADD CONSTRAINT`, so the Ecto `create constraint`
  DSL can't add it after the fact. Same raw-`execute` shape as
  `20260515005117_xor_fk_user_settings.exs` and every other XOR table.

  ## Hot deploy

  New tables only — no reshape of an existing table, no new supervised
  child, no new config key (the env var is REMOVED, not added). A
  migration alone rides the hot path fine (`ecto.migrate` is idempotent);
  a cluster+migration combo would need COLD, but this ships as a
  migration-only + code change → HOT.
  """
  use Ecto.Migration

  def up do
    create table(:vhosts) do
      add :address, :string, null: false
      add :in_pool, :boolean, null: false, default: false
      add :generally_available, :boolean, null: false, default: false

      timestamps(type: :utc_datetime_usec)
    end

    # Address is the natural key — one curated row per host IP literal.
    create unique_index(:vhosts, [:address])
    # Hot path: `OutboundV6Pool` boot + resync selects the rotation set.
    create index(:vhosts, [:in_pool], where: "in_pool = 1")

    # Raw CREATE so the subject-XOR CHECK is inline (SQLite can't
    # ALTER TABLE ADD CONSTRAINT). Mirror of the user_settings XOR table.
    execute("""
    CREATE TABLE "vhost_grants" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "vhost_id" INTEGER NOT NULL CONSTRAINT "vhost_grants_vhost_id_fkey" REFERENCES "vhosts"("id") ON DELETE CASCADE,
      "user_id" TEXT NULL CONSTRAINT "vhost_grants_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "vhost_grants_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "pinned" BOOLEAN NOT NULL DEFAULT 0,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "vhost_grants_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    # One grant per (vhost, subject) — partial per branch so a user grant
    # and a visitor grant never collide on the NULL pair. Names follow the
    # ecto_sqlite3 column-derived pattern (`table_col1_col2_index`) —
    # SQLite reports unique violations by COLUMN, not constraint name, so
    # the adapter synthesizes this name; the changeset's `unique_constraint`
    # must reference the SAME string or the violation raises instead of
    # converting to `{:error, changeset}` (mirror of
    # `network_credentials_user_id_network_id_index`).
    create unique_index(:vhost_grants, [:vhost_id, :user_id],
             name: :vhost_grants_vhost_id_user_id_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:vhost_grants, [:vhost_id, :visitor_id],
             name: :vhost_grants_vhost_id_visitor_id_index,
             where: "visitor_id IS NOT NULL"
           )

    # Per-subject lookup (allowed-set resolution + reaper release audit).
    create index(:vhost_grants, [:user_id])
    create index(:vhost_grants, [:visitor_id])
  end

  def down do
    drop table(:vhost_grants)
    drop table(:vhosts)
  end
end
