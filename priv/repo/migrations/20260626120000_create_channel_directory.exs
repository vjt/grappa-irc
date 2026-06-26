defmodule Grappa.Repo.Migrations.CreateChannelDirectory do
  @moduledoc """
  Creates the `channel_directory` table — one row per
  `(subject, network, channel)` in a discovery snapshot produced by an
  upstream IRC `/LIST` command.

  ## Schema design

  * `user_id` / `visitor_id` — exactly one must be set (XOR). Enforced
    at three layers: `validate_subject_xor/1` in the schema, the
    `channel_directory_subject_xor` CHECK constraint inline in the
    CREATE TABLE, and the Ecto-layer `check_constraint/3` that
    translates DB violations into changeset errors.

  * `network_id` → `networks.id` ON DELETE CASCADE — network deleted =
    all its directory rows gone.

  * `name` — the IRC channel name as returned by `322 RPL_LIST`, e.g.
    `#grappa`. Stored verbatim (case-preserving).

  * `topic` — the channel topic string from `322 RPL_LIST`. May be
    NULL when the upstream omits it.

  * `user_count` — the member count as reported by `322 RPL_LIST`.

  * `captured_at` — NULL while the `LIST` response is still streaming;
    set to the `RPL_LISTEND (323)` timestamp once the snapshot is
    complete. A snapshot "exists" only when at least one row for the
    subject+network carries a non-nil `captured_at`.

  ## XOR CHECK constraint

  SQLite does not support `ALTER TABLE ... ADD CONSTRAINT`, so the XOR
  CHECK constraint must be declared inline in the CREATE TABLE body.
  Ecto's `create constraint/3` DSL generates an ALTER TABLE statement
  and therefore cannot be used here. We drop to `execute/2` for the
  full CREATE TABLE, then create indexes via the normal DSL.

  This is the same pattern as `20260515005115_xor_fk_query_windows.exs`
  and `20260513133825_create_read_cursors.exs`.

  ## Indexes

  Four composite indexes covering the two subject branches (user vs
  visitor) with and without `user_count` to support both sorted listing
  (`ORDER BY user_count DESC, name`) and per-name lookup.
  """
  use Ecto.Migration

  def change do
    execute(
      """
      CREATE TABLE "channel_directory" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "user_id" TEXT NULL CONSTRAINT "channel_directory_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
        "visitor_id" TEXT NULL CONSTRAINT "channel_directory_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
        "network_id" INTEGER NOT NULL CONSTRAINT "channel_directory_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
        "name" TEXT NOT NULL,
        "topic" TEXT,
        "user_count" INTEGER NOT NULL DEFAULT 0,
        "captured_at" TEXT,
        "inserted_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL,
        CONSTRAINT "channel_directory_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
      )
      """,
      "DROP TABLE IF EXISTS channel_directory"
    )

    create index(:channel_directory, [:user_id, :network_id, :user_count, :name])
    create index(:channel_directory, [:user_id, :network_id, :name])
    create index(:channel_directory, [:visitor_id, :network_id, :user_count, :name])
    create index(:channel_directory, [:visitor_id, :network_id, :name])
  end
end
