#!/usr/bin/env bats
#
# Bats suite for scripts/iex.sh + scripts/observer.sh — the two live-node
# debug attach scripts.
#
# #364 docker S2: both used to `iex -S mix` (booting a SECOND full
# Grappa.Application inside the running container — duplicate IRC sessions,
# sqlite WAL contention). observer.sh additionally routed through
# `in_container` = `docker compose exec -T` (no TTY for the observer_cli
# TUI). The fix: attach to the LIVE node instead.
#   - iex.sh      → `bin/grappa remote-shell` (iex --remsh grappa@grappa).
#   - observer.sh → a throwaway local node that runs observer_cli AGAINST
#                   the live node (`mix run --no-start` so no app boots),
#                   over an interactive (no -T) exec.
#
# Scope: asserts the SHAPE of the docker invocation (no second app boot,
# TTY-full attach). Stubs `docker` on PATH so no real container is touched.
# The behavioral proof (real attach, no duplicate Session.Server) is the
# live-stack verification in scripts/integration.sh + a manual dev-stack
# run — this suite guards the invocation contract.

setup() {
    IEX_SH="$BATS_TEST_DIRNAME/../../scripts/iex.sh"
    OBSERVER_SH="$BATS_TEST_DIRNAME/../../scripts/observer.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Fake `docker` on PATH — records every invocation, exits 0. Same
    # recording shape as test/bin/grappa_test.bats. `git` is NOT stubbed:
    # _lib.sh derives SRC_ROOT/REPO_ROOT from the real worktree checkout.
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

# --- iex.sh --------------------------------------------------------------

@test "iex.sh attaches to the live node via remsh (no iex -S mix, no second app)" {
    run "$IEX_SH"
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec grappa sh' "$ARGV_LOG"
    grep -q 'iex' "$ARGV_LOG"
    grep -q -- '--remsh' "$ARGV_LOG"
    grep -q -- 'grappa@grappa' "$ARGV_LOG"
    grep -q -- '--cookie' "$ARGV_LOG"
    grep -q 'RELEASE_COOKIE' "$ARGV_LOG"
    # The bug being fixed: `iex -S mix` boots a whole new Grappa.Application.
    # remsh attaches to the LIVE node instead — assert we never `-S mix`.
    ! grep -q -- '-S mix' "$ARGV_LOG"
}

@test "iex.sh attaches interactively (no docker exec -T)" {
    run "$IEX_SH"
    [ "$status" -eq 0 ]
    # remsh needs an interactive TTY — the docker exec must NOT carry -T.
    ! grep -qE 'docker .*compose .*exec -T grappa' "$ARGV_LOG"
}

# --- observer.sh ---------------------------------------------------------

@test "observer.sh runs observer_cli against the live node without booting a second app" {
    run "$OBSERVER_SH"
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec grappa sh' "$ARGV_LOG"
    grep -q 'iex' "$ARGV_LOG"
    grep -q -- '--cookie' "$ARGV_LOG"
    grep -q 'RELEASE_COOKIE' "$ARGV_LOG"
    grep -q 'observer_cli.start' "$ARGV_LOG"
    # Introspect the LIVE node (grappa@grappa), not a freshly-booted one.
    grep -q -- 'grappa@grappa' "$ARGV_LOG"
    # `--no-start` is the load-bearing token: mix loads the code path (so
    # observer_cli resolves) but does NOT start Grappa.Application — no
    # duplicate Session.Server, no sqlite WAL contention.
    grep -q -- '--no-start' "$ARGV_LOG"
}

@test "observer.sh attaches over a TTY-full exec (no docker exec -T)" {
    run "$OBSERVER_SH"
    [ "$status" -eq 0 ]
    # The observer_cli TUI needs a TTY — the pre-#364 `in_container` path
    # used `exec -T` (no TTY). Assert the fix drops -T.
    ! grep -qE 'docker .*compose .*exec -T grappa' "$ARGV_LOG"
}
