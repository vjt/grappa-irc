defmodule Grappa.Repo.Migrations.DropDeadMessagesDmWithIndexes do
  @moduledoc """
  #1372 P-S4 — drop four indexes on `messages` that no read can use.

  ## What they were for, and why nothing needs them

      (user_id|visitor_id, network_id, dm_with, server_time)   20260508132130
      (user_id|visitor_id, network_id, dm_with, id)            20260722202612

  `20260722202612`'s own moduledoc states the purpose of the `id` twins: they
  exist for symmetry, "so the `dm_with=?` arm … is index-seekable". Three days
  later #393 DELETED that arm — `where_dm_peer/2` collapsed the OR-disjunction
  into the single folded equality `lower(COALESCE(dm_with, channel)) = ?`.

  There is no bare `m.dm_with == ^…` predicate left anywhere in `lib/`: every
  reference is `nick_fold(dm_with)` or `nick_fold(COALESCE(dm_with, channel))`,
  and a plain B-tree on the RAW column cannot seek either — `dm_with` is stored
  case-preserved (the #372 nick display rule), so every match folds. #393
  applied exactly this reasoning when it dropped the sibling
  `..._channel_id_index` composites; it simply did not extend it to the
  `dm_with` family.

  ## Measured, not just grepped

  An 11-shape `EXPLAIN QUERY PLAN` sweep over the `messages` read shapes
  (channel fetch, DM fetch, both `fetch_after`, both `count_after_split`, both
  content tails, the `list_archive` GROUP BY, `delete_for_dm`, and the
  `server_time` page) on a 650k-row prod-shaped corpus: **every plan is
  byte-identical with these four present and with them dropped.** Nothing was
  using them.

  What they DO cost is write amplification on the highest-write-rate table in
  the codebase — four B-tree entries maintained on every scrollback INSERT.
  Dropping them: 50k single-row INSERTs go 0.50/0.50/0.48s → 0.35/0.36/0.36s,
  and `messages` index bytes 348 MB → 246 MB. Paired with the sibling commit
  that widens the covering families (#1372 P-S1, which is write-neutral on its
  own), the two together are **25% faster on INSERT and 22% smaller than main
  is today**.

  ## Scope

  The two `messages_archive_*_idx` from `20260522073826` are deliberately NOT
  touched: DESIGN_NOTES 17317-17332 records their #372 staleness and a
  deliberate KEEP, so they are a documented deferral, not a new finding.

  `down/0` recreates all four, so the decision is reversible — but it recreates
  a cost with no reader, which is the point of dropping them.

  New migration file — Preflight Class 5 forces **COLD**. Contract-class
  (removes structure), but nothing reads it, which is what the sweep
  establishes.

  See DESIGN_NOTES 2026-08-16.
  """
  use Ecto.Migration

  def up do
    drop index(:messages, ["user_id", "network_id", "dm_with", "server_time"],
          name: :messages_user_id_network_id_dm_with_server_time_index
        )

    drop index(:messages, ["visitor_id", "network_id", "dm_with", "server_time"],
          name: :messages_visitor_id_network_id_dm_with_server_time_index
        )

    drop index(:messages, ["user_id", "network_id", "dm_with", "id"],
          name: :messages_user_id_network_id_dm_with_id_index
        )

    drop index(:messages, ["visitor_id", "network_id", "dm_with", "id"],
          name: :messages_visitor_id_network_id_dm_with_id_index
        )
  end

  def down do
    create index(:messages, ["user_id", "network_id", "dm_with", "server_time"],
             name: :messages_user_id_network_id_dm_with_server_time_index
           )

    create index(:messages, ["visitor_id", "network_id", "dm_with", "server_time"],
             name: :messages_visitor_id_network_id_dm_with_server_time_index
           )

    create index(:messages, ["user_id", "network_id", "dm_with", "id"],
             name: :messages_user_id_network_id_dm_with_id_index
           )

    create index(:messages, ["visitor_id", "network_id", "dm_with", "id"],
             name: :messages_visitor_id_network_id_dm_with_id_index
           )
  end
end
