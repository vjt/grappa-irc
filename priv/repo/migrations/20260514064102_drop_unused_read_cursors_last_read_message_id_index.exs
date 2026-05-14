defmodule Grappa.Repo.Migrations.DropUnusedReadCursorsLastReadMessageIdIndex do
  @moduledoc """
  Drop `read_cursors_last_read_message_id_index`, created in
  `20260513133825_create_read_cursors.exs:89`. No query in
  `Grappa.ReadCursor` keys on `last_read_message_id`:

    * `get/3` keys on `(subject, network_id, channel)`.
    * `set/4` upserts on the same triplet's partial unique index.
    * `bulk_for_subject/1` joins `networks` and selects
      `(slug, channel, last_read_message_id)`.
    * `broadcast_set/4` does no DB work.

  The `belongs_to :last_read_message` association is declared but
  never preloaded. CASCADE-on-message-delete (`ON DELETE SET NULL`)
  doesn't read this index either — sqlite's deferred FK action scans
  by message PK, then patches the cursor row in place.

  Per `feedback_cluster_with_migration_must_cold` the cluster Z-bucket
  cold-deploys; this migration runs as part of that.
  """
  use Ecto.Migration

  def up do
    drop index(:read_cursors, [:last_read_message_id])
  end

  def down do
    create index(:read_cursors, [:last_read_message_id])
  end
end
