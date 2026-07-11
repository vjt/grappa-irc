defmodule Grappa.Repo.Migrations.AddVisitorFoldedNickIndexToCredentials do
  @moduledoc """
  #211 phase 4b — the credential-side folded-nick partial unique index for
  VISITOR credentials: `(fold(nick), network_id) WHERE visitor_id IS NOT
  NULL`.

  Mirrors the `visitors` table's `(fold(nick), network_slug)` folded-unique
  index (GH #121, migration `20260628100000`) onto the Credential, keyed by
  `network_id` instead of the `network_slug` scalar. This is the per-network
  VISITOR identity guard on the Credential — the prerequisite for phase 4c
  (login resolves identity credential-first by `(fold(nick), network_id)`)
  and accretion (a cross-network nick-collision guard), and for phase 7
  (drop the `visitors`-table folded index once identity lives on the
  Credential).

  ## Additive — nothing dropped

  The `visitors`-table `(fold(nick), network_slug)` index STAYS through the
  functional phases; it is dropped only at the phase-7 contract. During the
  transition both indexes hold (the write-through keeps the visitor row and
  its credential in sync, so a folded-nick collision on one is a collision
  on the other). Expand-only.

  ## Partial: `WHERE visitor_id IS NOT NULL`

  Scoped to visitor credentials — users are a separate identity space
  (operator-bound, guarded by the existing `(user_id, network_id)` partial
  unique index), so a user credential and a visitor credential may share a
  nick on one network. This mirrors how the two subject-XOR partial indexes
  (phase 1) coexist.

  ## rfc1459 fold in pure SQL

  Bahamut (azzurra) folds A-Z plus the four national chars `[ ] \\ ~` ->
  `{ } | ^`. `lower()` handles A-Z (ASCII-only — matches
  `Grappa.IRC.Identifier.canonical_nick/1`, byte-level ASCII); the four
  `replace()`s handle the brackets. The expression here MUST stay
  character-identical to the query-side `Grappa.IRC.Identifier.nick_fold/1`
  macro AND to migration `20260628100000`'s `fold/1`, or SQLite won't use
  the index. Inlined — migrations stay self-contained (no module dep; they
  run under a possibly-truncated code load order).

  ## Duplicate collapse (defensive)

  A pre-existing case-variant duplicate among visitor credentials on one
  network would violate the new unique index. In a correctly-maintained DB
  this cannot exist: every visitor credential is written through
  `Credentials.upsert_visitor_credential/3` keyed on `(visitor_id,
  network_id)` from a visitor row whose `(fold(nick), network_slug)` is
  ALREADY unique. But — mirroring `20260628100000`'s belt-and-braces
  collapse — delete losers before the index is created so a hand-edited /
  drifted prod DB migrates cleanly rather than aborting. Survivor per
  `(fold(nick), network_id)`: connected > identified (auth_method) > newest.
  In a fresh/test DB this is a no-op (no rows).

  ## Cold deploy

  New migration — the hot deploy path skips `ecto.migrate`, so this MUST be
  cold-deployed (rides the end-of-crank COLD window with the rest of the
  #211 stack).
  """
  use Ecto.Migration

  # rfc1459 fold of a column expression, in pure SQL. ASCII `lower()` + the
  # four bracket replaces. MUST stay character-identical to
  # `Identifier.nick_fold/1` and `20260628100000`'s `fold/1`.
  defp fold(col) do
    "replace(replace(replace(replace(lower(#{col}), '[', '{'), ']', '}'), '\\', '|'), '~', '^')"
  end

  def up do
    # Collapse case-variant duplicates among VISITOR credentials BEFORE the
    # unique index would reject them. Keep one row per (fold(nick),
    # network_id): survivor = connected > identified > newest > highest id.
    # Scoped to `visitor_id IS NOT NULL` so user credentials are untouched.
    execute("""
    DELETE FROM network_credentials
    WHERE visitor_id IS NOT NULL
      AND id NOT IN (
        SELECT id
        FROM network_credentials c1
        WHERE c1.visitor_id IS NOT NULL
          AND id = (
            SELECT id
            FROM network_credentials c2
            WHERE c2.visitor_id IS NOT NULL
              AND c2.network_id = c1.network_id
              AND #{fold("c2.nick")} = #{fold("c1.nick")}
            ORDER BY (c2.connection_state = 'connected') DESC,
                     (c2.auth_method = 'nickserv_identify') DESC,
                     c2.updated_at DESC,
                     c2.id DESC
            LIMIT 1
          )
      )
    """)

    create unique_index(:network_credentials, ["#{fold("nick")}", "network_id"],
             name: :network_credentials_visitor_folded_nick_network_id_index,
             where: "visitor_id IS NOT NULL"
           )
  end

  def down do
    drop unique_index(:network_credentials, ["#{fold("nick")}", "network_id"],
           name: :network_credentials_visitor_folded_nick_network_id_index,
           where: "visitor_id IS NOT NULL"
         )
  end
end
