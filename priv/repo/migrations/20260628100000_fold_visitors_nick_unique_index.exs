defmodule Grappa.Repo.Migrations.FoldVisitorsNickUniqueIndex do
  @moduledoc """
  GH #121 — make the `visitors` uniqueness key rfc1459-folded so a
  different-case reconnect (`Mezmerize` -> `mezmerize`) resolves to the
  SAME row instead of spawning a duplicate visitor/session that orphans
  the nick.

  The original `(nick, network_slug)` unique index is CASE-SENSITIVE, so
  `Mezmerize` and `mezmerize` could both exist as separate rows. We swap
  it for a unique **expression index** on the rfc1459-folded nick — no
  denormalised column, the key is DERIVED (mirrors how `query_windows`
  already indexes `lower(target_nick)`, so the runtime lookup folds at
  query time with the matching fragment). Display case stays on `:nick`.

  ## rfc1459 fold in pure SQL

  Bahamut (azzurra) folds A-Z plus the four national chars `[ ] \\ ~` ->
  `{ } | ^`. `lower()` handles A-Z (ASCII-only — matches
  `Grappa.IRC.Identifier.canonical_nick/1`, which is deliberately
  byte-level ASCII); the four `replace()`s handle the brackets, and are
  collision-free (no target char `{ } | ^` is also a source char). The
  expression here MUST stay character-identical to the query-side
  `Grappa.IRC.Identifier.nick_fold/1` macro, or SQLite won't use the
  index. Inlined — migrations stay self-contained (no module dep; they
  run under a possibly-truncated code load order).

  ## Duplicate collapse

  An existing `(Mezmerize, mezmerize)` pair would violate the new unique
  index. Keep the most "authoritative" row per `(fold(nick),
  network_slug)`: identified (`password_encrypted NOT NULL`) over anon,
  then permanent (`expires_at IS NULL`) over expiring, then most recently
  touched, then highest `id`. The losers are DELETEd — CASCADE wipes
  their messages / accounts_sessions, which is correct: they are the
  duplicate *identity* this fix collapses, and the survivor is the one a
  reconnect should land on. In a fresh/test DB this is a no-op (no rows).

  ## Cold deploy

  New migration — the hot deploy path skips `ecto.migrate`, so this MUST
  be cold-deployed: the dedup + index swap must run before any session
  boot reads stale case-sensitive rows.
  """
  use Ecto.Migration

  # rfc1459 fold of a column expression, in pure SQL. ASCII `lower()` +
  # the four bracket replaces. Self-contained (see moduledoc).
  defp fold(col) do
    "replace(replace(replace(replace(lower(#{col}), '[', '{'), ']', '}'), '\\', '|'), '~', '^')"
  end

  def up do
    # Collapse case-variant duplicates BEFORE the unique index would
    # reject them. Keep one row per (fold(nick), network_slug): survivor
    # = identified > permanent > newest > highest id. `id NOT IN
    # (survivors)` deletes the rest; single-row groups keep their (sole)
    # survivor untouched.
    execute("""
    DELETE FROM visitors
    WHERE id NOT IN (
      SELECT id
      FROM visitors v1
      WHERE id = (
        SELECT id
        FROM visitors v2
        WHERE v2.network_slug = v1.network_slug
          AND #{fold("v2.nick")} = #{fold("v1.nick")}
        ORDER BY (v2.password_encrypted IS NOT NULL) DESC,
                 (v2.expires_at IS NULL) DESC,
                 v2.updated_at DESC,
                 v2.id DESC
        LIMIT 1
      )
    )
    """)

    drop unique_index(:visitors, [:nick, :network_slug])

    create unique_index(:visitors, ["#{fold("nick")}", "network_slug"],
             name: :visitors_nick_folded_network_slug_index
           )
  end

  def down do
    drop unique_index(:visitors, ["#{fold("nick")}", "network_slug"],
           name: :visitors_nick_folded_network_slug_index
         )

    create unique_index(:visitors, [:nick, :network_slug])
  end
end
