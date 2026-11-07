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
# and no container is touched; the real infra/packaging/gen-secrets.sh runs,
# so the generated env file can be inspected (perms + contents). Secret
# VALUES are asserted only for shape/idempotence, never trusted from the
# network. The keypair MATHS lives in test/infra/gen_secrets_test.bats.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    BOX="$BATS_TEST_TMPDIR/box"
    mkdir -p "$BOX/infra/docker" "$BOX/infra/lib" "$BOX/infra/packaging"
    cp "$REPO_SRC/infra/docker/deploy.sh" "$BOX/infra/docker/"
    cp "$REPO_SRC/infra/lib/deploy_common.sh" "$BOX/infra/lib/"
    # The ONE secret generator (#862) — deploy.sh resolves it at
    # ../packaging/ relative to itself, the same layout get.sh lays down.
    cp "$REPO_SRC/infra/packaging/gen-secrets.sh" "$BOX/infra/packaging/"
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
    # Nothing here answers a VAPID `eval` any more: #862 moved keypair
    # generation to gen-secrets.sh, so a reintroduced throwaway container
    # would get an empty reply and fail loudly instead of being humoured.
    cat > "$FAKE_DIR/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$ARGV_LOG"
case "$1" in
  run)
    # issue 1112 — the pre-stop migration check, refusable on demand.
    case "$*" in
      *check_migrations*) exit "${CHECK_RC:-0}" ;;
    esac
    exit 0 ;;
  inspect)
    [ -n "${FAKE_CONTAINER_EXISTS:-}" ] || exit 1
    # #1656 — liveness asks for the STATE, not for existence.
    case "$*" in
      *"{{.State.Running}}"*) printf '%s' "${FAKE_CONTAINER_RUNNING:-true}" ;;
    esac
    exit 0 ;;
  exec)
    # #1656 — /healthz, modelled as real curl: `-f` discards the body and
    # exits non-zero on a non-2xx; without it curl exits 0 and PRINTS it.
    case "$*" in
      *healthz*)
        case "$*" in
          *"curl -fsS"*) [ "${HEALTHZ_STATUS:-200}" = 200 ] || exit 22 ;;
          *)             printf '%s' "${HEALTHZ_BODY:-}" ;;
        esac
        ;;
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
    [ "$(file_mode "$ENV_FILE")" = "600" ]
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

