# `hot_migrate_smoke` — a migration set owned by a test, not by the repo

`migrations/` here is the `priv` of `Grappa.HotMigrateSmokeRepo`, the
scratch repo `test/grappa/migrations/hot_deploy_migrate_test.exs` starts
against a temp sqlite file. It is **never** applied to `Grappa.Repo`:
`mix ecto.migrate` and `Grappa.Release.migrate/0` read
`priv/repo/migrations` only, and nothing globs `priv/repo/**`.

Three files, and the set never grows: a BASE, a CONTRACT, an EXPAND.
That closure is the point — the #41 test asserts things like "nothing
unapplied → empty", which is only a truthful statement about a set the
test controls. Reading the project's own migration set made those
assertions fail on every PR that added a migration (measured: 14/14 red
on the #124 branch).

## Why under `priv/repo/`, which reads odd

Two constraints, both measured, and their intersection is this path:

* `Ecto.Migrator.migrations_path/1` — the function the production code
  under test calls — resolves `Application.app_dir(:grappa, priv) <>
  "/migrations"`. The directory must therefore live under `priv/` in the
  repo; a `System.tmp_dir!()` one cannot be reached.
* `scripts/_lib.sh` bind-mounts a worktree's sources over main's checkout
  one directory at a time, and of `priv/` it mounts `priv/repo` alone. A
  sibling `priv/hot_migrate_smoke/` would be invisible from every
  worktree — the fixture would silently resolve to main's tree.

`priv/repo/migrations/` itself is not an option: `Grappa.Repo` would
apply these to production, and the release workflow counts the files in
it.

Adding a file here changes what the #41 test measures. Adding one to
`priv/repo/migrations/` does not.

## A second reader: the pre-stop migration check (issue 1112)

`test/grappa/migrations/duplicate_version_gate_test.exs` borrows this set
read-only for the passing arm of `Grappa.Release.check_migrations/0`: it
applies the BASE alone to a temp sqlite file of its own, then asserts that
the check leaves the migration statuses exactly as it found them — one up,
two down. So that test counts these files too, and a fourth one changes
its numbers as well.
