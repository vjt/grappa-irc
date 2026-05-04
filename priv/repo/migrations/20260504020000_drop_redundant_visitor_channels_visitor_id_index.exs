defmodule Grappa.Repo.Migrations.DropRedundantVisitorChannelsVisitorIdIndex do
  @moduledoc """
  Drop the redundant single-column `(visitor_id)` index on
  `visitor_channels` (B5.4 L-pers-4).

  The `(visitor_id, network_slug, name)` unique composite index
  (created in `20260502080806_create_visitor_channels.exs`) is a btree
  on the leftmost-prefix `visitor_id`, so it covers every
  `WHERE visitor_id = ?` lookup that the parallel single-column index
  was carrying — at zero cost to those queries. The single-column
  index is pure write-amplification: every visitor-channel
  insert/update/delete maintained both indexes and the planner only
  ever picks the composite (because the composite + the single-col
  have identical selectivity on the leading column, and the planner
  prefers composites that may serve future restricting predicates).

  Rollback re-creates the dropped index so the prior migration's
  shape is restored exactly.
  """
  use Ecto.Migration

  def up do
    drop_if_exists index(:visitor_channels, [:visitor_id])
  end

  def down do
    create index(:visitor_channels, [:visitor_id])
  end
end
