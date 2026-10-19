defmodule Grappa.Repo.Migrations.CreateE2eKeys do
  use Ecto.Migration

  # issue 2430 — the key bundle grappa hosts so it can answer a peer's
  # KEYREQ while no client of the subject is connected. Each row is one
  # whole KEYS payload the client built and signed: one per one-time key,
  # handed out once and deleted, and at most one fallback key per
  # (subject, network), handed out when the one-time keys run out. grappa
  # never reads a payload.
  #
  # Raw SQL for the table body, like `create_e2e_inbox`: the subject XOR
  # and the kind set are CHECK constraints, which `Ecto.Migration`'s DSL
  # cannot express inline. `payload` is last for the same reason as there:
  # the count and the oldest-key lookup never read one.
  def change do
    execute(
      """
      CREATE TABLE "e2e_keys" (
        "id" INTEGER PRIMARY KEY,
        "user_id" TEXT NULL CONSTRAINT "e2e_keys_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
        "visitor_id" TEXT NULL CONSTRAINT "e2e_keys_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
        "network_id" INTEGER NOT NULL CONSTRAINT "e2e_keys_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
        "kind" TEXT NOT NULL,
        "inserted_at" TEXT NOT NULL,
        "payload" TEXT NOT NULL,
        CONSTRAINT "e2e_keys_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL)),
        CONSTRAINT "e2e_keys_kind" CHECK (kind IN ('otk', 'fallback'))
      )
      """,
      ~s{DROP TABLE "e2e_keys"}
    )

    # Every read is one (subject, network) partition, by kind, oldest first.
    create index(:e2e_keys, [:user_id, :network_id, :kind, :id])
    create index(:e2e_keys, [:visitor_id, :network_id, :kind, :id])

    # One fallback key per (subject, network). A NULL subject column never
    # collides in SQLite, so each subject kind needs its own index.
    create unique_index(:e2e_keys, [:user_id, :network_id],
             where: "kind = 'fallback'",
             name: :e2e_keys_user_fallback_index
           )

    create unique_index(:e2e_keys, [:visitor_id, :network_id],
             where: "kind = 'fallback'",
             name: :e2e_keys_visitor_fallback_index
           )
  end
end
