defmodule Grappa.Repo.Migrations.SeedVisitorEnabledFromExistingVisitors do
  @moduledoc """
  #211 phase 3 — continuity seed: flip `networks.visitor_enabled = true`
  for every network that ALREADY has visitor credentials.

  ## Why this migration exists (the cutover-continuity fork, vjt-ruled)

  Phase 1 landed `networks.visitor_enabled BOOLEAN NOT NULL DEFAULT
  false` — dormant. Phase 3 makes visitor login READ that flag as the
  runtime allowlist (`Grappa.Networks.list_visitor_enabled/0`): a visitor
  may attach ONLY a `visitor_enabled` network. With the default `false`,
  a naive cutover leaves ZERO enabled networks → every existing visitor
  login breaks the moment phase 3 deploys.

  ## Derive-from-reality (NOT a hardcoded slug)

  This seed is data-driven, not `WHERE slug = 'azzurra'`: it enables
  exactly the networks that have live visitor credentials RIGHT NOW.
  Semantically a network that currently serves visitors IS a visitor
  network — so preserving current behavior means enabling precisely
  those. Works for any deployment (no per-deployment slug baked in), and
  an operator can later disable a network via the admin
  `PATCH /admin/networks/:slug` toggle.

  The phase-1 backfill (`20260711125000`) created one Credential per
  visitor with `visitor_id IS NOT NULL`, so "networks that have
  visitors" == "networks with a visitor credential" — the source of
  truth this query reads.

  ## Idempotent + expand-only

  `UPDATE ... WHERE visitor_enabled = 0 AND id IN (...)` — re-running is
  a no-op (already-enabled rows are skipped). Nothing is dropped; only a
  boolean flips false→true. `down/0` reverses ONLY the networks this
  migration could have enabled (same visitor-credential predicate),
  leaving any network an admin manually enabled afterward untouched
  would be indistinguishable — but at down-migration time the intent is
  a full rollback of the phase-3 cutover, so reverting the derived set
  is correct.

  ## Cold deploy

  Runs after the phase-1 schema + backfill migrations. Rides the same
  end-of-crank COLD window as the rest of the #211 functional stack (the
  hot deploy path skips `ecto.migrate`).
  """
  use Ecto.Migration

  def up do
    execute("""
    UPDATE networks
    SET visitor_enabled = 1
    WHERE visitor_enabled = 0
      AND id IN (SELECT DISTINCT network_id FROM network_credentials WHERE visitor_id IS NOT NULL)
    """)
  end

  def down do
    execute("""
    UPDATE networks
    SET visitor_enabled = 0
    WHERE visitor_enabled = 1
      AND id IN (SELECT DISTINCT network_id FROM network_credentials WHERE visitor_id IS NOT NULL)
    """)
  end
end
