defmodule Grappa.Repo.Migrations.AddMessagesNetworkIdIndex do
  @moduledoc """
  Add a leading index on `messages.network_id` (S33, 2026-07-08
  codebase review — rides-along).

  Every composite `messages` index leads with `user_id` / `visitor_id`
  (per-subject isolation), so `network_id` is never a usable prefix.
  Two operator-path reads pay for that:

    * `Scrollback.has_messages_for_network?/1` — the network-delete gate.
      When a network has no scrollback (the proceed-to-delete case) it
      confirms absence with `WHERE network_id = ? LIMIT 1`, a full
      `messages` scan without this index.
    * `Networks.delete_network/1`'s `Repo.delete(net)` — `messages`
      references `networks` with `ON DELETE RESTRICT`, so SQLite scans
      the child (`messages`) for any referencing row to enforce the
      restrict, again a full scan without a child-key index.

  Both are rare (operator actions), but on the largest table in the DB.
  A single-column `[:network_id]` index turns both scans into index
  seeks. Plain `create` (drift should fail loudly per CLAUDE.md);
  reversible via `up`/`down`.
  """
  use Ecto.Migration

  def up do
    create index(:messages, [:network_id])
  end

  def down do
    drop index(:messages, [:network_id])
  end
end
