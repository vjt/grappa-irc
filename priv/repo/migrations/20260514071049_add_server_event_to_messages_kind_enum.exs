defmodule Grappa.Repo.Migrations.AddServerEventToMessagesKindEnum do
  @moduledoc """
  no-silent-drops B6.11 (HIGH-7) — extend `messages.kind` CHECK
  constraint with `'server_event'`.

  ## Why

  EventRouter's catch-all (event_router.ex:1548) currently writes
  unhandled IRC verbs (KILL, WALLOPS, GLOBOPS, ERROR, CHGHOST,
  inbound INVITE, vendor verbs) as `kind: :notice` rows on `$server`
  with `meta.raw_verb` discriminating. `:notice` is a CONTENT kind:
  `@body_required_kinds` requires body, `@dm_with_eligible_kinds`
  permits DM peer info. Neither holds for these server-emitted
  events. The kind-enum is leaky: any future filter
  `kind in [:privmsg, :notice, :action]` for "human content"
  silently swallows server-event noise.

  This migration extends the closed-set `messages.kind` enum with
  `'server_event'` so the EventRouter catch-all can write the typed
  kind directly. Existing `:notice` rows where `meta.raw_verb` is
  set are reclassified in the same migration.

  ## sqlite limitation: table-recreate dance

  sqlite (and ecto_sqlite3) reject `ALTER TABLE ... DROP CONSTRAINT`
  and `ALTER TABLE ... ADD CONSTRAINT`. The canonical remedy is the
  table-recreate dance — established precedent in
  `20260504020002_check_constraints_caps_auth_method_messages_kind.exs`
  (`recreate_messages_with_check/0`).

  ## What gets recreated

  Per the M5 fragility flag at
  `20260507151920_add_dm_with_to_messages.exs:45-69` and the
  `20260508132130_messages_dm_with_subject_composite_indexes.exs`
  index split, the messages table CREATE block + index set has
  drifted since 2026-05-04. The recreate below brings forward the
  current state:

    * `dm_with TEXT NULL` column (CP14 B3)
    * 4 indexes: `(user_id, network_id, channel, server_time)`,
      `(visitor_id, network_id, channel, server_time)`,
      `(user_id, network_id, dm_with, server_time)`,
      `(visitor_id, network_id, dm_with, server_time)`
    * `messages_subject_xor` CHECK constraint
    * `kind_enum` CHECK constraint extended with `'server_event'`

  ## Dependent FK: `read_cursors.last_read_message_id`

  Sqlite >=3.25 auto-rewrites dependent FK ref text during
  `ALTER TABLE messages RENAME TO messages_old`:
  `read_cursors.last_read_message_id` (declared in
  `20260513133825_create_read_cursors.exs:71`
  with `ON DELETE SET NULL` to `messages.id`) gets rewritten to
  point at `messages_old`. Once we drop `messages_old`, that ref
  dangles — schema corruption surfacing on the next read_cursors
  insert/update OR the next session boot's loader.

  Same disease class the 2026-05-04 precedent fixed for
  `network_servers` (lines 36-61 of that migration). Same fix:
  rename `read_cursors → read_cursors_old`, CREATE fresh
  `read_cursors` with `REFERENCES "messages"` spelled out,
  INSERT/SELECT copy, DROP old, recreate the 3 surviving indexes
  (2 partial uniques + `(network_id)` — the
  `(last_read_message_id)` index was dropped by the immediately
  preceding `20260514064102_drop_unused_read_cursors_...` migration
  per HIGH-22, so the recreate MUST NOT re-add it).

  ## defer_foreign_keys + transaction discipline

  Same defer_foreign_keys=ON pattern as the precedent migration —
  sqlite >=3.25 auto-rewrites dependent FK refs during ALTER
  TABLE RENAME, so the messages_old → messages dance leaves no
  dangling refs as long as we defer FK checks to COMMIT. Auto-resets
  at end of transaction.

  ## Backfill: notice+raw_verb rows → server_event

  After the CREATE TABLE + data copy, an UPDATE WHERE
  `kind='notice' AND meta LIKE '%raw_verb%'` reclassifies historical
  catch-all rows to the typed kind. cic's `:notice` arm in
  ScrollbackPane delegates to `renderRawEvent` when `meta.raw_verb`
  is present; the new `:server_event` arm renders the same shape.
  Both arms coexist because backfill might miss edge cases (rows
  written after `CREATE TABLE` and before the UPDATE in the same
  migration — sqlite serializes within a transaction so this is
  defensive).

  ## Deploy classification

  Cold-deploy required:
    * `feedback_cluster_with_migration_must_cold` — deploy.sh hot
      path skips `mix ecto.migrate`.
    * `Message.@kinds` enum addition triggers the long-lived
      module shape preflight (Ecto.Enum loaders embed the enum
      list at compile time; a Phoenix.CodeReloader swap with a
      mid-flight schema produces deferred load crashes).
  """
  use Ecto.Migration

  def up do
    execute("PRAGMA defer_foreign_keys = ON")
    recreate_messages_with_extended_kind_enum()
    recreate_read_cursors_to_refresh_fk()
    backfill_notice_to_server_event()
  end

  def down do
    execute("PRAGMA defer_foreign_keys = ON")
    rollback_server_event_to_notice()
    recreate_messages_with_legacy_kind_enum()
    recreate_read_cursors_to_refresh_fk()
  end

  # ---------------------------------------------------------------------------
  # Recreate dance (forward)
  # ---------------------------------------------------------------------------

  defp recreate_messages_with_extended_kind_enum do
    execute("ALTER TABLE messages RENAME TO messages_old")

    execute("""
    CREATE TABLE "messages" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "channel" TEXT NOT NULL,
      "server_time" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "sender" TEXT NOT NULL,
      "body" TEXT NULL,
      "meta" TEXT NOT NULL,
      "dm_with" TEXT NULL,
      "inserted_at" TEXT NOT NULL,
      "user_id" TEXT NULL CONSTRAINT "messages_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "messages_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "messages_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT,
      CONSTRAINT "messages_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL)),
      CONSTRAINT "kind_enum" CHECK (kind IN ('privmsg','notice','action','join','part','quit','nick_change','mode','topic','kick','server_event'))
    )
    """)

    execute("""
    INSERT INTO messages (id, channel, server_time, kind, sender, body, meta, dm_with, inserted_at, user_id, visitor_id, network_id)
    SELECT id, channel, server_time, kind, sender, body, meta, dm_with, inserted_at, user_id, visitor_id, network_id
    FROM messages_old
    """)

    execute("DROP TABLE messages_old")

    create index(:messages, [:user_id, :network_id, :channel, :server_time])
    create index(:messages, [:visitor_id, :network_id, :channel, :server_time])
    create index(:messages, [:user_id, :network_id, :dm_with, :server_time])
    create index(:messages, [:visitor_id, :network_id, :dm_with, :server_time])
  end

  # Inline UPDATE — sqlite's `LIKE '%raw_verb%'` is a full-table scan
  # but messages volume is bounded to operator history (low-thousands
  # in dev, low-tens-of-thousands in prod; well under a second). No
  # index because this is a one-shot.
  defp backfill_notice_to_server_event do
    execute("""
    UPDATE messages
    SET kind = 'server_event'
    WHERE kind = 'notice'
      AND meta LIKE '%raw_verb%'
    """)
  end

  # ---------------------------------------------------------------------------
  # read_cursors recreate — fixes dangling FK ref text after the
  # messages rename. Mirror of the precedent's
  # `recreate_network_servers_to_refresh_fk/0`. NOT a CHECK addition;
  # purely re-spelling `REFERENCES "messages"` so the FK text resolves
  # to the live `messages` table at COMMIT.
  #
  # Index recreate: 2 partial uniques + `(network_id)`.
  # `(last_read_message_id)` index was dropped by the immediately-
  # preceding `20260514064102_drop_unused_read_cursors_...` migration
  # per HIGH-22 — DO NOT re-add it here. The CREATE TABLE block keeps
  # the column itself (NULL + ON DELETE SET NULL), just no index.
  # ---------------------------------------------------------------------------

  defp recreate_read_cursors_to_refresh_fk do
    execute("ALTER TABLE read_cursors RENAME TO read_cursors_old")

    execute("""
    CREATE TABLE "read_cursors" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "read_cursors_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "read_cursors_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "read_cursors_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "channel" TEXT NOT NULL,
      "last_read_message_id" INTEGER NULL CONSTRAINT "read_cursors_last_read_message_id_fkey" REFERENCES "messages"("id") ON DELETE SET NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "read_cursors_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    execute("""
    INSERT INTO read_cursors (id, user_id, visitor_id, network_id, channel, last_read_message_id, inserted_at, updated_at)
    SELECT id, user_id, visitor_id, network_id, channel, last_read_message_id, inserted_at, updated_at
    FROM read_cursors_old
    """)

    execute("DROP TABLE read_cursors_old")

    create unique_index(:read_cursors, [:user_id, :network_id, :channel],
             where: "user_id IS NOT NULL",
             name: :read_cursors_user_network_channel_index
           )

    create unique_index(:read_cursors, [:visitor_id, :network_id, :channel],
             where: "visitor_id IS NOT NULL",
             name: :read_cursors_visitor_network_channel_index
           )

    create index(:read_cursors, [:network_id])
  end

  # ---------------------------------------------------------------------------
  # Recreate dance (rollback)
  # ---------------------------------------------------------------------------

  defp rollback_server_event_to_notice do
    execute("""
    UPDATE messages
    SET kind = 'notice'
    WHERE kind = 'server_event'
    """)
  end

  defp recreate_messages_with_legacy_kind_enum do
    execute("ALTER TABLE messages RENAME TO messages_old")

    execute("""
    CREATE TABLE "messages" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "channel" TEXT NOT NULL,
      "server_time" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "sender" TEXT NOT NULL,
      "body" TEXT NULL,
      "meta" TEXT NOT NULL,
      "dm_with" TEXT NULL,
      "inserted_at" TEXT NOT NULL,
      "user_id" TEXT NULL CONSTRAINT "messages_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "messages_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "messages_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT,
      CONSTRAINT "messages_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL)),
      CONSTRAINT "kind_enum" CHECK (kind IN ('privmsg','notice','action','join','part','quit','nick_change','mode','topic','kick'))
    )
    """)

    execute("""
    INSERT INTO messages (id, channel, server_time, kind, sender, body, meta, dm_with, inserted_at, user_id, visitor_id, network_id)
    SELECT id, channel, server_time, kind, sender, body, meta, dm_with, inserted_at, user_id, visitor_id, network_id
    FROM messages_old
    """)

    execute("DROP TABLE messages_old")

    create index(:messages, [:user_id, :network_id, :channel, :server_time])
    create index(:messages, [:visitor_id, :network_id, :channel, :server_time])
    create index(:messages, [:user_id, :network_id, :dm_with, :server_time])
    create index(:messages, [:visitor_id, :network_id, :dm_with, :server_time])
  end
end
