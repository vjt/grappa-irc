#!/usr/bin/env bats
#
# GH #1343 / M-S1 — the migration-version rule CLAUDE.md marks 🔴 ("GENERATE
# migrations with `mix ecto.gen.migration` — NEVER hand-write the timestamp")
# had zero mechanical enforcement. It was obeyed by convention only, and
# convention is what produced #1044 / #1038: two branches claiming version
# 20260810120000 under different basenames, which git fuses without a
# conflict marker.
#
# Why a duplicate version is worse than untidy, measured in Ecto's own source:
# the pending filter (`migrator.ex:647`) keys on the integer VERSION, never the
# filename, and `ensure_no_duplication!` only ever sees the PENDING set. On a
# database that has ALREADY applied that version both files drop out of
# pending, the run reports SUCCESS, and neither migration ever runs — for good.
# That is the regime production hits.
#
# This gate reads the FILESYSTEM rather than `git ls-files` on purpose: Ecto
# globs the directory, so an untracked `.exs` sitting there is a migration as
# far as the migrator is concerned.
#
# Not covered here, deliberately: this asserts nothing about the versions
# recorded in `schema_migrations` on any live host. The silent regime needs a
# preflight that compares versions against that table (CLAUDE.md's ⚠️), which
# `Grappa.Deploy.Preflight` does not do today — it filters changed git paths.

REPO_ROOT="$BATS_TEST_DIRNAME/../.."
MIGRATIONS_DIR="$REPO_ROOT/priv/repo/migrations"

# Round hand-typed stamps present on main when this gate landed (measured: 40
# of 86, including a run of 24 consecutive files from 20260717120000 to
# 20260811130000). A RATCHET, not an allowlist: the number may only fall.
# Every stamp `mix ecto.gen.migration` produces is UTC-to-the-second, so it
# ends in `0000` about once in 3600 — if a generated stamp really did land on
# one, raise this by one and say so in the commit.
HAND_TYPED_STAMP_CEILING=40

migration_files() {
    ls -1 "$MIGRATIONS_DIR"
}

@test "every migration is named <14-digit version>_<snake_case>.exs (#1343)" {
    files="$(migration_files)"
    count="$(printf '%s\n' "$files" | grep -c . || true)"

    # Anti-vacuity: a wrong path or an empty glob would make every assertion
    # in this file trivially true. 86 files on main when this landed.
    [ "$count" -ge 50 ] || {
        echo "expected >=50 migrations in $MIGRATIONS_DIR, found $count — the path is wrong:" >&2
        printf '%s\n' "$files" >&2
        return 1
    }

    malformed="$(printf '%s\n' "$files" | grep -vE '^[0-9]{14}_[a-z0-9_]+\.exs$' || true)"
    [ -z "$malformed" ] || {
        echo "migration filename(s) Ecto cannot parse into a version (#1343):" >&2
        printf '%s\n' "$malformed" >&2
        return 1
    }
}

@test "no two migrations claim the same version (#1343)" {
    duplicates="$(migration_files | cut -c1-14 | sort | uniq -d)"

    [ -z "$duplicates" ] || {
        echo "DUPLICATE migration version(s) — on a database that already applied" >&2
        echo "the version BOTH files silently drop out of pending and neither ever" >&2
        echo "runs, with the migrate step reporting success (#1343):" >&2
        for version in $duplicates; do
            printf '  %s:\n' "$version"
            migration_files | grep "^$version" | sed 's/^/    /'
        done >&2
        return 1
    }
}

@test "the count of hand-typed round stamps never grows (#1343)" {
    round="$(migration_files | grep -cE '^[0-9]{10}0000_' || true)"

    [ "$round" -le "$HAND_TYPED_STAMP_CEILING" ] || {
        echo "$round migrations carry a round (hand-typed) stamp, ceiling is $HAND_TYPED_STAMP_CEILING." >&2
        echo "Generate the stamp — 'mix ecto.gen.migration <name>' — instead of typing it:" >&2
        echo "a hand-typed round number is how #1044 and #1038 came to claim one version." >&2
        migration_files | grep -E '^[0-9]{10}0000_' >&2
        return 1
    }
}
