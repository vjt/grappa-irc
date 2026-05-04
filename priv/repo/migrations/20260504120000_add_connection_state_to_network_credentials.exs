defmodule Grappa.Repo.Migrations.AddConnectionStateToNetworkCredentials do
  @moduledoc """
  T32 — adds `connection_state` enum + `_reason` + `_changed_at`
  columns to `network_credentials`. Powers the `/disconnect` (park),
  `/connect` (unpark), `/quit` (nuclear park-all) verbs from the
  channel-client-polish cluster.

  Default `:connected` matches existing rows' implied state.
  Backfill is the column default — every pre-T32 credential row
  represents an actively-bound network whose Bootstrap-spawned
  Session.Server is the proof. Operator-driven state changes go
  through `Grappa.Networks.connect/disconnect/mark_failed`.

  Runtime sub-states (`:connecting`, `:reconnecting`, `:backing_off`)
  stay in `Session.Server` GenServer state — NOT mirrored to DB.
  Only the user-visible terminal/intent states land here.

  ## sqlite ADD COLUMN constraint (S3.6 first-deploy fix)

  sqlite refuses `ALTER TABLE ... ADD COLUMN ... DEFAULT CURRENT_TIMESTAMP`
  because non-constant defaults are forbidden on ADD COLUMN — only
  CREATE TABLE accepts them. Original migration shipped with that
  fragment and silently worked on dev (the dev DB had been recreated
  from scratch, hitting the CREATE TABLE path) but crashed prod's
  first post-S1 deploy with `Cannot add a column with non-constant
  default`. Edited 2026-05-04 to:

    * add `_changed_at` as nullable, no default
    * backfill existing rows via `execute "UPDATE..."`
    * Ecto schema enforces the not-null + default contract at
      changeset time — DB layer doesn't need to.
  """
  use Ecto.Migration

  def change do
    alter table(:network_credentials) do
      add :connection_state, :string, null: false, default: "connected"
      add :connection_state_reason, :string, null: true
      add :connection_state_changed_at, :utc_datetime, null: true
    end

    # Backfill existing rows; sqlite ADD COLUMN can't carry a
    # CURRENT_TIMESTAMP default itself. The schema-layer changeset
    # populates it on every new insert going forward.
    execute(
      "UPDATE network_credentials SET connection_state_changed_at = CURRENT_TIMESTAMP WHERE connection_state_changed_at IS NULL",
      "" # rollback is the implicit drop_column above
    )
  end
end
