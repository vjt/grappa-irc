defmodule Grappa.Repo.Migrations.CreateE2eDeviceLists do
  use Ecto.Migration

  # issue 2430, multi-device (wire v2, 2430 comments 6346236542 and
  # 6346384093): the subject's signed device list on a network — the master
  # key, the list's version, the devices' Ed25519 keys, and the master's
  # signature over `"irc-e2e:v2:list:" + ver + ":" + keys joined by ","`.
  # One row per (subject, network). grappa serves it in every KEYS it
  # answers, routes only to the devices it lists, and refuses a version
  # that does not rise.
  #
  # `devices` is a JSON array, as Ecto writes `{:array, :string}` on SQLite;
  # it is read whole, never queried into.
  def change do
    execute(
      """
      CREATE TABLE "e2e_device_lists" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "user_id" TEXT NULL CONSTRAINT "e2e_device_lists_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
        "visitor_id" TEXT NULL CONSTRAINT "e2e_device_lists_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
        "network_id" INTEGER NOT NULL CONSTRAINT "e2e_device_lists_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
        "master" TEXT NOT NULL,
        "ver" INTEGER NOT NULL,
        "devices" TEXT NOT NULL,
        "sig" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL,
        CONSTRAINT "e2e_device_lists_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
      )
      """,
      ~s{DROP TABLE "e2e_device_lists"}
    )

    # One list per (subject, network). A NULL subject column never collides
    # in SQLite, so each subject kind needs its own index.
    create unique_index(:e2e_device_lists, [:user_id, :network_id])
    create unique_index(:e2e_device_lists, [:visitor_id, :network_id])
  end
end
