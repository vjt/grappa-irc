defmodule Grappa.Repo.Migrations.CreateE2eInbox do
  use Ecto.Migration

  # issue 2430 — the offline queue for end-to-end encrypted messages. A
  # peer's whole message (reassembled from its lines, still ciphertext)
  # waits here until a client takes it and acknowledges it, or until it
  # expires. Not scrollback: nothing here is searchable, pushed or ever
  # shown as text, and every row is deleted once it is delivered.
  #
  # Raw SQL for the table body, like `create_dcc_files`: the subject XOR
  # and the verb set are CHECK constraints, which `Ecto.Migration`'s DSL
  # cannot express inline.
  #
  # `AUTOINCREMENT` is load-bearing. A client tells a redelivered message
  # from a new one by its `id`, and SQLite's plain rowid hands the largest
  # id out again once that row is deleted — which is exactly what an
  # acknowledgement does. With `AUTOINCREMENT` an id is never reused.
  #
  # `sender` is the RAW nick, like every nick column (CLAUDE.md, GH #121):
  # the per-sender cap folds it at read time with `lower()`, the same
  # expression `Grappa.IRC.Identifier.nick_fold/1` emits.
  def change do
    execute(
      """
      CREATE TABLE "e2e_inbox" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "user_id" TEXT NULL CONSTRAINT "e2e_inbox_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
        "visitor_id" TEXT NULL CONSTRAINT "e2e_inbox_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
        "network_id" INTEGER NOT NULL CONSTRAINT "e2e_inbox_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
        "sender" TEXT NOT NULL,
        "verb" TEXT NOT NULL,
        "msgid" TEXT NOT NULL,
        "payload" TEXT NOT NULL,
        "inserted_at" TEXT NOT NULL,
        CONSTRAINT "e2e_inbox_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL)),
        CONSTRAINT "e2e_inbox_verb" CHECK (verb IN ('keys', 'pkmsg', 'msg', 'nack'))
      )
      """,
      ~s{DROP TABLE "e2e_inbox"}
    )

    # Every read is one (subject, network) partition in id order: the
    # client's fetch, the cap check on insert, and the expiry sweep.
    create index(:e2e_inbox, [:user_id, :network_id, :id])
    create index(:e2e_inbox, [:visitor_id, :network_id, :id])
  end
end
