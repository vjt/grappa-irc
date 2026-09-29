defmodule Grappa.Repo.Migrations.CreateDmConversations do
  @moduledoc """
  issue 1365 leg 1 — the `dm_conversations` table, and the nullable FK that
  every DM-keyed store (`messages`, `read_cursors`) grows onto it.

  ## What a row is

  One DM conversation of one subject on one network, minted on FIRST CONTACT
  (the first persisted row, or the first window open) and never deleted —
  except as the LOSER of a rename merge, whose rows have all moved to the
  survivor first. `peer_nick` is the RAW display spelling (the nick display
  rule, #121); the key is the expression `lower(peer_nick)`.

  "Window open" is STATE on the row, not the row's existence: `opened_at` is
  non-NULL while the query window is open and NULL once it is closed. Closing
  is an UPDATE. `query_windows` stays written beside it through legs 1-3
  (orchestrator ruling on the issue, Q3) — this table does not replace it yet.

  ## The fold-unique index is TOTAL (ruling T1, 2026-09-28)

  One partial unique index per subject branch, over every row, open and
  closed alike: one folded nick is one conversation, and a lookup can never
  be ambiguous. The partial predicate is the subject XOR split only — the
  `query_windows` / `read_cursors` shape — never an open-state filter.

  `lower(peer_nick)` MUST stay character-identical to
  `Grappa.IRC.Identifier.nick_fold_sql/1` (pinned by `IdentifierTest`), and
  to the `conflict_target` fragment in `Grappa.DmConversations`, or SQLite
  stops matching the index. Inlined because migrations run before `lib/`.

  ## The child FKs

  `messages.dm_conversation_id` and `read_cursors.dm_conversation_id`,
  nullable, `REFERENCES dm_conversations(id)` with the default NO ACTION: a
  conversation that still has children cannot be deleted, so a merge that
  forgot a row fails LOUDLY instead of orphaning it (`SET NULL` would have
  been the silent version of the same bug). Subject and network deletion
  still cascade, because the child rows go in the same statement.

  SQLite accepts `ADD COLUMN … REFERENCES` only with a NULL default, which is
  what a nullable FK is anyway: the column is metadata-only to add, and every
  existing row reads NULL until the backfill (the next migration) runs.

  The `messages` index is PARTIAL on `dm_conversation_id IS NOT NULL`. Of
  5,201,283 prod rows, ~33,640 are DM rows (orchestrator's census of a frozen
  prod copy, 2026-09-28), so a full index would carry millions of NULL
  entries nobody seeks. The partial index still serves the merge's
  `dm_conversation_id = ?` seek and the FK check on a parent DELETE, since an
  equality implies `IS NOT NULL`.

  ## Deploy — COLD, and the index build is the cost

  New migration file ⇒ cold. Building the partial index still SCANS every
  `messages` row once, under one write lock; it cannot be chunked. A peer
  timed an index on this column (whether PARTIAL like this one was not
  stated) at 4.54 s on a writable prod copy on a Pi 5 with a warm page
  cache — an order of magnitude, not m42's number (DESIGN_NOTES 2026-09-29,
  #1365a, with both limits). Indexing before the backfill is the cheaper
  order (5.18 s after), which is why the index lives here and not after the
  data migration.
  """
  use Ecto.Migration

  # The ASCII fold, pure SQL. MUST stay character-identical to
  # `Grappa.IRC.Identifier.nick_fold_sql/1`.
  @nick_fold "lower(peer_nick)"

  def up do
    execute("""
    CREATE TABLE "dm_conversations" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "dm_conversations_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "dm_conversations_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "dm_conversations_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "peer_nick" TEXT NOT NULL,
      "opened_at" TEXT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "dm_conversations_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    create unique_index(:dm_conversations, ["user_id", "network_id", @nick_fold],
             name: :dm_conversations_user_network_nick_folded_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:dm_conversations, ["visitor_id", "network_id", @nick_fold],
             name: :dm_conversations_visitor_network_nick_folded_index,
             where: "visitor_id IS NOT NULL"
           )

    # The network cascade's child seek; the two subject cascades ride the
    # leading column of the unique indexes above.
    create index(:dm_conversations, [:network_id])

    execute(
      "ALTER TABLE messages ADD COLUMN dm_conversation_id INTEGER NULL " <>
        "REFERENCES dm_conversations(id)"
    )

    execute(
      "ALTER TABLE read_cursors ADD COLUMN dm_conversation_id INTEGER NULL " <>
        "REFERENCES dm_conversations(id)"
    )

    create index(:messages, [:dm_conversation_id],
             name: :messages_dm_conversation_id_index,
             where: "dm_conversation_id IS NOT NULL"
           )

    create index(:read_cursors, [:dm_conversation_id],
             name: :read_cursors_dm_conversation_id_index,
             where: "dm_conversation_id IS NOT NULL"
           )
  end

  def down do
    drop index(:read_cursors, [:dm_conversation_id], name: :read_cursors_dm_conversation_id_index)
    drop index(:messages, [:dm_conversation_id], name: :messages_dm_conversation_id_index)
    execute("ALTER TABLE read_cursors DROP COLUMN dm_conversation_id")
    execute("ALTER TABLE messages DROP COLUMN dm_conversation_id")
    execute("DROP TABLE dm_conversations")
  end
end
