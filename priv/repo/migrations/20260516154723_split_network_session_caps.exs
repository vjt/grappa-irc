defmodule Grappa.Repo.Migrations.SplitNetworkSessionCaps do
  @moduledoc """
  U-1 (cap-honesty cluster) — split the single
  `networks.max_concurrent_sessions` column into two subject-aware
  caps so visitors and registered users can be capped independently:

    * `max_concurrent_visitor_sessions` — RENAMED from the old
      `max_concurrent_sessions`. Same three-valued contract: `nil` =
      unlimited, `0` = lock-down, `N>0` = the cap. The existing
      `max_concurrent_sessions_non_negative` CHECK constraint is
      auto-updated by sqlite to reference the new column name (CHECK
      expression rewriting is part of sqlite 3.25+'s RENAME COLUMN
      semantics).
    * `max_concurrent_user_sessions` — new. Nullable (NULL =
      unlimited; operator opts in via admin console) with DB-level
      DEFAULT 3 (mirrors the historic visitor cap per orchestrator
      brief). Schema mirrors the default so `Repo.insert/2` returns
      the struct with `max_concurrent_user_sessions: 3` rather than
      a nil that diverges from the DB row.

  ## Strategy: in-place ALTER, not table-recreate

  Using sqlite's `ALTER TABLE RENAME COLUMN` + `ADD COLUMN` avoids
  the table-recreate dance from
  `20260504020002_check_constraints_caps_auth_method_messages_kind.exs`
  (which had to recreate `network_servers` to refresh dangling FK
  refs to the dropped `networks_old`). Both ALTER paths leave the
  table identity intact, so dependent FK refs in `network_servers`,
  `network_credentials`, `messages`, `read_cursors`, and
  `query_windows` keep resolving to the live `networks` table
  without any per-dependent-table recreate.

  ## Constraint rename — name stays, expression rewrites

  Sqlite 3.25+ rewrites CHECK constraint expressions during RENAME
  COLUMN, so the constraint named
  `max_concurrent_sessions_non_negative` keeps firing but against
  the renamed column (`max_concurrent_visitor_sessions`). The CHECK
  constraint NAME is NOT auto-renamed by sqlite and this migration
  does NOT rename it either — renaming the constraint would require
  a full table-recreate dance (see `20260504020002_*` for the FK-ref
  refresh cost on every dependent table), which U-1 explicitly
  avoids. `check_constraints_test` matches on the unchanged
  `max_concurrent_sessions_non_negative` name and asserts the
  expression now fires against the renamed column — the test is
  honest about the post-U-1 reality: name unchanged, expression
  rewritten by sqlite.

  ## CHECK on the new column

  `max_concurrent_user_sessions` does NOT get a DB-level CHECK
  constraint in this migration. The changeset's
  `validate_non_negative_or_nil/2` enforces non-negativity at the
  Ecto layer, which catches every production write path. A future
  defense-in-depth bucket may add the DB CHECK via the table-recreate
  dance; the marginal value (operator typo via raw SQL — vanishingly
  rare on a single-operator bouncer) does not justify recreating
  5 dependent tables in U-1.

  Logic split (admission reads both columns per subject) lands in
  U-2; this migration only changes the schema.

  Deploy: COLD per `feedback_cluster_with_migration_must_cold` —
  hot path skips `mix ecto.migrate`; new column 500s on first query
  post-reload.

  ## Compat

  `down/0` uses `ALTER TABLE ... DROP COLUMN`, which requires sqlite
  3.35+ (released 2021-03). The production runtime is the
  `grappa` container's alpine base, currently shipping sqlite 3.46+
  (well above the floor). If a future operator pins to an older
  image, the rollback path 500s here — flag at container-image
  bump time, not at migration time.
  """
  use Ecto.Migration

  def up do
    execute("ALTER TABLE networks RENAME COLUMN max_concurrent_sessions TO max_concurrent_visitor_sessions")
    execute("ALTER TABLE networks ADD COLUMN max_concurrent_user_sessions INTEGER NULL DEFAULT 3")
  end

  def down do
    execute("ALTER TABLE networks DROP COLUMN max_concurrent_user_sessions")
    execute("ALTER TABLE networks RENAME COLUMN max_concurrent_visitor_sessions TO max_concurrent_sessions")
  end
end
