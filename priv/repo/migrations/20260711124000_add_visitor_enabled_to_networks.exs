defmodule Grappa.Repo.Migrations.AddVisitorEnabledToNetworks do
  @moduledoc """
  #211 phase 1 — add `networks.visitor_enabled BOOLEAN NOT NULL DEFAULT
  false`, the runtime per-network visitor allowlist flag that replaces
  the compile-time `:visitor_network` pin.

  Additive column — no table-recreate needed (sqlite `ALTER TABLE ADD
  COLUMN` accepts a constant boolean default). Existing rows read
  `visitor_enabled = 0` (false): visitors disabled per-network by
  default until an admin opts a network in ("play safe", vjt
  2026-07-11). Phase 1 only lands the column; the login/attach READ +
  the admin toggle endpoint are phase 3, so this is behavior-neutral
  and rollback-safe.

  ## Cold deploy

  New column — hot deploy skips `ecto.migrate`, so this rides the same
  combined COLD window; a query against the new schema field would
  otherwise 500 on a hot deploy.
  """
  use Ecto.Migration

  def change do
    alter table(:networks) do
      add :visitor_enabled, :boolean, null: false, default: false
    end
  end
end
