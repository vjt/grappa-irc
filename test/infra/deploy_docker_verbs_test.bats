#!/usr/bin/env bats
#
# Bats suite for infra/docker/deploy.sh — the verb-dispatched standalone
# Docker deploy consumer (#503 unit B). It absorbs the three quickstart
# scripts into one lib consumer:
#
#   deploy.sh install   fresh clones-and-goes bring-up (was quickstart.sh)
#   deploy.sh update    pull + preflight → hot-on-HOT / recreate-on-COLD
#                       (was quickstart-update.sh, which ALWAYS recreated)
#   deploy.sh stop      profile-prod down --remove-orphans (was
#                       quickstart-stop.sh)
#   deploy.sh           (bare) idempotent: no .env → install, else update
#
# This file covers install + stop + dispatch. The update verb — the one
# that consumes the shared deploy algorithm (infra/lib/deploy_common.sh)
# for the hot-vs-cold decision — has its own harness (a real git clone +
# a docker stub that answers the preflight oneshot) in
# deploy_docker_update_test.bats, mirroring test/infra/deploy_docker_test.bats.
#
# Scope: asserts what install WRITES (.env, runtime/nginx-frontend.conf)
# and the SHAPE of the docker invocations both verbs make. `docker` is
# stubbed on PATH so no image is built and no container is touched — same
# recording shape as the quickstart suites this replaces.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    BOX="$BATS_TEST_TMPDIR/box"
    mkdir -p "$BOX/infra/docker" "$BOX/infra/lib" "$BOX/infra/packaging" "$BOX/infra"

    cp "$REPO_SRC/infra/docker/deploy.sh" "$BOX/infra/docker/"
    cp "$REPO_SRC/infra/lib/deploy_common.sh" "$BOX/infra/lib/"
    cp "$REPO_SRC/infra/nginx-tls-frontend.example.conf" "$BOX/infra/"
    cp "$REPO_SRC/.env.example" "$BOX/.env.example"
    # The REAL version carrier + extractor (#538/#652): source mode derives
    # GRAPPA_VERSION from them at init, so the cic build the prod profile pulls
    # in gets a real number instead of refusing to start (#692).
    cp "$REPO_SRC/VERSION" "$BOX/VERSION"
    cp "$REPO_SRC/infra/packaging/version.sh" "$BOX/infra/packaging/version.sh"
    chmod +x "$BOX/infra/packaging/version.sh"
    # Preflight checks its presence, and the ownership guard reads the
    # pinned container names out of it — those pins are what makes two
    # checkouts collide on one docker daemon (#485 dropped the nginx one).
    cat > "$BOX/compose.yaml" <<'EOF'
services:
  grappa:
    container_name: grappa
EOF

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Fake `docker` — records every invocation, exits 0. `inspect` is the
    # exception: it has to answer, because the ownership guard reads a
    # compose label off the running container. Unset FAKE_OWNER_DIR means
    # "no such container", which is what an empty host looks like.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
# Record the value a cic build would actually SEE. compose passes
# \`GRAPPA_VERSION: \${GRAPPA_VERSION:-}\` through from this environment — the
# prod profile pulls the cicchetto-build oneshot in via depends_on, so \`up -d\`
# counts as a cic build launch just like an explicit run does (#692).
case "\$*" in
    *cicchetto-build*|*"up -d"*)
        printf 'env GRAPPA_VERSION=%s\n' "\${GRAPPA_VERSION:-}" >> "$ARGV_LOG" ;;
esac
if [ "\$1" = inspect ]; then
    [ -n "\${FAKE_OWNER_DIR:-}" ] || exit 1
    printf '%s\n' "\$FAKE_OWNER_DIR"
fi
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"

    DEPLOY="$BOX/infra/docker/deploy.sh"
}

# Make `docker` fail for the invocation whose argv matches $1 (and only
# that one), so the "already seeded" / "seed failed" paths can be exercised.
stub_docker_failing_on() {
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
# Record the value a cic build would actually SEE. compose passes
# \`GRAPPA_VERSION: \${GRAPPA_VERSION:-}\` through from this environment — the
# prod profile pulls the cicchetto-build oneshot in via depends_on, so \`up -d\`
# counts as a cic build launch just like an explicit run does (#692).
case "\$*" in
    *cicchetto-build*|*"up -d"*)
        printf 'env GRAPPA_VERSION=%s\n' "\${GRAPPA_VERSION:-}" >> "$ARGV_LOG" ;;
esac
for a in "\$@"; do
  [ "\$a" = "$1" ] && exit 1
done
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
}

# ─────────────────────────────── dispatch ───────────────────────────────

@test "an unknown verb is a usage error, before any side effect" {
    run "$DEPLOY" frobnicate
    [ "$status" -ne 0 ]
    [[ "$output" == *"usage"* ]]
    [ ! -s "$ARGV_LOG" ]
}

@test "install rejects an unexpected positional argument" {
    run "$DEPLOY" install extra-arg
    [ "$status" -ne 0 ]
    [[ "$output" == *"usage"* ]]
}

# ──────────────────────────────── install ───────────────────────────────

