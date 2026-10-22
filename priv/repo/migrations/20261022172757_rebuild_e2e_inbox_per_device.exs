defmodule Grappa.Repo.Migrations.RebuildE2eInboxPerDevice do
  use Ecto.Migration

  # issue 2430, multi-device (wire v2, 2430 comments 6346236542 and
  # 6346686730): the offline queue is per DEVICE, no longer per (subject,
  # network). A frame names the device it is for in `<to>`, and a message
  # to `*` carries a body for each of the user's devices: grappa queues one
  # row per device, and each device reads and acknowledges its own. The
  # bounds (4 MiB per device, 1 MiB of it per sender) and the 7-day expiry
  # are a2's, applied per device.
  #
  # Rebuilt, not altered: no release carries E2E (the last tag predates the
  # first 2430 commit), so there are no rows anywhere to carry over, and a
  # v1 row could not be carried anyway (it names no device).
  #
  # Ownership is the device's: the subject and the network are reached
  # through `device_id`, so a revoked device's queue goes with its row
  # (`ON DELETE CASCADE`). `from_did` is the sending device's id as the
  # frame named it, or `*` on a KEYS, which describes a user rather than a
  # device: the recipient needs it to address a NACK, and to check it
  # against the key that signed the message.
  #
  # `AUTOINCREMENT` and `payload` LAST keep the reasons the v1 migration
  # gives (`20261018205057_create_e2e_inbox.exs`): an acknowledged id is
  # never handed out again, and the cap check and the expiry never walk a
  # payload's overflow pages.
  def up do
    execute(~s{DROP TABLE "e2e_inbox"})

    execute("""
    CREATE TABLE "e2e_inbox" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "device_id" INTEGER NOT NULL CONSTRAINT "e2e_inbox_device_id_fkey" REFERENCES "e2e_devices"("id") ON DELETE CASCADE,
      "sender" TEXT NOT NULL,
      "from_did" TEXT NOT NULL,
      "verb" TEXT NOT NULL,
      "msgid" TEXT NOT NULL,
      "bytes" INTEGER NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "payload" TEXT NOT NULL,
      CONSTRAINT "e2e_inbox_verb" CHECK (verb IN ('keys', 'pkmsg', 'msg', 'nack'))
    )
    """)

    # Every read is one device's queue in id order: the client's fetch, the
    # cap check on insert, and the expiry sweep.
    create index(:e2e_inbox, [:device_id, :id])
  end

  def down do
    execute(~s{DROP TABLE "e2e_inbox"})

    execute("""
    CREATE TABLE "e2e_inbox" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "e2e_inbox_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "e2e_inbox_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "e2e_inbox_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "sender" TEXT NOT NULL,
      "verb" TEXT NOT NULL,
      "msgid" TEXT NOT NULL,
      "bytes" INTEGER NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "payload" TEXT NOT NULL,
      CONSTRAINT "e2e_inbox_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL)),
      CONSTRAINT "e2e_inbox_verb" CHECK (verb IN ('keys', 'pkmsg', 'msg', 'nack'))
    )
    """)

    create index(:e2e_inbox, [:user_id, :network_id, :id])
    create index(:e2e_inbox, [:visitor_id, :network_id, :id])
  end
end
