defmodule Grappa.Repo.Migrations.BackfillVisitorCredentials do
  @moduledoc """
  #211 phase 1 — backfill: every existing `visitors` row gets ONE
  `network_credentials` row (its subject = `visitor_id`) derived from
  the visitor's current per-row identity + `network_slug`. This is the
  data half of the visitor→Credential unification; the schema half
  (XOR + surrogate id) landed in `20260711123000`.

  ## What moves where (expand, NOT contract)

  The visitor's per-network identity fields are COPIED onto the new
  Credential; the visitor row is left fully intact (contraction of the
  old columns is phase 7). Zero data loss — additive only.

    * `nick`, `ident`, `realname`, `last_joined_channels` → copied verbatim.
    * `password_encrypted` → **raw ciphertext byte-copy**. Both columns
      are the same Cloak `EncryptedBinary` BLOB at rest under the SAME
      `Grappa.Vault`, so copying the stored bytes preserves
      encryption-at-rest with NO decrypt/re-encrypt (which is why this
      is pure SQL, never an Elixir round-trip — a re-encrypt would be
      pointless churn and a decrypt would need the vault started mid-
      migration).
    * `network_id` ← resolved from `visitors.network_slug` via the
      `networks` table.
    * `auth_method` ← `nickserv_identify` when the visitor carries a
      committed NickServ password, else `none` — mirrors
      `Grappa.Visitors.SessionPlan.auth_method/1` (the runtime SoT).
    * `sasl_user` ← the visitor nick (mirrors
      `SessionPlan.build_plan/3`, which sets `sasl_user: visitor.nick`).
    * `connection_state` ← `connected` (a live visitor is an actively
      bound network — same default as a fresh user credential).
    * `expires_at` / `ip` STAY on the visitor identity row — they are
      identity/TTL lifecycle, not per-`(subject, network)` credential
      attributes, so they do NOT move onto the Credential.

  ## Idempotent + prod-data-safe

  `INSERT ... SELECT ... WHERE NOT EXISTS (matching visitor credential)`
  → re-running is a no-op. Nothing mutates or deletes a visitor row.
  vjt dry-runs this against a COPY of the prod sqlite DB before deploy;
  the NOT EXISTS guard makes that dry-run + the real run identical and
  repeatable.

  ## Orphan-slug visitors are skipped (non-destructive)

  If a visitor's `network_slug` has no matching `networks` row, the
  subquery resolves NULL and the JOIN drops that visitor — no Credential
  is created, the visitor row is untouched, and no error is raised. This
  matches today's behavior where `Grappa.Bootstrap.validate_visitor_networks!`
  is the loud boot-time signal for an orphaned slug; the backfill stays
  silent + safe and leaves that guard in charge. (In practice the live
  prod visitors are all on the single configured network.)

  ## Timestamps

  `inserted_at`/`updated_at` are COPIED from the visitor row rather than
  stamped `now`. The visitor's timestamps are already in the exact
  ecto_sqlite3 storage format (they were written by Ecto), so copying
  them is guaranteed to round-trip through the loader — generating a
  fresh timestamp in raw SQL risks a format drift from
  `:utc_datetime_usec`'s stored shape that would only surface as a load
  crash later. Semantically faithful too: the credential's binding age
  IS the visitor's age (the visitor was bound to its network at row
  creation). Prod-safety over cosmetic "born now" precision — this
  backfill rides a combined COLD window and must not break shit.

  ## Cold deploy

  Runs after `20260711123000` (which reshapes the table). Rides the same
  combined COLD window. `down/0` removes only the visitor credentials it
  could have created (`WHERE visitor_id IS NOT NULL`), leaving user
  credentials untouched.
  """
  use Ecto.Migration

  def up do
    execute("""
    INSERT INTO network_credentials
      (visitor_id, user_id, network_id, nick, ident, realname, sasl_user,
       password_encrypted, auth_method, autojoin_channels, last_joined_channels,
       connection_state, inserted_at, updated_at)
    SELECT
      v.id,
      NULL,
      n.id,
      v.nick,
      v.ident,
      v.realname,
      v.nick,
      v.password_encrypted,
      CASE WHEN v.password_encrypted IS NOT NULL THEN 'nickserv_identify' ELSE 'none' END,
      '[]',
      COALESCE(v.last_joined_channels, '[]'),
      'connected',
      v.inserted_at,
      v.updated_at
    FROM visitors v
    JOIN networks n ON n.slug = v.network_slug
    WHERE NOT EXISTS (
      SELECT 1 FROM network_credentials nc
      WHERE nc.visitor_id = v.id AND nc.network_id = n.id
    )
    """)
  end

  def down do
    # Remove only backfilled visitor credentials; user credentials are
    # untouched. Safe to run standalone and idempotent (a second run
    # finds nothing to delete).
    execute("DELETE FROM network_credentials WHERE visitor_id IS NOT NULL")
  end
end