@test "install: default run keeps localhost and seeds nothing" {
    run "$DEPLOY" install
    [ "$status" -eq 0 ]

    grep -qE '^PHX_HOST=localhost$' "$BOX/.env"
    refute grep -q 'grappa.create_user' "$ARGV_LOG"
    refute grep -q 'grappa.bind_network' "$ARGV_LOG"
}

@test "install: an explicitly passed PHX_HOST overwrites what a previous run left in .env" {
    PHX_HOST=first.example.org run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -qE '^PHX_HOST=first\.example\.org$' "$BOX/.env"

    PHX_HOST=second.example.org run "$DEPLOY" install
    [ "$status" -eq 0 ]
    [ "$(grep -c '^PHX_HOST=' "$BOX/.env")" -eq 1 ]
    grep -qE '^PHX_HOST=second\.example\.org$' "$BOX/.env"
}

@test "install: a pre-existing .env hostname survives a run that does not pass one" {
    PHX_HOST=pinned.example.org run "$DEPLOY" install
    [ "$status" -eq 0 ]

    run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -qE '^PHX_HOST=pinned\.example\.org$' "$BOX/.env"
    grep -q 'server_name pinned.example.org;' "$BOX/runtime/nginx-frontend.conf"
}

@test "install: an explicitly passed HTTP_BIND wins over what .env already carries" {
    HTTP_BIND=127.0.0.1:3100 run "$DEPLOY" install
    [ "$status" -eq 0 ]
    [ "$(grep -c '^GRAPPA_PUBLISH=' "$BOX/.env")" -eq 1 ]
    grep -qE '^GRAPPA_PUBLISH=127\.0\.0\.1:3100$' "$BOX/.env"

    HTTP_BIND=127.0.0.1:3200 run "$DEPLOY" install
    [ "$status" -eq 0 ]
    [ "$(grep -c '^GRAPPA_PUBLISH=' "$BOX/.env")" -eq 1 ]
    grep -qE '^GRAPPA_PUBLISH=127\.0\.0\.1:3200$' "$BOX/.env"
    [[ "$output" == *"http://127.0.0.1:3200/"* ]]
}

@test "install: a fresh .env publishes grappa on the default HTTP_BIND, not the example's loopback:4000" {
    run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -qE '^GRAPPA_PUBLISH=127\.0\.0\.1:3000$' "$BOX/.env"
}

@test "install: front-door config is rendered with hostname, upstream and cert paths filled in" {
    PHX_HOST=staging.example.org HTTP_BIND=127.0.0.1:3100 \
        FRONTEND_SSL_CERT=/tmp/cert.pem FRONTEND_SSL_KEY=/tmp/key.pem \
        run "$DEPLOY" install
    [ "$status" -eq 0 ]

    conf="$BOX/runtime/nginx-frontend.conf"
    [ -f "$conf" ]
    refute grep -q '<your-domain>' "$conf"
    [ "$(grep -c 'server_name staging.example.org;' "$conf")" -eq 2 ]
    grep -q 'server 127.0.0.1:3100;' "$conf"
    grep -q 'ssl_certificate     /tmp/cert.pem;' "$conf"
    grep -q 'ssl_certificate_key /tmp/key.pem;' "$conf"
}

@test "install: a wildcard bind is rewritten to loopback in the rendered upstream" {
    PHX_HOST=staging.example.org HTTP_BIND=0.0.0.0:3000 \
        run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -q 'server 127.0.0.1:3000;' "$BOX/runtime/nginx-frontend.conf"
    refute grep -q 'server 0.0.0.0:3000;' "$BOX/runtime/nginx-frontend.conf"
}

@test "install: SEED_USER creates the admin account and binds the network before the stack comes up" {
    SEED_USER=tester SEED_PASSWORD=hunter2222 SEED_NICK=tester-box \
        SEED_AUTOJOIN='#grappa' run "$DEPLOY" install
    [ "$status" -eq 0 ]

    grep -q -- "grappa.create_user --name tester --password hunter2222 --admin" "$ARGV_LOG"
    grep -q -- "grappa.bind_network --user tester --network azzurra --server irc.azzurra.chat:6697 --nick tester-box --auth none --autojoin \\\\#grappa" "$ARGV_LOG"

    seed_line="$(grep -n 'grappa.bind_network' "$ARGV_LOG" | head -n1 | cut -d: -f1)"
    up_line="$(grep -n 'up -d' "$ARGV_LOG" | head -n1 | cut -d: -f1)"
    [ -n "$seed_line" ] && [ -n "$up_line" ] && [ "$seed_line" -lt "$up_line" ]
}

@test "install: SEED_ADMIN=0 opts out of the admin grant" {
    SEED_USER=tester SEED_PASSWORD=hunter2222 SEED_ADMIN=0 \
        run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -q -- "grappa.create_user --name tester --password hunter2222" "$ARGV_LOG"
    refute grep -q -- "grappa.create_user .* --admin" "$ARGV_LOG"
}

