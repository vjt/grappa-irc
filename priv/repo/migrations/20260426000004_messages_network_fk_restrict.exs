defmodule Grappa.Repo.Migrations.MessagesNetworkFkRestrict do
  @moduledoc """
  Phase 2 follow-up (S29 C2): tighten the messages.network_id FK from
  `:delete_all` to `:restrict`.

  The Phase 2 sub-task 2e migration (`20260426000003`) declared
  `add :network_id, references(:networks, on_delete: :delete_all)`,
  which contradicts the original archival invariant baked into the
  init migration: "when a network is removed, its historical messages
  stay around — operator deletes scrollback explicitly via a separate
  command." With `:delete_all`, removing a network silently nukes
  every message ever sent on it. With `:restrict`, the FK firm-rejects
  the network delete attempt while messages remain — `Networks.unbind_credential/2`
  detects that case and surfaces `{:error, :scrollback_present}` so
  the operator must run `mix grappa.delete_scrollback --network <slug>`
  (Phase 5) deliberately.

  ## Wipe-and-rebuild

  Same pattern as `20260426000003`: `DELETE FROM messages` first, then
  the sqlite ALTER TABLE table-recreate dance (drop the per-user iso
  index → drop the column → re-add with the new FK semantics → rebuild
  the index). Phase 2 is still pre-deploy — there is no production
  scrollback to preserve. Decision G2 (wipe-and-rebuild) applies.

  ## sqlite ALTER TABLE caveat

  sqlite has no native "alter constraint" — the only way to change an
  FK on an existing column is to drop and re-add the column (under the
  hood Ecto does an ALTER TABLE that does the table-recreate). The
  index referencing the column must be dropped first; otherwise the
  recreate trips on a stale index reference.
  """
  use Ecto.Migration

  def up do
    execute("DELETE FROM messages")

    drop index(:messages, [:user_id, :network_id, :channel, :server_time])

    alter table(:messages) do
      remove :network_id
      add :network_id, references(:networks, on_delete: :restrict), null: false
    end

    create index(:messages, [:user_id, :network_id, :channel, :server_time])
  end

  def down do
    execute("DELETE FROM messages")

    drop index(:messages, [:user_id, :network_id, :channel, :server_time])

    alter table(:messages) do
      remove :network_id
      add :network_id, references(:networks, on_delete: :delete_all), null: false
    end

    create index(:messages, [:user_id, :network_id, :channel, :server_time])
  end
end
