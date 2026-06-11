#!/usr/bin/env bash
# Run the bats-core test suite for host-side bash dispatchers (bin/*).
#
# Usage:
#   scripts/bats.sh                       # all tests under test/bin/
#   scripts/bats.sh test/bin/grappa_test.bats
#
# Bats lives at vendor/bats-core (git submodule pinned to v1.9.0).
# Initialise on a fresh clone with:
#
#   git submodule update --init vendor/bats-core
#
# Bats runs ON THE HOST, against host-side scripts (bin/grappa). It is
# NOT containerised — no docker compose involvement. The grappa
# container is only invoked transitively when a test exercises a verb
# that shells out to docker (those tests stub `docker` via PATH).

. "$(dirname "$0")/_lib.sh"

cd "$SRC_ROOT"

bats_bin="$SRC_ROOT/vendor/bats-core/bin/bats"

if [ ! -x "$bats_bin" ]; then
    die "vendor/bats-core/bin/bats not found. Run: git submodule update --init vendor/bats-core"
fi

if [ $# -eq 0 ]; then
    set -- test/bin/ test/infra/
fi

exec "$bats_bin" "$@"
