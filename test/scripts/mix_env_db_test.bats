#!/usr/bin/env bats
#
# Bats suite for scripts/mix.sh — the MIX_ENV / DATABASE_PATH coupling.
#
# #364 docker S5: compose.yaml interpolates DATABASE_PATH from the HOST's
# MIX_ENV at container-create time (`grappa_${MIX_ENV:-dev}.db`).
# `mix.sh --env=prod` only overrode MIX_ENV *inside* the process, so a
# oneshot (or exec) still carried DATABASE_PATH=.../grappa_dev.db whenever
# the host MIX_ENV was dev/unset — runtime.exs's prod branch then migrated
# and read the DEV db believing it was prod (and the reverse). The fix:
# mix.sh derives DATABASE_PATH from the SAME env it resolves and injects it
# alongside MIX_ENV, so the two can never disagree for a mix.sh invocation.
#
# Scope: asserts the SHAPE of the docker invocation (the injected env
# pair). Stubs `docker` on PATH so no real container is touched; `git` is
# NOT stubbed — _lib.sh derives SRC_ROOT/REPO_ROOT from the real checkout.

setup() {
    MIX_SH="$BATS_TEST_DIRNAME/../../scripts/mix.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Fake `docker` on PATH — records every invocation, exits 0. Same
    # recording shape as test/scripts/iex_observer_test.bats.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"

    export PATH="$FAKE_DIR:$PATH"
}

@test "mix.sh --env=prod targets the PROD db, not the host-interpolated dev db" {
    run "$MIX_SH" --env=prod ecto.migrate
    [ "$status" -eq 0 ]
    grep -q 'MIX_ENV=prod' "$ARGV_LOG"
    grep -q 'DATABASE_PATH=/app/runtime/grappa_prod.db' "$ARGV_LOG"
    # The exact S5 bug: prod env with the dev db file. Must never happen.
    ! grep -q 'grappa_dev.db' "$ARGV_LOG"
}

@test "mix.sh --env=dev targets the dev db" {
    run "$MIX_SH" --env=dev ecto.migrate
    [ "$status" -eq 0 ]
    grep -q 'MIX_ENV=dev' "$ARGV_LOG"
    grep -q 'DATABASE_PATH=/app/runtime/grappa_dev.db' "$ARGV_LOG"
    ! grep -q 'grappa_prod.db' "$ARGV_LOG"
}

@test "mix.sh --env=test targets the test db" {
    run "$MIX_SH" --env=test test
    [ "$status" -eq 0 ]
    grep -q 'MIX_ENV=test' "$ARGV_LOG"
    grep -q 'DATABASE_PATH=/app/runtime/grappa_test.db' "$ARGV_LOG"
}
