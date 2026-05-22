defmodule Grappa.Repo.Migrations.AddArchiveCoveringIndexes do
  @moduledoc """
  REV-B / H18 (2026-05-22 codebase review) — covering expression
  indexes for `Grappa.Scrollback.list_archive/3`.

  ## Background

  `list_archive/3` (`lib/grappa/scrollback.ex:445`) builds the per-
  subject Archive section by grouping every message row in a
  `(subject, network_id)` pair on
  `COALESCE(dm_with, channel)` — the canonical "per-window key" rule
  (CP14 B3 unified DMs across own-nick rotation, so the DM peer goes
  to `dm_with` and channel rows stay at `channel`; the COALESCE picks
  whichever is the window-shaped column).

  The existing post-CP14 indexes cover the per-window LIST query
  shape (`(subject_id, network_id, channel, server_time)` and
  `(subject_id, network_id, dm_with, server_time)`) used by
  `Scrollback.fetch/5`. They do NOT cover the archive GROUP BY shape —
  the planner must scan the full per-subject per-network row set and
  sort it for the grouping, every archive open.

  Today's row counts are tiny (vjt's prod dev-tier has ~3k messages),
  so the bound is invisible. On a heavy user with 50k+ messages this
  is `N×log(N)` per archive open; the cost grows with the row count,
  not the archive entry count. Index it now while the table is small
  — the migration is cheap and additive, the planner will pick up the
  index automatically.

  ## Index shape

  Expression index on the canonical archive key plus `server_time`
  as a trailing covering column:
  `(<subject_id>, network_id, COALESCE(dm_with, channel), server_time)`.

  Trailing `server_time` makes the index covering for both target
  query shapes:

    * `list_archive/3` — `GROUP BY COALESCE(dm_with, channel)` +
      `MAX(server_time)` per group: with `server_time` as the trailing
      column, the planner can walk the index, group on the COALESCE
      expression, and read the max server_time in-index (no rowid
      lookup, no temp B-tree).
    * `fetch/5` DM-bidirectional OR-shape
      (`channel = ^peer OR dm_with = ^peer`): the COALESCE expression
      collapses both arms to a single column match — sharper filter
      than the existing CP14-H1 `(user, network_id, dm_with,
      server_time)` index which catches only the dm_with arm directly
      — and the trailing `server_time` covers the `ORDER BY
      server_time DESC` without a temp sort. The pre-existing
      dm_with-leading composite stays in place (harmless, planner-
      chosen-or-not); the regression test at
      `test/grappa/scrollback_test.exs:1075/1097` was updated to
      accept either subject-leading composite (CP14 H1's invariant —
      no cross-subject scan — remains pinned via the `refute` against
      the subject-less index).

  Subject discriminator is the XOR `(user_id, visitor_id)` pair (per
  the `messages_subject_xor` CHECK constraint at table-create time):
  one index per subject column, gated by a partial-index `WHERE` clause
  so each index only covers rows of its subject kind. Mirrors the
  existing per-subject composite-index pattern at
  `20260508132130_messages_dm_with_subject_composite_indexes`.

  ## Verification

  Post-migrate, the planner should pick up the index on the archive
  query:

      EXPLAIN QUERY PLAN
        SELECT COALESCE(dm_with, channel) AS target,
               MAX(server_time) AS last_activity,
               COUNT(*) AS row_count
          FROM messages
         WHERE user_id = '...' AND network_id = 1
         GROUP BY COALESCE(dm_with, channel);

  Expected output line: `SEARCH messages USING INDEX
  messages_archive_user_idx`. SQLite is permitted to fall through to
  `SCAN messages` on very small tables — that is fine; the index
  exists for the moment row counts grow.

  ## Boundary

  Pure additive — no schema column changes, no data rewrites. Per
  CLAUDE.md "Cluster with new migration MUST cold-deploy" the parent
  bucket runs `scripts/deploy.sh` in COLD mode so the migration is
  applied at boot.
  """
  use Ecto.Migration

  def change do
    # User-scoped archive query (Scrollback.list_archive/3 + user subject path).
    # Trailing `server_time` makes the index covering for the
    # `MAX(server_time)` per-group aggregate AND for the DM-fetch
    # `ORDER BY server_time DESC` path. Expression-index column
    # declared via string literal — Ecto's `index/3` passes strings
    # through verbatim into the SQLite DDL.
    create index(
             :messages,
             ["user_id", "network_id", "COALESCE(dm_with, channel)", "server_time"],
             name: :messages_archive_user_idx,
             where: "user_id IS NOT NULL"
           )

    # Visitor-scoped archive query (Scrollback.list_archive/3 + visitor subject path).
    # Mirror of the user index — visitor rows have `user_id IS NULL` per
    # the `messages_subject_xor` CHECK constraint.
    create index(
             :messages,
             ["visitor_id", "network_id", "COALESCE(dm_with, channel)", "server_time"],
             name: :messages_archive_visitor_idx,
             where: "visitor_id IS NOT NULL"
           )
  end
end
