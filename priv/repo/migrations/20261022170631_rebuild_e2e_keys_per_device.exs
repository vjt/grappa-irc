defmodule Grappa.Repo.Migrations.RebuildE2eKeysPerDevice do
  use Ecto.Migration

  # issue 2430, multi-device (wire v2, 2430 comment 6346236542): a key
  # bundle per DEVICE, no longer per (subject, network). Each row is one
  # one-time key or the fallback key of one device, as the key and the
  # device's signature over `"irc-e2e:v1:otk:" + key` — typed columns, no
  # longer a whole KEYS payload the client built, because a v2 KEYS covers
  # every listed device at once and grappa composes it per KEYREQ.
  #
  # Rebuilt, not altered: no release carries E2E (the last tag predates the
  # first 2430 commit), so there are no rows anywhere to carry over, and
  # the v1 rows could not be carried anyway (a v1 payload names no device).
  #
  # Ownership is the device's: the subject and the network are reached
  # through `device_id`, so a revoked device's keys go with its row
  # (`ON DELETE CASCADE`) and no second copy of the subject can drift from
  # the device's. `AUTOINCREMENT` stays load-bearing for the reason the v1
  # migration gives: a key is picked, then consumed by id, and a reused id
  # could hand out a key of a bundle that was replaced in between.
  def up do
    execute(~s{DROP TABLE "e2e_keys"})

    execute("""
    CREATE TABLE "e2e_keys" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "device_id" INTEGER NOT NULL CONSTRAINT "e2e_keys_device_id_fkey" REFERENCES "e2e_devices"("id") ON DELETE CASCADE,
      "kind" TEXT NOT NULL,
      "key" TEXT NOT NULL,
      "sig" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      CONSTRAINT "e2e_keys_kind" CHECK (kind IN ('otk', 'fallback'))
    )
    """)

    # Every read is one device's keys, by kind, oldest first.
    create index(:e2e_keys, [:device_id, :kind, :id])
    # One fallback key per device. Default index names throughout: SQLite
    # reports a violated unique index by its columns, so a changeset's
    # `unique_constraint/3` can only match the name derived from them.
    create unique_index(:e2e_keys, [:device_id], where: "kind = 'fallback'")
    # A key is stored once per device: a retried upload skips what it holds.
    create unique_index(:e2e_keys, [:device_id, :key])
  end

  def down do
    execute(~s{DROP TABLE "e2e_keys"})

    execute("""
    CREATE TABLE "e2e_keys" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "e2e_keys_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "e2e_keys_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "e2e_keys_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "kind" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "payload" TEXT NOT NULL,
      CONSTRAINT "e2e_keys_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL)),
      CONSTRAINT "e2e_keys_kind" CHECK (kind IN ('otk', 'fallback'))
    )
    """)

    create index(:e2e_keys, [:user_id, :network_id, :kind, :id])
    create index(:e2e_keys, [:visitor_id, :network_id, :kind, :id])

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
