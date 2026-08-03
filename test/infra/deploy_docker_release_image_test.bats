#!/usr/bin/env bats
#
# Bats suite for infra/docker/deploy.sh RELEASE-IMAGE mode (#503 unit D).
#
# The same verb-dispatched script grows a second substrate: a checkout-less
# host that runs the published ghcr image (Dockerfile.release) with plain
# `docker` — no compose, no source, no mix. Mode is auto-detected (no
# compose.yaml next to the script → release) or forced with
# GRAPPA_DEPLOY_MODE. Updates are COLD-only (recreate) — hot-on-image is
# #503 unit E.
#
# Scope: mode detection, and the SHAPE of the docker invocations + the env
# file each verb writes. `docker` is stubbed on PATH so no image is pulled
# and no container is touched; `openssl`/`mktemp`/`chmod` run for real so
# the generated env file can be inspected (perms + contents). Secret VALUES
# are asserted only for shape/idempotence, never trusted from the network.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    BOX="$BATS_TEST_TMPDIR/box"
    mkdir -p "$BOX/infra/docker" "$BOX/infra/lib"
    cp "$REPO_SRC/infra/docker/deploy.sh" "$BOX/infra/docker/"
    cp "$REPO_SRC/infra/lib/deploy_common.sh" "$BOX/infra/lib/"
    DEPLOY="$BOX/infra/docker/deploy.sh"

    # Release-mode state dir (the env file lives here) + a data volume name.
    export GRAPPA_HOME="$BATS_TEST_TMPDIR/home"
    export ENV_FILE="$GRAPPA_HOME/grappa.env"
    export GRAPPA_DEPLOY_MODE=release
    export GRAPPA_IMAGE="ghcr.io/vjt/grappa:latest"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    export ARGV_LOG
    : > "$ARGV_LOG"

    # Fake `docker`: records every call, answers the few readbacks the
    # script makes. `inspect` reports the container present only when
    # FAKE_CONTAINER_EXISTS is set (unset = no such container = empty host).
    # `run … gen_vapid_env` prints a keypair on stdout (the only stdout the
    # script parses); everything else exits 0.
    cat > "$FAKE_DIR/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$ARGV_LOG"
case "$1" in
  inspect)
    [ -n "${FAKE_CONTAINER_EXISTS:-}" ] || exit 1
    exit 0 ;;
  run)
    case "$*" in
      *generate_key*)
        printf 'VAPID_PUBLIC_KEY=FAKEPUBLICKEY\n'
        printf 'VAPID_PRIVATE_KEY=FAKEPRIVATEKEY\n' ;;
    esac
    exit 0 ;;
esac
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"
}

# ─────────────────────────────── mode detect ────────────────────────────

@test "mode: an invalid GRAPPA_DEPLOY_MODE is rejected" {
    GRAPPA_DEPLOY_MODE=bogus run "$DEPLOY" stop
    [ "$status" -ne 0 ]
    [[ "$output" == *"GRAPPA_DEPLOY_MODE"* ]]
}

@test "mode: no compose.yaml next to the script auto-selects release mode" {
    unset GRAPPA_DEPLOY_MODE
    run "$DEPLOY" stop
    [ "$status" -eq 0 ]
    [[ "$output" == *"nothing to stop"* ]]   # release-only wording
}

@test "mode: GRAPPA_DEPLOY_MODE=release forces release even beside a compose.yaml" {
    printf 'services:\n  grappa:\n    container_name: grappa\n' > "$BOX/compose.yaml"
    run "$DEPLOY" stop
    [ "$status" -eq 0 ]
    [[ "$output" == *"nothing to stop"* ]]
}

# ──────────────────────────────── install ───────────────────────────────

@test "install: writes a 0600 env file carrying PHX_HOST + generated secrets" {
    PHX_HOST=grappa.example.org run "$DEPLOY" install
    [ "$status" -eq 0 ]

    [ -f "$ENV_FILE" ]
    [ "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")" = "600" ]
    grep -qE '^PHX_HOST=grappa\.example\.org$' "$ENV_FILE"
    grep -qE '^SECRET_KEY_BASE=.+' "$ENV_FILE"
    grep -qE '^SECRET_SIGNING_SALT=.+' "$ENV_FILE"
    grep -qE '^GRAPPA_ENCRYPTION_KEY=.+' "$ENV_FILE"
    grep -qE '^RELEASE_COOKIE=.+' "$ENV_FILE"
    grep -qE '^VAPID_PUBLIC_KEY=.+' "$ENV_FILE"
    grep -qE '^VAPID_PRIVATE_KEY=.+' "$ENV_FILE"
    grep -qE '^GRAPPA_SUBSTRATE=docker$' "$ENV_FILE"
}

@test "install: migrates against the image, then brings the container up" {
    PHX_HOST=x.example.org run "$DEPLOY" install
    [ "$status" -eq 0 ]

    grep -q "run --rm --env-file .* eval Grappa.Release.migrate()" "$ARGV_LOG"
    grep -qE "run -d .*--name grappa" "$ARGV_LOG"

    migrate_line="$(grep -n 'Grappa.Release.migrate' "$ARGV_LOG" | head -n1 | cut -d: -f1)"
    up_line="$(grep -n 'run -d' "$ARGV_LOG" | head -n1 | cut -d: -f1)"
    [ -n "$migrate_line" ] && [ -n "$up_line" ] && [ "$migrate_line" -lt "$up_line" ]
}

@test "install: runs the container from the GRAPPA_IMAGE override" {
    PHX_HOST=x.example.org GRAPPA_IMAGE=ghcr.io/vjt/grappa:v9.9.9 \
        run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -q "run -d .*ghcr.io/vjt/grappa:v9.9.9" "$ARGV_LOG"
}

