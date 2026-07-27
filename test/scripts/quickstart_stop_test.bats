#!/usr/bin/env bats
#
# Bats suite for scripts/quickstart-stop.sh — taking a quickstart box
# down, the whole way down.
#
# Why this exists: the stack's long-lived nginx sits behind the `prod`
# compose profile, so a plain `docker compose down` walks past it. The
# container stays up, keeps the project network attached, and the down
# ends with
#
#   Network <project>_grappa_internal  Resource is still in use
#
# leaving half a box running under a command that reads like it stopped
# everything. This script is the one-liner nobody remembers, with the
# same ownership guard the other two quickstart scripts carry.
#
# Scope: asserts WHICH docker invocations the script makes and what it
# refuses to do. `docker` is stubbed on PATH — same recording shape as
# quickstart_update_test.bats.

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Fake `docker` — records every invocation, exits 0. `inspect` is the
    # one subcommand that has to answer rather than only record: the
    # ownership guard reads a compose label off the container. Default is
    # "no such container" (exit 1, as the real one does), and
    # FAKE_OWNER_DIR makes it exist, owned by that directory.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
if [ "\$1" = inspect ]; then
    [ -n "\${FAKE_OWNER_DIR:-}" ] || exit 1
    printf '%s\n' "\$FAKE_OWNER_DIR"
fi
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"

    # ---- the box: an installed quickstart checkout --------------------
    BOX="$BATS_TEST_TMPDIR/box"
    mkdir -p "$BOX/scripts"
    cp "$REPO_SRC/scripts/quickstart-stop.sh" "$BOX/scripts/"
    # The real compose.yaml pins container_name on both long-lived
    # services; that pin is what the ownership guard reads.
    cat > "$BOX/compose.yaml" <<'EOF'
services:
  grappa:
    container_name: grappa
  nginx:
    container_name: grappa-nginx
EOF
    cat > "$BOX/.env" <<'EOF'
MIX_ENV=prod
PHX_HOST=staging.example.org
NGINX_PUBLISH=127.0.0.1:3100:80
EOF
}

@test "it takes the prod profile down, not just the default one" {
    export FAKE_OWNER_DIR="$BOX"
    run "$BOX/scripts/quickstart-stop.sh"
    [ "$status" -eq 0 ]

    # The bug this script exists for: without --profile prod the nginx
    # container survives and the network refuses to go.
    grep -qE 'docker compose .*--profile prod down' "$ARGV_LOG"
}

@test "it pins the committed compose file, ignoring any override" {
    export FAKE_OWNER_DIR="$BOX"
    run "$BOX/scripts/quickstart-stop.sh"
    [ "$status" -eq 0 ]
    grep -qE 'docker compose -f compose.yaml' "$ARGV_LOG"
}

@test "a box owned by another checkout is refused, not stopped" {
    export FAKE_OWNER_DIR="/somewhere/else/grappa-irc-469"
    run "$BOX/scripts/quickstart-stop.sh"
    [ "$status" -ne 0 ]
    # It must say WHERE the box lives, or the message is as useless as
    # docker's own name-conflict error.
    [[ "$output" == *"/somewhere/else/grappa-irc-469"* ]]
    # And it must not have taken anything down.
    ! grep -q ' down' "$ARGV_LOG"
}

@test "outside a grappa checkout it refuses before touching docker" {
    rm "$BOX/compose.yaml"
    run "$BOX/scripts/quickstart-stop.sh"
    [ "$status" -ne 0 ]
    [ ! -s "$ARGV_LOG" ]
}

@test "a box with no containers up is stopped anyway, and says so" {
    # No FAKE_OWNER_DIR: `docker inspect` fails, as it does when nothing
    # is running. Stale networks still need collecting, so `down` must
    # run — reporting a no-op is the script's job, not refusing.
    run "$BOX/scripts/quickstart-stop.sh"
    [ "$status" -eq 0 ]
    grep -qE 'docker compose .*--profile prod down' "$ARGV_LOG"
    [[ "$output" == *"nothing was running"* ]]
}

@test "a box whose .env was deleted can still be stopped" {
    # .env is what "installed" means to quickstart-update.sh, but a box
    # you cannot stop because its config went missing is a trap.
    rm "$BOX/.env"
    export FAKE_OWNER_DIR="$BOX"
    run "$BOX/scripts/quickstart-stop.sh"
    [ "$status" -eq 0 ]
    grep -qE 'docker compose .*--profile prod down' "$ARGV_LOG"
}

@test "--volumes is passed through to compose, plain down is not" {
    export FAKE_OWNER_DIR="$BOX"
    run "$BOX/scripts/quickstart-stop.sh" --volumes
    [ "$status" -eq 0 ]
    grep -qE 'docker compose .*down .*(-v|--volumes)' "$ARGV_LOG"

    : > "$ARGV_LOG"
    run "$BOX/scripts/quickstart-stop.sh"
    [ "$status" -eq 0 ]
    ! grep -qE 'down .*(-v|--volumes)' "$ARGV_LOG"
}

@test "an unknown flag is refused instead of being handed to compose" {
    export FAKE_OWNER_DIR="$BOX"
    run "$BOX/scripts/quickstart-stop.sh" --rm-rf-everything
    [ "$status" -ne 0 ]
    [ ! -s "$ARGV_LOG" ]
}
