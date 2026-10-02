defmodule Grappa.Migrations.DropDmConversationsTest do
  @moduledoc """
  issue 1365 C5 — the drop that retires `dm_conversations` on the databases
  that ever created it, and costs nothing on the ones that never did.

  The two migrations that built the table and its child FKs were DELETED in
  the same change (they were never in a release tag), so a database is in one
  of two states when this runs: it applied them (a dev or test database that
  ran `main` between 2026-09-29 and this change) or it never saw them (a fresh
  database, and production if it never deployed them). Both must end in the
  same schema, which is what is pinned here:

    * LEGACY shape present → the table, both child columns and their four
      indexes are gone, and the child ROWS survive with every other column
      intact (a `DROP COLUMN` rewrites the table; it must not lose data);
    * shape ABSENT → the run is a no-op and does not raise;
    * a re-run is a no-op (cold deploys replay).

  The legacy shape is staged with the DDL of the deleted
  `20260929001416_create_dm_conversations.exs`, copied verbatim: the file is
  gone, and the shape it left behind on a database is exactly what this
  migration exists to remove.

  `async: false`: `Ecto.Migrator.down/up` rewinds and replays a shared
  `schema_migrations` row. The migration MODULE is executed, not a copy of
  its SQL.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Repo, ScrollbackHelpers}

  # Matched by SUFFIX, not by version — a rebase renumbers the file.
  @migration_glob "priv/repo/migrations/*_drop_dm_conversations.exs"

  @legacy_ddl [
    """
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
    """,
    ~s|CREATE UNIQUE INDEX "dm_conversations_user_network_nick_folded_index" ON "dm_conversations" ("user_id", "network_id", lower(peer_nick)) WHERE user_id IS NOT NULL|,
    ~s|CREATE UNIQUE INDEX "dm_conversations_visitor_network_nick_folded_index" ON "dm_conversations" ("visitor_id", "network_id", lower(peer_nick)) WHERE visitor_id IS NOT NULL|,
    ~s|CREATE INDEX "dm_conversations_network_id_index" ON "dm_conversations" ("network_id")|,
    "ALTER TABLE messages ADD COLUMN dm_conversation_id INTEGER NULL REFERENCES dm_conversations(id)",
    "ALTER TABLE read_cursors ADD COLUMN dm_conversation_id INTEGER NULL REFERENCES dm_conversations(id)",
    ~s|CREATE INDEX "messages_dm_conversation_id_index" ON "messages" ("dm_conversation_id") WHERE dm_conversation_id IS NOT NULL|,
    ~s|CREATE INDEX "read_cursors_dm_conversation_id_index" ON "read_cursors" ("dm_conversation_id") WHERE dm_conversation_id IS NOT NULL|
  ]

  @legacy_indexes [
    "dm_conversations_user_network_nick_folded_index",
    "dm_conversations_visitor_network_nick_folded_index",
    "dm_conversations_network_id_index",
    "messages_dm_conversation_id_index",
    "read_cursors_dm_conversation_id_index"
  ]

  # The test DB is migrated at setup, so the version is already in
  # `schema_migrations` and a bare `up/4` answers `:already_up` — a call that
  # runs nothing. Rewind, then replay.
  defp run_migration! do
    assert :ok = Ecto.Migrator.down(Repo, migration_version!(), load_migration!(), log: false)
    assert :ok = Ecto.Migrator.up(Repo, migration_version!(), load_migration!(), log: false)
  end

  defp load_migration! do
    Code.require_file(migration_file!())
    Grappa.Repo.Migrations.DropDmConversations
  end

  defp migration_file! do
    [path] = File.cwd!() |> Path.join(@migration_glob) |> Path.wildcard()
    path
  end

  defp migration_version! do
    migration_file!()
    |> Path.basename()
    |> String.split("_", parts: 2)
    |> hd()
    |> String.to_integer()
  end

  defp stage_legacy_shape!, do: Enum.each(@legacy_ddl, &Repo.query!/1)

  defp columns(table) do
    "SELECT name FROM pragma_table_info(?) ORDER BY cid"
    |> Repo.query!([table])
    |> Map.fetch!(:rows)
    |> List.flatten()
  end

  defp schema_names(type) do
    "SELECT name FROM sqlite_master WHERE type = ?"
    |> Repo.query!([type])
    |> Map.fetch!(:rows)
    |> List.flatten()
  end

  setup do
    user = user_fixture()
    net = network_fixture()

    {:ok, message} =
      ScrollbackHelpers.insert(%{
        user_id: user.id,
        network_id: net.id,
        channel: "peer",
        dm_with: "peer",
        server_time: 1,
        kind: :privmsg,
        sender: "vjt",
        body: "kept"
      })

    %{message: message}
  end

  test "drops the legacy table, both child columns and every index, keeping the child rows",
       %{message: message} do
    messages_before = columns("messages")
    cursors_before = columns("read_cursors")

    stage_legacy_shape!()

    # Positive control: the staged shape is really there, so the asserts
    # below cannot pass on a database that never had it.
    assert "dm_conversations" in schema_names("table")
    assert "dm_conversation_id" in columns("messages")
    assert "dm_conversation_id" in columns("read_cursors")
    assert Enum.all?(@legacy_indexes, &(&1 in schema_names("index")))

    Repo.query!(
      "INSERT INTO dm_conversations (user_id, network_id, peer_nick, inserted_at, updated_at) VALUES (?, ?, 'peer', '2026-09-29', '2026-09-29')",
      [message.user_id, message.network_id]
    )

    Repo.query!("UPDATE messages SET dm_conversation_id = (SELECT max(id) FROM dm_conversations) WHERE id = ?", [
      message.id
    ])

    run_migration!()

    refute "dm_conversations" in schema_names("table")
    assert columns("messages") == messages_before
    assert columns("read_cursors") == cursors_before
    assert Enum.filter(@legacy_indexes, &(&1 in schema_names("index"))) == []

    assert %{rows: [["kept", "peer", "peer"]]} =
             Repo.query!("SELECT body, channel, dm_with FROM messages WHERE id = ?", [message.id])
  end

  test "is a no-op on a database that never had the shape" do
    messages_before = columns("messages")
    cursors_before = columns("read_cursors")
    tables_before = Enum.sort(schema_names("table"))
    indexes_before = Enum.sort(schema_names("index"))

    refute "dm_conversations" in tables_before

    run_migration!()

    assert columns("messages") == messages_before
    assert columns("read_cursors") == cursors_before
    assert Enum.sort(schema_names("table")) == tables_before
    assert Enum.sort(schema_names("index")) == indexes_before
  end

  test "a re-run over a dropped shape is a no-op" do
    stage_legacy_shape!()
    run_migration!()
    after_first = {columns("messages"), columns("read_cursors"), Enum.sort(schema_names("index"))}

    run_migration!()

    assert {columns("messages"), columns("read_cursors"), Enum.sort(schema_names("index"))} == after_first
  end
end
