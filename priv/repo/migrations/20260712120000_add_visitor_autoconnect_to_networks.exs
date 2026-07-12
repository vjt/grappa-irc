defmodule Grappa.Repo.Migrations.AddVisitorAutoconnectToNetworks do
  @moduledoc """
  #211 phase 6 — add `networks.visitor_autoconnect BOOLEAN NOT NULL
  DEFAULT false`, the SUBSET of `visitor_enabled` a visitor auto-connects
  at login (vjt ruling C, follow-up 1: "NO picker, NO extra login step").

  ## The two-tier visitor allowlist

    * `visitor_enabled` (phase 1/3) — "visitors are ALLOWED here." The
      AVAILABLE tier: shown on the home page for on-demand one-tap
      connect (anon + registered).
    * `visitor_autoconnect` (this migration) — the SUBSET auto-connected
      at login, zero friction, multi-network from first login.

  `visitor_autoconnect` is a strict subset of `visitor_enabled` at the
  admin-intent level (you can't auto-connect a network visitors aren't
  allowed on) — but the columns are independent booleans; the invariant
  is enforced by the admin edit surface + the login/home readers, not a
  DB CHECK (a network toggled `visitor_enabled=false` while still
  `visitor_autoconnect=true` is a benign no-op — login filters on the
  AND at read time).

  ## Additive column — no table-recreate

  sqlite `ALTER TABLE ADD COLUMN` accepts a constant boolean default.
  Existing rows read `visitor_autoconnect = 0` (false); the continuity
  seed (`20260712120100`) then flips it true for the networks that today
  auto-connect visitors, preserving the pre-phase-6 single-network
  behavior.

  ## Cold deploy

  New column — the hot deploy path skips `ecto.migrate`, so this rides
  the single end-of-crank COLD window with the rest of the phase-6
  functional stack. The visitor-COLUMN DROP (`visitors.network_slug`
  etc.) stays phase 7; this phase only EXPANDS.
  """
  use Ecto.Migration

  def change do
    alter table(:networks) do
      add :visitor_autoconnect, :boolean, null: false, default: false
    end
  end
end
