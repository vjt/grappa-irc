defmodule Grappa.Repo.Migrations.RecreateReadCursorsLastReadMessageIdIndex do
  @moduledoc """
  Recreate the child-key index on `read_cursors.last_read_message_id`,
  dropped by `20260514064102_drop_unused_read_cursors_last_read_message_id_index.exs`
  on a BACKWARDS rationale (S12, 2026-07-08 codebase review).

  `read_cursors.last_read_message_id` is
  `REFERENCES messages(id) ON DELETE SET NULL`. The drop migration
  reasoned the FK action "scans by message PK, then patches the cursor
  row in place" and so needs no index — but that inverts how SQLite
  enforces a referential action. On DELETE of a parent `messages` row,
  SQLite searches the CHILD table (`read_cursors`) for every row whose
  foreign key equals the deleted parent id, to set it NULL. With no
  index on the child key column that search is a full `read_cursors`
  table scan PER deleted parent.

  The bulk-purge path — `Scrollback.delete_for_channel/3` /
  `delete_for_dm/3` — issues a single `Repo.delete_all` that can drop
  tens of thousands of `messages` rows in one transaction. Without this
  index that is `O(deleted × read_cursors)` work while holding the one
  SQLite write lock, spilling into the 30s `busy_timeout` for every
  concurrent writer (all other sessions' persists) on the process.

  The drop migration was right that NO READ query keys on
  `last_read_message_id` (`get/3`, `set/4`, `bulk_for_subject/1` all key
  on the `(subject, network, channel)` triplet). The index earns its
  keep purely on the FK-cascade write path; the cursor-upsert
  write-amplification it adds is negligible (cursors settle on
  focus-leave, a low-frequency write) next to the O(N×M) delete scan it
  removes.

  Plain `create` (not `create_if_not_exists`): every environment reaches
  this migration with the index absent — the drop always precedes it in
  history — so a collision here would be real schema drift and SHOULD
  fail loudly (CLAUDE.md migration rule). Reversible via `up`/`down`;
  `down` restores the (wrong-but-historical) dropped state.
  """
  use Ecto.Migration

  def up do
    create index(:read_cursors, [:last_read_message_id])
  end

  def down do
    drop index(:read_cursors, [:last_read_message_id])
  end
end