@test "install: the container it starts does NOT re-migrate on boot (#867)" {
    # The image auto-migrates on a bare run; this path migrated already, from
    # the host, in the line above. Leaving the boot-time migrate armed lets a
    # restarting old container race release_migrate on the same sqlite file.
    PHX_HOST=x.example.org run "$DEPLOY" install
    [ "$status" -eq 0 ]

    grep -qE "run -d .*-e GRAPPA_AUTO_MIGRATE=0" "$ARGV_LOG"
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

@test "install: the secrets come from gen-secrets.sh, not a throwaway container" {
    # #862: write_env_file used to transcribe four `openssl rand` calls and
    # then spend a whole `docker run … eval` on the VAPID pair, because it
    # claimed host openssl could not produce a raw P-256 point. It can (the
    # maths is measured in test/infra/gen_secrets_test.bats), so the
    # transcription and the throwaway container are both gone.
    PHX_HOST=x.example.org run "$DEPLOY" install
    [ "$status" -eq 0 ]

    refute grep -q 'generate_key' "$ARGV_LOG"
    grep -q 'gen-secrets: secrets written' <<<"$output"

    # base64url, unpadded: 65 raw bytes -> 87 chars, 32 -> 43.
    pub="$(sed -n 's/^VAPID_PUBLIC_KEY=//p' "$ENV_FILE")"
    priv="$(sed -n 's/^VAPID_PRIVATE_KEY=//p' "$ENV_FILE")"
    [ "${#pub}" -eq 87 ]
    [ "${#priv}" -eq 43 ]
    refute grep -q '[+/=]' <<<"$pub$priv"
}

@test "install: a failed generator leaves NO env file behind" {
    # A half-written file is worse than none: the next run would take the
    # "reusing the existing env file" branch and boot a secret-less box.
    printf '#!/bin/sh\nexit 3\n' > "$BOX/infra/packaging/gen-secrets.sh"

    PHX_HOST=x.example.org run "$DEPLOY" install
    [ "$status" -ne 0 ]
    refute test -f "$ENV_FILE"
    refute test -f "$ENV_FILE.partial"
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

@test "update: removes the old container BEFORE it migrates, starts the new one AFTER the seed (issue 1112)" {
    # D4 covers this door too (vjt's ruling, F5 (a)): it used to migrate with
    # the old container still serving. #867's GRAPPA_AUTO_MIGRATE=0 stays —
    # the host-side migrate is still the only one.
    seed_env_file
    export FAKE_CONTAINER_EXISTS=1
    run "$DEPLOY" update
    [ "$status" -eq 0 ]

    pull_line=$(grep -n "pull ghcr.io/vjt/grappa:latest" "$ARGV_LOG" | head -1 | cut -d: -f1)
    check_line=$(grep -n "eval Grappa.Release.check_migrations()" "$ARGV_LOG" | head -1 | cut -d: -f1)
    rm_line=$(grep -n "rm -f grappa" "$ARGV_LOG" | head -1 | cut -d: -f1)
    mig_line=$(grep -n "eval Grappa.Release.migrate()" "$ARGV_LOG" | head -1 | cut -d: -f1)
    seed_line=$(grep -n "eval Grappa.Release.seed_themes()" "$ARGV_LOG" | head -1 | cut -d: -f1)
    run_line=$(grep -nE "run -d .*--name grappa" "$ARGV_LOG" | head -1 | cut -d: -f1)
    [ -n "$pull_line" ]
    [ -n "$check_line" ]
    [ -n "$rm_line" ]
    [ -n "$mig_line" ]
    [ -n "$seed_line" ]
    [ -n "$run_line" ]
    # The check runs on the NEW image, while the old container still serves.
    [ "$pull_line" -lt "$check_line" ]
    [ "$check_line" -lt "$rm_line" ]
    [ "$rm_line" -lt "$mig_line" ]
    [ "$mig_line" -lt "$seed_line" ]
    [ "$seed_line" -lt "$run_line" ]
    grep -qE "run -d .*-e GRAPPA_AUTO_MIGRATE=0" "$ARGV_LOG"
}

@test "update: a migration check that refuses removes NOTHING — exit 1, the old container keeps serving (issue 1112)" {
    seed_env_file
    export FAKE_CONTAINER_EXISTS=1 CHECK_RC=1
    run "$DEPLOY" update
    [ "$status" -eq 1 ]
    grep -q "eval Grappa.Release.check_migrations()" "$ARGV_LOG"
    refute grep -q "rm -f grappa" "$ARGV_LOG"
    refute grep -q "eval Grappa.Release.migrate()" "$ARGV_LOG"
    refute grep -q "run -d" "$ARGV_LOG"
    [[ "$output" == *"NOTHING was stopped"* ]]
}

@test "an older consumer sourcing the newer lib dies before it stops or migrates anything (issue 1112)" {
    # get.sh mirrors the lib and this consumer as two downloads, so a box can
    # hold the new lib beside the consumer from before the restart hook was
    # split. That consumer defines substrate_restart and nothing the new cold
    # path calls first; an undefined hook is 127 under `set -e`, and it must
    # come before every hook that touches the box, or an old consumer would
    # migrate with the node up and then die without starting it.
    run bash -c '
        set -euo pipefail
        log="'"$BATS_TEST_TMPDIR"'/old-consumer.log"
        for h in pull read_marker write_marker commit_exists changed_files \
                 preflight build reload cic migrate seed restart healthcheck \
                 service_alive done_banner; do
            eval "substrate_$h() { echo $h >> \"\$log\"; }"
        done
        DEPLOY_FEATURE_FORCE_FLAGS=1
        . "'"$BOX"'/infra/lib/deploy_common.sh"
        deploy_main --force-cold
    '
    [ "$status" -ne 0 ]
    [[ "$output" == *"substrate_check_migrations"*"not found"* ]]
    [[ "$output" == *"NOTHING was stopped"* ]]
    grep -qx "cic" "$BATS_TEST_TMPDIR/old-consumer.log"
    refute grep -qx "restart" "$BATS_TEST_TMPDIR/old-consumer.log"
    refute grep -qx "migrate" "$BATS_TEST_TMPDIR/old-consumer.log"
    refute grep -qx "seed" "$BATS_TEST_TMPDIR/old-consumer.log"
}

@test "update: refuses when the box was never installed (no env file)" {
    run "$DEPLOY" update
    [ "$status" -ne 0 ]
    [[ "$output" == *"never installed"* ]]
    [ ! -s "$ARGV_LOG" ] || refute grep -q "run -d" "$ARGV_LOG"
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

# --- #1656: the release-image arm defines its OWN hook set, so it needs its
# own proof that the failed-healthcheck arm tells the truth.

@test "#1656 update: healthcheck red + container gone shouts PRODUCTION IS DOWN" {
    seed_env_file
    export FAKE_CONTAINER_EXISTS=1 FAKE_CONTAINER_RUNNING=false
    # this arm's cold budget is 120x2s — a red probe would burn four minutes
    export HEALTHZ_STATUS=503 COLD_HEALTHCHECK_RETRIES=2 COLD_HEALTHCHECK_SLEEP=0
    export HEALTHZ_BODY='{"status":"fail","checks":[{"name":"repo","reason":"Repo.query failed"}]}'

    run "$DEPLOY" update
    [ "$status" -ne 0 ]
    [[ "$output" == *"Repo.query failed"* ]]
    [[ "$output" == *"PRODUCTION IS DOWN"* ]]
}

@test "#1656 update: healthcheck red + container running says it is still RUNNING" {
    seed_env_file
    export FAKE_CONTAINER_EXISTS=1 FAKE_CONTAINER_RUNNING=true
    # this arm's cold budget is 120x2s — a red probe would burn four minutes
    export HEALTHZ_STATUS=503 COLD_HEALTHCHECK_RETRIES=2 COLD_HEALTHCHECK_SLEEP=0

    run "$DEPLOY" update
    [ "$status" -ne 0 ]
    [[ "$output" == *"still RUNNING"* ]]
    refute grep -q "PRODUCTION IS DOWN" <<<"$output"
}
