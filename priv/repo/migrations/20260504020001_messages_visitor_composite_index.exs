defmodule Grappa.Repo.Migrations.MessagesVisitorCompositeIndex do
  @moduledoc """
  Add `(visitor_id, network_id, channel, server_time)` composite index
  on `messages` and drop the redundant `(visitor_id)` single-column
  index (B5.4 M-pers-5 + folded L-pers-4 sibling).

  The user-side scrollback path is already covered by the composite
  `(user_id, network_id, channel, server_time)` index created in
  `20260502085339_add_visitor_id_to_messages.exs`. The visitor-side
  fetch query (`Scrollback.fetch({:visitor, vid}, network_id, channel,
  before, limit)` filters on the same shape:

      WHERE visitor_id = ?
        AND network_id = ?
        AND channel = ?
        AND server_time < ?       -- when `before` is non-nil
      ORDER BY server_time DESC, id DESC
      LIMIT ?

  Without a parallel composite, that query falls back to the
  single-column `(visitor_id)` index for the leading filter and then
  scans the matching rows, sorting them in memory — quadratic in the
  worst case where one visitor has scrollback across many channels.

  Adding the composite gives the visitor-side path the same
  index-scan + ordered-tail-read shape the user-side enjoys. The
  single-column `(visitor_id)` index becomes redundant by the same
  leftmost-prefix argument as L-pers-4 (visitor_channels): it covered
  exactly the lookups the new composite covers, at zero benefit and
  full write-amplification cost. Drop it in the same migration.

  Round-trip verified — down-migration restores the original shape.
  """
  use Ecto.Migration

  def up do
    create index(:messages, [:visitor_id, :network_id, :channel, :server_time])
    drop_if_exists index(:messages, [:visitor_id])
  end

  def down do
    create index(:messages, [:visitor_id])

    drop_if_exists index(:messages, [
                     :visitor_id,
                     :network_id,
                     :channel,
                     :server_time
                   ])
  end
end
