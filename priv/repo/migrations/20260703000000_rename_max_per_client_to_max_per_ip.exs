defmodule Grappa.Repo.Migrations.RenameMaxPerClientToMaxPerIp do
  @moduledoc """
  #171 — collapse the two device-scoped admission caps into ONE
  per-(source-IP, network) clone cap.

  The per-(client, network) cap dimension is removed entirely (visitors
  have no stable client identity; the only durable handle is the source
  IP, and authenticated users are capped per-IP too). The single
  remaining knob is renamed to reflect its new meaning:

    * `networks.max_per_client` → `networks.max_per_ip`.

  ## Strategy: in-place ALTER, not table-recreate

  `ALTER TABLE RENAME COLUMN` leaves the table identity intact, so
  dependent FK refs (`network_servers`, `network_credentials`,
  `messages`, `read_cursors`, `query_windows`) keep resolving to the
  live `networks` table with no per-dependent-table recreate — same
  choice U-1 (`20260516154723_split_network_session_caps`) made for the
  `max_concurrent_sessions` rename, and it sidesteps the FK-ref-refresh
  cost + the `messages`-column-drift trap of the table-recreate dance.

  ## Constraint rename — name stays, expression rewrites

  SQLite 3.25+ rewrites CHECK constraint expressions during RENAME
  COLUMN, so `max_per_client_non_negative` keeps firing but now against
  `max_per_ip`. SQLite does NOT auto-rename the constraint, and neither
  does this migration (renaming it would force the full table-recreate
  dance). `check_constraints_test` matches on the unchanged
  `max_per_client_non_negative` name and asserts the expression now
  fires against the renamed column — honest about the post-#171 reality:
  name unchanged, expression rewritten by SQLite. Same pattern U-1 set.

  Deploy: COLD per `feedback_cluster_with_migration_must_cold`.
  """
  use Ecto.Migration

  def up do
    execute("ALTER TABLE networks RENAME COLUMN max_per_client TO max_per_ip")
  end

  def down do
    execute("ALTER TABLE networks RENAME COLUMN max_per_ip TO max_per_client")
  end
end
