defmodule Grappa.Repo.Migrations.AddOwnAuthoredExprsToMessagesCoveringIndexes do
  @moduledoc """
  #1372 P-S1 — restore the COVERING property #393 shipped for the
  `count_after_split/6` aggregate, which #532 A and #576 defeated.

  ## What broke

  #393 (2026-07-25) put `kind` at the tail of both covering families
  precisely so the content-vs-event GROUP BY could be answered from the
  index with no table touch — its moduledoc records the prod measurement,
  80ms → 5-7ms, ~15x, on the query behind that day's incident.

  Four and six days later `exclude_own_authored/3` was added to the SAME
  aggregate (#532 A presence, #576 content). It reads two things that were
  in NO index on `messages`: `lower(sender)` and
  `json_extract(meta, '$.new_nick')`. So SQLite went back to seeking
  `(subject, network_id, channel, id > ?)` on the index and then fetching
  the table row for EVERY post-cursor row to evaluate them — the exact
  shape #393 measured as the incident. The worst window is the one that
  matters: a channel whose read cursor is far behind, which is what the
  cold-load `/me` seed and the per-channel join reply both route through
  (`WindowCounts.snapshot/7`).

  ## The measurement this migration is built on

  650k rows, prod-shaped distribution, no `ANALYZE` (prod has no
  `sqlite_stat*` and the app never runs it, so the planner must be measured
  on default estimates), channel window of 103,209 post-cursor rows, SQL
  captured verbatim off `[:grappa, :repo, :query]` rather than rebuilt:

      before   SEARCH … USING INDEX …channel_id_kind_index          175,576 page fetches
      after    SEARCH … USING COVERING INDEX …channel_id_kind_index   1,886 page fetches

  93x fewer page fetches, identical results. Page fetches rather than
  wall-clock on purpose: they are deterministic and host-independent, and
  the 14x ratio on page MISSES (23,427 → 1,885) lands on the same ~15x
  #393 recorded from an entirely independent measurement.

  Both expressions are load-bearing — widening with `lower(sender)` alone
  was measured and does NOT restore COVERING.

  ## Why widen, and not seek-and-subtract

  The alternative shape was to count own-authored rows as a second seek on
  a `sender`-leading index and subtract. Measured on the same corpus, it
  costs **+37% on INSERT** (0.67s vs 0.48s for 50k rows, 3 reps) because it
  adds four NEW b-trees to the highest-write-rate table in the codebase,
  where widening an existing entry by two short values adds none —
  **no measurable insert cost at all** (0.48/0.49/0.48s against a
  0.48/0.50/0.50s baseline). It is also not a subtraction: the predicate is
  a disjunction whose arms overlap (a case-only self-rename matches BOTH
  `sender` and `new_nick`), so it needs inclusion-exclusion across three
  seeks, each reproducing the GROUP BY bucketing, to replace one query.
  Dearer and more fragile, for a read that is already served.

  Index size grows 348 MB → 373 MB (+7.2%) at 650k rows. The sibling
  commit that drops the four dead `dm_with` indexes (#1372 P-S4) more than
  pays that back: together they are 25% FASTER on INSERT and 22% smaller
  than today.

  ## Byte-identity is load-bearing, as ever

  The DM expression MUST stay character-identical to
  `Identifier.nick_fold_sql/1` applied to `COALESCE(dm_with, channel)`, and
  the `sender` fold to the same function applied to `sender`, or SQLite
  silently stops recognising the query as index-eligible — no error, just
  the old per-row fetch. Inlined here because migrations run before `lib/`
  is loaded (same reason as `20260725120000`); `ScrollbackTest`'s two-arm
  pin guards both literals plus the `$.new_nick` JSON path.

  Whitespace and the table alias may differ between this DDL and the
  emitted query (`json_extract(m0."meta", '$.new_nick')`) — SQLite matches
  indexed expressions after parsing, not textually, and that was measured,
  not assumed. The JSON PATH may not differ.

  ## Deploy

  New migration file — Preflight Class 5 forces **COLD**. The four
  `CREATE INDEX` builds took 2.6s in total over 650k rows locally (per-index
  split in the PR body); they share one migration transaction, so schedule
  off a traffic peak. Expand-class: no schema-shape change, so the running
  old code is unaffected by the added index columns.

  See DESIGN_NOTES 2026-08-16.
  """
  use Ecto.Migration

  # The ASCII fold, pure SQL. MUST stay character-identical to
  # `Grappa.IRC.Identifier.nick_fold_sql/1` (#525 narrowed it from the
  # rfc1459 four-`replace()` form to plain `lower()`).
  defp fold(col), do: "lower(#{col})"

  # The `meta.new_nick` half of `exclude_own_authored/3`. No lib-side SSOT
  # exists — it is an Ecto `fragment` at `scrollback.ex:724`/`:740` — so the
  # pin test carries the guard.
  defp new_nick, do: "json_extract(meta, '$.new_nick')"

  def up do
    # (A) channel family
    drop index(:messages, ["user_id", "network_id", "channel", "id", "kind"],
          name: :messages_user_id_network_id_channel_id_kind_index
        )

    create index(
             :messages,
             ["user_id", "network_id", "channel", "id", "kind", fold("sender"), new_nick()],
             name: :messages_user_id_network_id_channel_id_kind_index
           )

    drop index(:messages, ["visitor_id", "network_id", "channel", "id", "kind"],
          name: :messages_visitor_id_network_id_channel_id_kind_index
        )

    create index(
             :messages,
             ["visitor_id", "network_id", "channel", "id", "kind", fold("sender"), new_nick()],
             name: :messages_visitor_id_network_id_channel_id_kind_index
           )

    # (B) DM folded-COALESCE family
    drop index(
           :messages,
           ["user_id", "network_id", fold("COALESCE(dm_with, channel)"), "id", "kind"],
           name: :messages_user_id_network_id_dm_coalesce_fold_id_kind_index
         )

    create index(
             :messages,
             [
               "user_id",
               "network_id",
               fold("COALESCE(dm_with, channel)"),
               "id",
               "kind",
               fold("sender"),
               new_nick()
             ],
             name: :messages_user_id_network_id_dm_coalesce_fold_id_kind_index
           )

    drop index(
           :messages,
           ["visitor_id", "network_id", fold("COALESCE(dm_with, channel)"), "id", "kind"],
           name: :messages_visitor_id_network_id_dm_coalesce_fold_id_kind_index
         )

    create index(
             :messages,
             [
               "visitor_id",
               "network_id",
               fold("COALESCE(dm_with, channel)"),
               "id",
               "kind",
               fold("sender"),
               new_nick()
             ],
             name: :messages_visitor_id_network_id_dm_coalesce_fold_id_kind_index
           )
  end

  def down do
    # Back to the #393 shape: same four names, without the two trailing
    # expressions. The aggregate returns to a per-row table fetch — that is
    # what `down` means here, and the pin test reddens on it, correctly.
    drop index(
           :messages,
           ["user_id", "network_id", "channel", "id", "kind", fold("sender"), new_nick()],
           name: :messages_user_id_network_id_channel_id_kind_index
         )

    create index(:messages, ["user_id", "network_id", "channel", "id", "kind"],
             name: :messages_user_id_network_id_channel_id_kind_index
           )

    drop index(
           :messages,
           ["visitor_id", "network_id", "channel", "id", "kind", fold("sender"), new_nick()],
           name: :messages_visitor_id_network_id_channel_id_kind_index
         )

    create index(:messages, ["visitor_id", "network_id", "channel", "id", "kind"],
             name: :messages_visitor_id_network_id_channel_id_kind_index
           )

    drop index(
           :messages,
           [
             "user_id",
             "network_id",
             fold("COALESCE(dm_with, channel)"),
             "id",
             "kind",
             fold("sender"),
             new_nick()
           ],
           name: :messages_user_id_network_id_dm_coalesce_fold_id_kind_index
         )

    create index(
             :messages,
             ["user_id", "network_id", fold("COALESCE(dm_with, channel)"), "id", "kind"],
             name: :messages_user_id_network_id_dm_coalesce_fold_id_kind_index
           )

    drop index(
           :messages,
           [
             "visitor_id",
             "network_id",
             fold("COALESCE(dm_with, channel)"),
             "id",
             "kind",
             fold("sender"),
             new_nick()
           ],
           name: :messages_visitor_id_network_id_dm_coalesce_fold_id_kind_index
         )

    create index(
             :messages,
             ["visitor_id", "network_id", fold("COALESCE(dm_with, channel)"), "id", "kind"],
             name: :messages_visitor_id_network_id_dm_coalesce_fold_id_kind_index
           )
  end
end
