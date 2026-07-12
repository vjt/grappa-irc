defmodule Grappa.Repo.Migrations.SeedVisitorAutoconnectFromExistingVisitors do
  @moduledoc """
  #211 phase 6 — continuity seed: flip `networks.visitor_autoconnect =
  true` for every network that is ALREADY `visitor_enabled` AND has
  visitor credentials.

  ## Why this migration exists (preserve today's single-network autoconnect)

  Phase 6 makes login auto-connect the `visitor_autoconnect` SET (ruling
  C). Pre-phase-6, a visitor logs into the sole `visitor_enabled`
  network — i.e. today's behavior IS "auto-connect the one enabled
  network that serves visitors." With `visitor_autoconnect` defaulting
  `false`, a naive cutover would leave ZERO autoconnect networks → a
  fresh visitor login connects nothing. This seed preserves continuity:
  the networks that today auto-connect visitors keep doing so.

  ## Derive-from-reality (NOT a hardcoded slug)

  Mirrors the phase-3 `visitor_enabled` continuity seed
  (`20260711130000`): data-driven, not `WHERE slug = 'azzurra'`. Enable
  autoconnect for the networks that BOTH accept visitors
  (`visitor_enabled = 1`) AND already have live visitor credentials.
  Semantically those ARE the networks a returning visitor expects to
  come up on login. Works for any deployment; an operator later opts a
  network in/out via `PATCH /admin/networks/:slug`.

  The `visitor_enabled = 1` conjunct keeps the subset invariant intact
  from the seed forward: a network that has visitor credentials but was
  explicitly disabled by an admin is NOT auto-connected.

  ## Idempotent + expand-only

  `UPDATE ... WHERE visitor_autoconnect = 0 AND ...` — re-running is a
  no-op. Nothing dropped; a boolean flips false→true. `down/0` reverses
  only the derived set (same predicate) — a full rollback of the phase-6
  autoconnect cutover.

  ## Cold deploy

  Runs after `20260712120000` (the column add). Rides the same
  end-of-crank COLD window as the rest of the #211 functional stack.
  """
  use Ecto.Migration

  def up do
    execute("""
    UPDATE networks
    SET visitor_autoconnect = 1
    WHERE visitor_autoconnect = 0
      AND visitor_enabled = 1
      AND id IN (SELECT DISTINCT network_id FROM network_credentials WHERE visitor_id IS NOT NULL)
    """)
  end

  def down do
    execute("""
    UPDATE networks
    SET visitor_autoconnect = 0
    WHERE visitor_autoconnect = 1
      AND visitor_enabled = 1
      AND id IN (SELECT DISTINCT network_id FROM network_credentials WHERE visitor_id IS NOT NULL)
    """)
  end
end
