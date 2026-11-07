# `duplicate_version_smoke` — two files claiming ONE version, on purpose

`migrations/` here is the `priv` of `Grappa.DuplicateVersionSmokeRepo`,
the scratch repo `test/grappa/migrations/duplicate_version_gate_test.exs`
starts against a temp sqlite file. Both files claim version
`20200101000001`, which is the #1044 / #1038 collision reproduced: two
branches naming one version under different basenames, which git fuses
without a conflict marker.

The duplication is the fixture. Do not "fix" it — the gate under test
(`Grappa.Deploy.MigrationAudit`, #1348) exists to refuse exactly this,
and it has to be refused at every door that migrates: the hot handler,
`Grappa.Release.migrate/0`, and `mix grappa.migrate` — and at the door
that only audits, the check every cold deploy runs before it stops
anything (`Grappa.Release.check_migrations/0` and
`mix grappa.check_migrations`, issue 1112).

Neither file is ever compiled or applied. `Ecto.Migrator.migrations/1`
parses the BASENAME and nothing else (`extract_migration_info/1`), so
the bodies exist only so the directory is not lying about what it holds.

## Why under `priv/repo/`, and why the project's own gates ignore it

The same two constraints that put `hot_migrate_smoke` here — see
`../hot_migrate_smoke/README.md` for the measurement:
`Ecto.Migrator.migrations_path/1` resolves under `priv/`, and
`scripts/_lib.sh` bind-mounts `priv/repo` alone, so a sibling
`priv/duplicate_version_smoke/` would silently resolve to main's tree
from every worktree.

Nothing else sees these files. `test/infra/migration_version_test.bats`
(the #1343 filename gate) globs `priv/repo/migrations` only, so this
deliberate duplicate does not trip it. `Grappa.Deploy.Preflight`
classifies `priv/repo/migrations/` only, so touching a file here does
not force a COLD deploy either.