@test "install: refuses when a grappa container already exists" {
    export FAKE_CONTAINER_EXISTS=1
    PHX_HOST=x.example.org run "$DEPLOY" install
    [ "$status" -ne 0 ]
    [[ "$output" == *"already"* ]]
    [ ! -f "$ENV_FILE" ]
}

@test "install: an existing env file is NOT regenerated (idempotent, keeps secrets)" {
    mkdir -p "$GRAPPA_HOME"
    umask 077
    cat > "$ENV_FILE" <<'EOF'
PHX_HOST=pinned.example.org
SECRET_KEY_BASE=ORIGINAL_DO_NOT_ROTATE
GRAPPA_ENCRYPTION_KEY=ORIGINAL_KEY
VAPID_PUBLIC_KEY=ORIGPUB
VAPID_PRIVATE_KEY=ORIGPRIV
EOF
    chmod 600 "$ENV_FILE"

    run "$DEPLOY" install
    [ "$status" -eq 0 ]
    [[ "$output" == *"reusing the existing env file"* ]]
    grep -qE '^SECRET_KEY_BASE=ORIGINAL_DO_NOT_ROTATE$' "$ENV_FILE"
    grep -qE '^GRAPPA_ENCRYPTION_KEY=ORIGINAL_KEY$' "$ENV_FILE"
}

@test "install: prompts on the tty for PHX_HOST when it is unset" {
    printf 'prompted.example.org\n' > "$BATS_TEST_TMPDIR/tty"
    GRAPPA_TTY="$BATS_TEST_TMPDIR/tty" run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -qE '^PHX_HOST=prompted\.example\.org$' "$ENV_FILE"
}

@test "install: no PHX_HOST and no usable tty fails loud, writing nothing" {
    GRAPPA_TTY=/dev/null run "$DEPLOY" install
    [ "$status" -ne 0 ]
    [[ "$output" == *"PHX_HOST is required"* ]]
    [ ! -f "$ENV_FILE" ]
}

@test "install: does not echo generated secrets to stdout" {
    PHX_HOST=x.example.org run "$DEPLOY" install
    [ "$status" -eq 0 ]
    skb="$(sed -n 's/^SECRET_KEY_BASE=//p' "$ENV_FILE")"
    [ -n "$skb" ]
    [[ "$output" != *"$skb"* ]]
}

# ──────────────────────────────── update ────────────────────────────────

seed_env_file() {
    mkdir -p "$GRAPPA_HOME"
    umask 077
    cat > "$ENV_FILE" <<'EOF'
PHX_HOST=box.example.org
SECRET_KEY_BASE=x
SECRET_SIGNING_SALT=x
GRAPPA_ENCRYPTION_KEY=x
RELEASE_COOKIE=x
VAPID_PUBLIC_KEY=x
VAPID_PRIVATE_KEY=x
EOF
    chmod 600 "$ENV_FILE"
}

@test "update: pulls the image, migrates, recreates cold, and says so" {
    seed_env_file
    export FAKE_CONTAINER_EXISTS=1
    run "$DEPLOY" update
    [ "$status" -eq 0 ]
    grep -q "pull ghcr.io/vjt/grappa:latest" "$ARGV_LOG"
    grep -q "eval Grappa.Release.migrate()" "$ARGV_LOG"
    grep -qE "run -d .*--name grappa" "$ARGV_LOG"
    refute grep -q "reload" "$ARGV_LOG"
    [[ "$output" == *"cold"* ]]
}

@test "update: refuses when the box was never installed (no env file)" {
    run "$DEPLOY" update
    [ "$status" -ne 0 ]
    [[ "$output" == *"never installed"* ]]
    [ ! -s "$ARGV_LOG" ] || ! grep -q "run -d" "$ARGV_LOG"
}

@test "update: --force-cold is accepted (redundant)" {
    seed_env_file
    export FAKE_CONTAINER_EXISTS=1
    run "$DEPLOY" update --force-cold
    [ "$status" -eq 0 ]
    grep -qE "run -d .*--name grappa" "$ARGV_LOG"
}

@test "update: an unknown flag is a usage error" {
    seed_env_file
    run "$DEPLOY" update --frobnicate
    [ "$status" -ne 0 ]
    [[ "$output" == *"usage"* ]]
}

# ───────────────────────────────── stop ─────────────────────────────────

@test "stop: removes the running container" {
    export FAKE_CONTAINER_EXISTS=1
    run "$DEPLOY" stop
    [ "$status" -eq 0 ]
    grep -qE "rm -f grappa" "$ARGV_LOG"
    [[ "$output" == *"down"* ]]
}

@test "stop: no container is a no-op that says so" {
    run "$DEPLOY" stop
    [ "$status" -eq 0 ]
    [[ "$output" == *"nothing to stop"* ]]
    refute grep -q "rm -f grappa" "$ARGV_LOG"
}

@test "stop: --volumes drops the data volume" {
    export FAKE_CONTAINER_EXISTS=1
    run "$DEPLOY" stop --volumes
    [ "$status" -eq 0 ]
    grep -q "volume rm grappa-data" "$ARGV_LOG"
}

# ───────────────────────────────── bare ─────────────────────────────────

@test "bare: no env file installs a fresh box" {
    PHX_HOST=x.example.org run "$DEPLOY"
    [ "$status" -eq 0 ]
    [ -f "$ENV_FILE" ]
    grep -qE "run -d .*--name grappa" "$ARGV_LOG"
}

@test "bare: an existing env file updates the box" {
    seed_env_file
    export FAKE_CONTAINER_EXISTS=1
    run "$DEPLOY"
    [ "$status" -eq 0 ]
    grep -q "pull ghcr.io/vjt/grappa:latest" "$ARGV_LOG"
}
