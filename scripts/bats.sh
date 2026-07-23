#!/usr/bin/env bash
# Run the bats-core test suite for host-side bash dispatchers (bin/*).
#
# Usage:
#   scripts/bats.sh                       # all tests: test/bin/ test/infra/ test/scripts/
#   scripts/bats.sh test/bin/grappa_test.bats
#
# Bats lives at vendor/bats-core (git submodule pinned to v1.9.0).
# Auto-initialised below on a fresh clone / fresh worktree — no manual
# `git submodule update --init` step needed.
#
# Bats runs ON THE HOST, against host-side scripts (bin/grappa). It is
# NOT containerised — no docker compose involvement. The grappa
# container is only invoked transitively when a test exercises a verb
# that shells out to docker (those tests stub `docker` via PATH).

. "$(dirname "$0")/_lib.sh"

cd "$SRC_ROOT"

bats_bin="$SRC_ROOT/vendor/bats-core/bin/bats"

if [ ! -x "$bats_bin" ]; then
    # Self-heal a fresh clone / fresh worktree: the bats-core submodule
    # isn't checked out by default (the gitlink + .git/modules entry are
    # shared, but each worktree gets its own vendor/bats-core working
    # tree). Init it rather than making the operator run the incantation
    # by hand — mirrors the testnet.sh submodule auto-init pattern so
    # check.sh works first-try from any worktree.
    printf 'scripts/bats.sh: vendor/bats-core missing — initialising submodule...\n' >&2
    git -C "$SRC_ROOT" submodule update --init vendor/bats-core >&2 \
        || die "vendor/bats-core init failed. Run: git -C \"$SRC_ROOT\" submodule update --init vendor/bats-core"
fi

if [ ! -x "$bats_bin" ]; then
    die "vendor/bats-core/bin/bats still not executable after submodule init."
fi

if [ $# -eq 0 ]; then
    set -- test/bin/ test/infra/ test/scripts/
fi

exec "$bats_bin" "$@"
