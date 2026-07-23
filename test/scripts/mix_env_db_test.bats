#!/usr/bin/env bats
#
# Bats suite for scripts/mix.sh — the MIX_ENV / DATABASE_PATH coupling.
#
# #364 docker S5: compose.yaml interpolates DATABASE_PATH from the HOST's
# MIX_ENV at container-create time (`grappa_${MIX_ENV:-dev}.db`).
# `mix.sh --env=prod` only overrode MIX_ENV *inside* the process, so a
# oneshot (or exec) still carried DATABASE_PATH=.../grappa_dev.db whenever
# the host MIX_ENV was dev/unset — and runtime.exs's PROD branch is the
# only one that reads DATABASE_PATH (config/{dev,test}.exs hardcode the db
# path and ignore the env var), so a `--env=prod` task then migrated/read
# the DEV db believing it was prod. The fix: mix.sh injects the matching
# prod DB path for `--env=prod`, and leaves dev/test to their compile-time
# config (injecting there is inert, and grappa_test.db wouldn't even match
# config/test.exs's MIX_TEST_PARTITION suffix).
#
# Scope: asserts the SHAPE of the docker invocation (the injected env).
# Stubs `docker` on PATH so no real container is touched; `git` is NOT
# stubbed — _lib.sh derives SRC_ROOT/REPO_ROOT from the real checkout.

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

@test "mix.sh --env=prod injects the PROD db path (not the host-interpolated dev db)" {
    run "$MIX_SH" --env=prod ecto.migrate
    [ "$status" -eq 0 ]
    grep -q 'MIX_ENV=prod' "$ARGV_LOG"
    grep -q 'DATABASE_PATH=/app/runtime/grappa_prod.db' "$ARGV_LOG"
    # The exact S5 bug: prod env with the dev db file. Must never happen.
    ! grep -q 'grappa_dev.db' "$ARGV_LOG"
}

@test "mix.sh --env=dev does NOT inject DATABASE_PATH (dev config owns the path)" {
    run "$MIX_SH" --env=dev ecto.migrate
    [ "$status" -eq 0 ]
    grep -q 'MIX_ENV=dev' "$ARGV_LOG"
    # dev reads config/dev.exs, not DATABASE_PATH — injecting would be
    # inert. Assert we don't pretend otherwise.
    ! grep -q 'DATABASE_PATH' "$ARGV_LOG"
}

@test "mix.sh --env=test does NOT inject DATABASE_PATH (test config owns the path)" {
    run "$MIX_SH" --env=test test
    [ "$status" -eq 0 ]
    grep -q 'MIX_ENV=test' "$ARGV_LOG"
    ! grep -q 'DATABASE_PATH' "$ARGV_LOG"
}
