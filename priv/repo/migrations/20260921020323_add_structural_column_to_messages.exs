defmodule Grappa.Repo.Migrations.AddStructuralColumnToMessages do
  @moduledoc """
  issue 2228 leg B — give the #2176 structural-mode exemption a real column and
  put it in the four covering families, so the `/messages/count` aggregates
  stop fetching the table row to read `meta`.

  ## What broke

  #2176 added a per-ROW exemption to the presence filter: a `:mode` row the
  server tagged structural at persist time (a ban, a key, a limit — never a
  `+o`) survives the fold. It was expressed as
  `json_extract(meta, '$.structural') IS 1`, and `meta` is in no index. So
  every door that hides presence went back to seeking the composite and then
  fetching the table row for EVERY post-cursor row — the exact shape #393
  measured as that day's incident and #1372's moduledoc warns about, in the
  sentence that says a PARTIAL widening does not restore COVERING.

  ## The measurement this migration is built on

  Arbitrated on a `.backup` of a 403,907-row copy of prod taken from a
  `mode=ro` handle (the live staging file was measured to be moving under
  concurrent writes — 403905 then 403907 — so a copy was frozen first).
  Partition `#linux`, cursor near the partition head, SQL captured verbatim off
  `[:grappa, :repo, :query]` and run in BOTH orders so a warm cache cannot
  explain the gap:

      form A (today, with the disjunct)   SEARCH … USING INDEX …          266 / 260 / 306 ms
      form B (disjunct removed)           SEARCH … USING COVERING INDEX …  95 / 104 /  93 ms

  ~2.8x, identical counts (53,921 both sides). The issue's own number was 3.3x
  on another host — same shape, different absolutes.

  ## The thing that decided the DESIGN

  On that corpus `json_extract(meta, '$.structural') IS 1` matches exactly ONE
  row in the whole database and ZERO in the measured partition, while 310,176
  rows carry a non-trivial `meta` (the positive control that says the extractor
  works). So the cost is NOT evaluating the predicate on many rows — it is that
  `meta` must be READ for every row, and it lives only in the table. That is
  precisely what a column in the index removes, and it is why the cure is a
  column rather than a cheaper-looking rewrite of the JSON reach.

  ⚠️ That rarity is measured on ONE subject and three networks of a staging
  restore. On a channel with an op war it may not hold; nothing here depends on
  it holding — it explains the choice, it does not size the win.

  ## Shape

  EXPAND only. The column is added, backfilled and indexed; `meta.structural`
  is left exactly where it is, because it is still the writer's tag and cic
  reads it (`presence_filter_test` pins the two spellings against each other).
  Nothing is dropped in this slice, so the running old code — which reads the
  JSON path — is unaffected by the new column and the widened indexes.

  The backfill is a full scan of `messages` once. On the corpus above it is one
  row; the SCAN is the cost, not the UPDATE.

  ## Byte-identity is load-bearing, as ever

  The two expressions already in these indexes are reproduced here
  CHARACTER-IDENTICAL to what `sqlite_master` currently holds (read off a
  migrated database, not copied from the 20260816013504 source). SQLite matches
  indexed expressions after parsing rather than textually, but the JSON PATH
  may not differ, and `lower(...)` must stay the `Identifier.nick_fold_sql/1`
  spelling. Inlined rather than imported because migrations run before `lib/`
  is loaded.

  ## Deploy

  New migration file — Preflight Class 5 forces COLD. One transaction carries
  the add, the backfill and four index rebuilds; the number that sizes the
  window is that transaction. #1372 measured the four rebuilds alone at
  9.55-9.85 s locally on 1.9M rows and extrapolated 30-45 s on prod's
  substrate; this adds one full scan and one narrow column to the same work.
  Nobody has measured it on prod's substrate — that is an extrapolation, not an
  observation.

  See DESIGN_NOTES 2026-09-21.
  """
  use Ecto.Migration

  # The ASCII fold, pure SQL. MUST stay character-identical to
  # `Grappa.IRC.Identifier.nick_fold_sql/1`.
  defp fold(col), do: "lower(#{col})"

  # The `meta.new_nick` half of `exclude_own_authored/3` (#1372 P-S1).
  defp new_nick, do: "json_extract(meta, '$.new_nick')"

  # The four covering families, by name, with the column list they carry TODAY.
  # `structural` goes at the TAIL: the seek prefix is unchanged, so no plan that
  # works today can stop working, and the column only has to be PRESENT for the
  # statement to be covered.
  defp families do
    [
      {:messages_user_id_network_id_channel_id_kind_index,
       ["user_id", "network_id", "channel", "id", "kind", fold("sender"), new_nick()]},
      {:messages_visitor_id_network_id_channel_id_kind_index,
       ["visitor_id", "network_id", "channel", "id", "kind", fold("sender"), new_nick()]},
      {:messages_user_id_network_id_dm_coalesce_fold_id_kind_index,
       [
         "user_id",
         "network_id",
         fold("COALESCE(dm_with, channel)"),
         "id",
         "kind",
         fold("sender"),
         new_nick()
       ]},
      {:messages_visitor_id_network_id_dm_coalesce_fold_id_kind_index,
       [
         "visitor_id",
         "network_id",
         fold("COALESCE(dm_with, channel)"),
         "id",
         "kind",
         fold("sender"),
         new_nick()
       ]}
    ]
  end

  def up do
    alter table(:messages) do
      add :structural, :boolean, null: false, default: false
    end

    # Derive the column from the tag that is already on disk. `IS 1` rather
    # than `= 1` for the same reason the fragment it replaces used it: an
    # untagged row yields NULL, and NULL is "not true" here.
    execute("UPDATE messages SET structural = 1 WHERE json_extract(meta, '$.structural') IS 1")

    for {name, cols} <- families() do
      drop index(:messages, cols, name: name)
      create index(:messages, cols ++ ["structural"], name: name)
    end
  end

  def down do
    for {name, cols} <- families() do
      drop index(:messages, cols ++ ["structural"], name: name)
      create index(:messages, cols, name: name)
    end

    alter table(:messages) do
      remove :structural
    end
  end
end
