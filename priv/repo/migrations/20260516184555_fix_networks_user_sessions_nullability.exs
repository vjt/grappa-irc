defmodule Grappa.Repo.Migrations.FixNetworksUserSessionsNullability do
  @moduledoc """
  U-1 follow-up — fix prod schema drift on
  `networks.max_concurrent_user_sessions`.

  ## The drift

  The original U-1 migration
  (`20260516154723_split_network_session_caps.exs`) declares
  `ADD COLUMN max_concurrent_user_sessions INTEGER NULL DEFAULT 3`.
  An earlier orchestrator-session version of that migration body
  (since edited but `schema_migrations` is idempotent on version)
  applied as `INTEGER NOT NULL DEFAULT 3` on the prod DB. Fresh test
  DBs apply the corrected source as `INTEGER NULL` per migration
  intent — so prod and fresh-from-zero diverge.

  The asymmetry breaks the cap-honesty contract: visitor cap can be
  cleared to nil (= unlimited), user cap cannot. `Networks.AdminWire`
  and `Networks.Network`'s changeset both accept nil; the
  `update_network_caps/2` PATCH from cic would 500 at sqlite for
  user_sessions but succeed for visitor_sessions. Asymmetric
  three-valued contract → not honest.

  ## Strategy

  `ALTER TABLE ... DROP COLUMN` + `ALTER TABLE ... ADD COLUMN`. Both
  ops are in-place on sqlite 3.35+ (alpine ships 3.46+, see
  `## Compat` on the original migration). The pre-DROP value backfill
  is preserved post-ADD because we re-run the same DEFAULT 3
  expression — every existing row gets 3 again, matching pre-drift
  state. Production DB has a single networks row (azzurra, id=1,
  user_sessions=3) so the DEFAULT does the right thing.

  Fresh-from-zero test DBs already have the column as NULL DEFAULT 3
  per the original migration — this fix-up is a no-op shape-wise
  there (DROP + ADD with same constraints = same end shape).

  ## Why a separate migration, not amend

  Amending `20260516154723` and bumping `schema_migrations` manually
  would silently break any operator who applied between commits.
  A new migration version is the honest path: every DB advances
  through the same recorded sequence regardless of when they first
  applied U-1.

  ## Compat

  Same as the parent migration — `ALTER TABLE ... DROP COLUMN`
  requires sqlite 3.35+ (2021-03). Production alpine container is
  3.46+; flag at any future image-base downgrade.
  """
  use Ecto.Migration

  def up do
    execute("ALTER TABLE networks DROP COLUMN max_concurrent_user_sessions")
    execute("ALTER TABLE networks ADD COLUMN max_concurrent_user_sessions INTEGER DEFAULT 3")
  end

  def down do
    # Symmetric: re-apply the (drifted) NOT NULL constraint on
    # rollback. Operators with the corrected source need to know
    # this rollback reverts to the asymmetric contract.
    execute("ALTER TABLE networks DROP COLUMN max_concurrent_user_sessions")
    execute("ALTER TABLE networks ADD COLUMN max_concurrent_user_sessions INTEGER NOT NULL DEFAULT 3")
  end
end
