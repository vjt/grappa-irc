defmodule Grappa.Repo.Migrations.CreateE2eDevices do
  use Ecto.Migration

  # issue 2430, multi-device (wire v2, 2430 comments 6346236542 and
  # 6346384093): each device of a subject has its own Olm account per
  # network, and so its own identity. One row per device: the id block it
  # publishes (Curve25519 key, Ed25519 key, and the signature by the
  # Ed25519 key over the Curve25519 key and the subject's master), and the
  # `did` grappa derives from the Ed25519 key, which is what a frame's
  # `<to>` names. At most four rows per (subject, network); the context
  # enforces it, inside the write lock.
  #
  # Raw SQL for the table body, like the other e2e tables: the subject XOR
  # is a CHECK constraint, which `Ecto.Migration`'s DSL cannot express
  # inline. `AUTOINCREMENT` because the device's one-time keys and its
  # inbox rows reference it, and a reused id would hand a removed device's
  # successor rows that were never its own.
  def change do
    execute(
      """
      CREATE TABLE "e2e_devices" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "user_id" TEXT NULL CONSTRAINT "e2e_devices_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
        "visitor_id" TEXT NULL CONSTRAINT "e2e_devices_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
        "network_id" INTEGER NOT NULL CONSTRAINT "e2e_devices_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
        "did" TEXT NOT NULL,
        "ed25519" TEXT NOT NULL,
        "curve25519" TEXT NOT NULL,
        "sig" TEXT NOT NULL,
        "inserted_at" TEXT NOT NULL,
        CONSTRAINT "e2e_devices_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
      )
      """,
      ~s{DROP TABLE "e2e_devices"}
    )

    # One row per device id in a (subject, network): a frame's `<to>` must
    # name exactly one device. A NULL subject column never collides in
    # SQLite, so each subject kind needs its own index; each also serves
    # the per-partition reads.
    create unique_index(:e2e_devices, [:user_id, :network_id, :did])
    create unique_index(:e2e_devices, [:visitor_id, :network_id, :did])
  end
end