@test "install: built-in themes are seeded before the stack comes up, even with no account" {
    run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -q 'grappa.seed_themes' "$ARGV_LOG"
    refute grep -q 'grappa.create_user' "$ARGV_LOG"

    themes_line="$(grep -n 'grappa.seed_themes' "$ARGV_LOG" | head -n1 | cut -d: -f1)"
    up_line="$(grep -n 'up -d' "$ARGV_LOG" | head -n1 | cut -d: -f1)"
    [ -n "$themes_line" ] && [ -n "$up_line" ] && [ "$themes_line" -lt "$up_line" ]
}

@test "install: the stack comes up carrying GRAPPA_VERSION from the VERSION file (#692)" {
    run "$DEPLOY" install
    [ "$status" -eq 0 ]
    # Exact value, not just "non-empty": the bundle bakes it into
    # <meta cicchetto-version>, so a wrong number is as bad as a missing one.
    grep -Fqx "env GRAPPA_VERSION=$(cat "$BOX/VERSION")" "$ARGV_LOG"
}

@test "install: a theme seeding failure is a warning, not a failed install" {
    stub_docker_failing_on grappa.seed_themes
    run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -q 'up -d' "$ARGV_LOG"
}

@test "install: an already-seeded box is a warning, not a failed install" {
    stub_docker_failing_on grappa.create_user
    SEED_USER=tester SEED_PASSWORD=hunter2222 run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -q 'grappa.bind_network' "$ARGV_LOG"
    grep -q 'up -d' "$ARGV_LOG"
    [[ "$output" == *"already exists"* ]]
}

@test "install: off-localhost runs warn about the secure-context trap" {
    PHX_HOST=staging.example.org run "$DEPLOY" install
    [ "$status" -eq 0 ]
    [[ "$output" == *"service workers refuse to register"* ]]
}

@test "install: next to a box owned by another checkout is refused before anything is written" {
    export FAKE_OWNER_DIR="$BATS_TEST_TMPDIR/the-other-checkout"
    run "$DEPLOY" install
    [ "$status" -ne 0 ]
    [[ "$output" == *"$FAKE_OWNER_DIR"* ]]
    [ ! -f "$BOX/.env" ]
    refute grep -qE 'compose .*(up|build|run)' "$ARGV_LOG"
}

@test "install: a box owned by this checkout does not block a re-run" {
    export FAKE_OWNER_DIR="$BOX"
    run "$DEPLOY" install
    [ "$status" -eq 0 ]
    grep -q 'up -d' "$ARGV_LOG"
}

# ───────────────────────────────── stop ─────────────────────────────────

@test "stop: takes the prod profile down with --remove-orphans" {
    export FAKE_OWNER_DIR="$BOX"
    run "$DEPLOY" stop
    [ "$status" -eq 0 ]
    grep -qE 'docker compose .*--profile prod down' "$ARGV_LOG"
    grep -qE 'down .*--remove-orphans' "$ARGV_LOG"
}

@test "stop: pins the committed compose file, ignoring any override" {
    export FAKE_OWNER_DIR="$BOX"
    run "$DEPLOY" stop
    [ "$status" -eq 0 ]
    grep -qE 'docker compose -f compose.yaml' "$ARGV_LOG"
}

@test "stop: a box owned by another checkout is refused, not stopped" {
    export FAKE_OWNER_DIR="/somewhere/else/grappa-irc-469"
    run "$DEPLOY" stop
    [ "$status" -ne 0 ]
    [[ "$output" == *"/somewhere/else/grappa-irc-469"* ]]
    refute grep -q ' down' "$ARGV_LOG"
}

@test "stop: source mode outside a grappa checkout refuses before touching docker" {
    # With compose.yaml gone, auto-detect would flip to RELEASE mode (#503
    # unit D) — the no-source path. Pin source mode explicitly to exercise
    # the source-mode guard; auto-detect→release is covered by the
    # release-image suite.
    rm "$BOX/compose.yaml"
    GRAPPA_DEPLOY_MODE=source run "$DEPLOY" stop
    [ "$status" -ne 0 ]
    [ ! -s "$ARGV_LOG" ]
}

@test "stop: a box with no containers up is stopped anyway, and says so" {
    run "$DEPLOY" stop
    [ "$status" -eq 0 ]
    grep -qE 'docker compose .*--profile prod down' "$ARGV_LOG"
    [[ "$output" == *"nothing was running"* ]]
}

@test "stop: --volumes is passed through to compose, plain down is not" {
    export FAKE_OWNER_DIR="$BOX"
    run "$DEPLOY" stop --volumes
    [ "$status" -eq 0 ]
    grep -qE 'down .*(-v|--volumes)' "$ARGV_LOG"

    : > "$ARGV_LOG"
    run "$DEPLOY" stop
    [ "$status" -eq 0 ]
    refute grep -qE 'down .*(-v|--volumes)' "$ARGV_LOG"
}

@test "stop: an unknown flag is refused instead of being handed to compose" {
    export FAKE_OWNER_DIR="$BOX"
    run "$DEPLOY" stop --rm-rf-everything
    [ "$status" -ne 0 ]
    [ ! -s "$ARGV_LOG" ]
}
