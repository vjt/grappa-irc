defmodule Grappa.Repo.Migrations.MessagesPerUserIso do
  @moduledoc """
  Phase 2 sub-task 2e: per-user iso on scrollback.

  Wipe-and-rebuild (decision G2): the previous shape stored
  `network_id` as a free-text string — there is no clean conversion
  to the new integer FK without operator-side mapping data, and
  Phase 1 messages are walking-skeleton scaffolding (no production
  scrollback to preserve). `DELETE FROM messages` first, then alter.

  After this migration:
    * every row carries `user_id` (BLOB, FK → users.id, ON DELETE
      CASCADE — when a user is purged, their scrollback goes too).
    * `network_id` is INTEGER FK → networks.id (was free text).
    * the per-channel index is rebuilt with `user_id` as the leading
      key so the partition predicate (user_id = ?, network_id = ?,
      channel = ?) is a single index scan for the per-user iso fetch.
  """
  use Ecto.Migration

  def up do
    execute("DELETE FROM messages")

    # Drop the index BEFORE dropping the column it references — sqlite's
    # ALTER TABLE table-recreate dance fails to rebuild the index across
    # a column type change otherwise ("no such column: network_id" on
    # the post-drop index sync).
    drop index(:messages, [:network_id, :channel, :server_time])

    alter table(:messages) do
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      remove :network_id, :string
      add :network_id, references(:networks, on_delete: :delete_all), null: false
    end

    create index(:messages, [:user_id, :network_id, :channel, :server_time])
  end

  def down do
    execute("DELETE FROM messages")

    drop index(:messages, [:user_id, :network_id, :channel, :server_time])

    alter table(:messages) do
      remove :user_id
      remove :network_id, references(:networks, on_delete: :delete_all)
      add :network_id, :string, null: false
    end

    create index(:messages, [:network_id, :channel, :server_time])
  end
end
