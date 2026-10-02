defmodule Grappa.Repo.Migrations.DropDmConversations do
  @moduledoc """
  issue 1365 C5 — retire `dm_conversations` and the two child FK columns
  (`messages.dm_conversation_id`, `read_cursors.dm_conversation_id`).

  The table was the identity for leg 3 (DM windows keyed by id instead of
  nick). The ruling on issue 1365 that a nick change writes nothing to the
  DB made leg 3 moot, and nothing ever read the table or the FK.

  ## Why this is CONDITIONAL

  The two migrations that built the shape (`…001416_create_dm_conversations`,
  `…001417_backfill_dm_conversations`) were DELETED in the same change rather
  than kept and undone here: no release tag contains them, so a database that
  never ran them would otherwise pay for an index build over every
  `messages` row, a backfill, and a `DROP COLUMN` that rewrites `messages`
  again — all under the write lock, for a shape that ends up gone.

  So a database reaches this file in one of two states, and both end in the
  same schema:

    * it APPLIED the deleted pair (a dev or test database that ran `main`
      between 2026-09-29 and this change): everything is dropped, the child
      rows stay;
    * it NEVER did (fresh databases, and production if it never deployed
      them): every statement finds nothing, and the run is a no-op.

  A version in `schema_migrations` with no file is reported, never refused,
  by `Grappa.Deploy.MigrationAudit`, so the first state migrates cleanly.

  ⚠️ **Production is the one database whose state is not known here.** No
  tag contains the pair, but production pulls origin/main, not tags. If it
  ran main between 2026-09-29 and this change, it is in the FIRST state, and
  this migration then rewrites `messages` (~5.2M rows) with `DROP COLUMN`
  under the write lock during the cold deploy. Before deploying, read
  `SELECT version FROM schema_migrations WHERE version IN (20260929001416,
  20260929001417)` on the production database: empty means a no-op.

  ## Order is load-bearing

  Indexes first: SQLite refuses `ALTER TABLE … DROP COLUMN` on a column a
  partial index still names (`error in index … after drop column`, measured
  on 3.53.3), while the column's `REFERENCES` clause does NOT block it. Then
  the columns, so nothing references `dm_conversations` any more, then the
  table.

  `down/0` is a no-op: the shape this removes has no code left that writes or
  reads it.
  """
  use Ecto.Migration

  @indexes [
    "messages_dm_conversation_id_index",
    "read_cursors_dm_conversation_id_index",
    "dm_conversations_user_network_nick_folded_index",
    "dm_conversations_visitor_network_nick_folded_index",
    "dm_conversations_network_id_index"
  ]

  @child_tables ["messages", "read_cursors"]

  def up do
    Enum.each(@indexes, &execute(~s|DROP INDEX IF EXISTS "#{&1}"|))

    for table <- @child_tables, column?(table, "dm_conversation_id") do
      execute(~s|ALTER TABLE "#{table}" DROP COLUMN dm_conversation_id|)
    end

    execute(~s|DROP TABLE IF EXISTS "dm_conversations"|)
  end

  def down, do: :ok

  # Read now, before the queued drops run: no statement above changes whether
  # a column EXISTS, so the answer cannot go stale.
  defp column?(table, column) do
    %{rows: rows} =
      repo().query!("SELECT 1 FROM pragma_table_info(?) WHERE name = ?", [table, column], log: false)

    rows != []
  end
end
