defmodule Grappa.Repo.Migrations.CreateNotifyEntries do
  @moduledoc """
  GH #247 — `notify_entries`, the per-subject per-network presence
  watch list behind `/notify`.

  Shape mirrors `query_windows` (post-XOR): subject XOR FK (`user_id`
  XOR `visitor_id`, inline CHECK — SQLite can't `ALTER TABLE ADD
  CONSTRAINT`, so the table is created via raw DDL like
  `XorFkQueryWindows`), `network_id` FK, case-preserving `nick`
  column, and two partial unique **expression** indexes (one per
  subject branch) on `(<subject_id>, network_id, rfc1459-fold(nick))`
  (GH #121) so `FooBar`/`foobar` and `nick[1]`/`nick{1}` are one watch
  entry. The fold expression MUST stay character-identical to
  `Grappa.IRC.Identifier.nick_fold/1` and the context's
  conflict_target fragment, or SQLite drops the index.

  Presence STATE is not stored — the live online/offline map is
  session-owned; this table is only the durable list that survives
  reconnects.

  ## Cold deploy

  New migration — must be cold-deployed (hot path skips ecto.migrate).
  """
  use Ecto.Migration

  # rfc1459 fold of a column expression, pure SQL. Self-contained (no
  # module dep — see FoldVisitorsNickUniqueIndex for the rationale).
  defp fold(col) do
    "replace(replace(replace(replace(lower(#{col}), '[', '{'), ']', '}'), '\\', '|'), '~', '^')"
  end

  def up do
    execute("""
    CREATE TABLE "notify_entries" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "notify_entries_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "notify_entries_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "notify_entries_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "nick" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "notify_entries_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    create unique_index(:notify_entries, ["user_id", "network_id", "#{fold("nick")}"],
             name: :notify_entries_user_network_nick_folded_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:notify_entries, ["visitor_id", "network_id", "#{fold("nick")}"],
             name: :notify_entries_visitor_network_nick_folded_index,
             where: "visitor_id IS NOT NULL"
           )

    create index(:notify_entries, [:user_id], where: "user_id IS NOT NULL")
    create index(:notify_entries, [:visitor_id], where: "visitor_id IS NOT NULL")
    create index(:notify_entries, [:network_id])
  end

  def down do
    drop table(:notify_entries)
  end
end
