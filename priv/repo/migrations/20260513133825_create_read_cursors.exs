defmodule Grappa.Repo.Migrations.CreateReadCursors do
  @moduledoc """
  Creates the `read_cursors` table — server-owned per-(subject, network,
  channel) read cursor for the `server-side-read-state` cluster.

  ## Why

  Phase 1 invariant *"No server-side `MARKREAD` / read cursors. Read
  position is client-side only."* is being deliberately flipped — see
  `docs/DESIGN_NOTES.md` "2026-05-13 — invariant flip". Three forces:

    1. The cp13-S5 race (cic GET-empty → POST → broadcast → JOIN-too-late
       loses the just-broadcast row).
    2. Multi-device cursor sync.
    3. Phase 6 IRCv3 `+draft/read-marker` + CHATHISTORY presume server-side
       cursor storage.

  ## Schema

    * `(user_id XOR visitor_id)` mirrors `messages` schema convention
      (per `Grappa.Scrollback.Message`). Subjects are the same two
      principals; cursor lives on the same axis.
    * `network_id` references `networks.id` (integer FK), NOT NULL.
    * `channel` is `TEXT` — same shape as `messages.channel`. Stores
      IRC channels (`#chan`), DM peer nicks (`alice`), or grappa-internal
      synthetic windows (`$server`, `*`). All cursor-able uniformly.
    * `last_read_message_id` references `messages.id` (integer FK).
      `ON DELETE SET NULL` (NOT `CASCADE`): message deletion is rare
      (visitor reaping CASCADEs the whole subject chain anyway), and
      a stale cursor with `last_read_message_id = NULL` is recoverable
      to "everything before earliest extant row read" rather than
      losing the entire window's read state. Column is nullable to
      let the cascade actually NULL it; insert-time presence is
      enforced by `Cursor.changeset/2`'s `validate_required/2`.

  ## Subject XOR

  Mirrors the `messages_subject_xor` shape: a partial unique index per
  subject branch + a CHECK constraint enforcing exactly one set. The
  partial-index trick (`WHERE user_id IS NOT NULL`) lets sqlite enforce
  per-subject uniqueness without polluting the index with NULL pairs
  that would otherwise collide spuriously.

  ## sqlite quirk: CHECK at CREATE time, not ALTER

  `ecto_sqlite3` rejects `create constraint(...)` with "SQLite3 does
  not support ALTER TABLE ADD CONSTRAINT". For a fresh table we can
  inline the CHECK in the raw `CREATE TABLE` — same pattern used by
  `20260502085339_add_visitor_id_to_messages.exs`. `create
  table(:read_cursors)` is replaced by an `execute/2` raw DDL pair so
  the CHECK lands atomically with the table.

  ## No reaper

  Visitor cleanup CASCADEs via the `visitor_id` FK; user deletion
  CASCADEs via `user_id`. Network deletion CASCADEs via `network_id`.
  No background job needed.
  """
  use Ecto.Migration

  def up do
    execute("""
    CREATE TABLE "read_cursors" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "read_cursors_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "read_cursors_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "read_cursors_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "channel" TEXT NOT NULL,
      "last_read_message_id" INTEGER NULL CONSTRAINT "read_cursors_last_read_message_id_fkey" REFERENCES "messages"("id") ON DELETE SET NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "read_cursors_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    create unique_index(:read_cursors, [:user_id, :network_id, :channel],
             where: "user_id IS NOT NULL",
             name: :read_cursors_user_network_channel_index
           )

    create unique_index(:read_cursors, [:visitor_id, :network_id, :channel],
             where: "visitor_id IS NOT NULL",
             name: :read_cursors_visitor_network_channel_index
           )

    create index(:read_cursors, [:network_id])
    create index(:read_cursors, [:last_read_message_id])
  end

  def down do
    drop table(:read_cursors)
  end
end
