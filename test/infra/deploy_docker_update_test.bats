#!/usr/bin/env bats
#
# Bats suite for `infra/docker/deploy.sh update` (+ the bare idempotent
# entry) — the verb that consumes the shared deploy algorithm
# (infra/lib/deploy_common.sh) to classify hot-vs-cold via
# Grappa.Deploy.Preflight, the #503 win over quickstart-update.sh's
# always-recreate regex table.
#
# Harness mirrors test/infra/deploy_docker_test.bats (the operator
# scripts/deploy.sh suite): a throwaway git clone (REPO_ROOT) pulled from a
# throwaway upstream, with `docker` stubbed on PATH — compose subcommands
# recorded + answered (ps/inspect for the ownership guard, the preflight
# oneshot honoring PREFLIGHT_RC, the reload JSON honoring RELOAD_FAILS,
# everything else silent). install + stop verbs live in
# deploy_docker_verbs_test.bats (a box-skeleton harness, no pull).

load ../bats_helpers

setup() {
    # macOS $TMPDIR symlink normalization — REPO_ROOT is git's physical
    # path, keep the base physical too so the two agree.
    BATS_TEST_TMPDIR="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"

    REPO_SRC="$BATS_TEST_DIRNAME/../.."

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$BATS_TEST_TMPDIR/argv.log"
    : > "$ARGV_LOG"
    export ARGV_LOG
    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"

    export GIT_CONFIG_GLOBAL="$BATS_TEST_TMPDIR/gitconfig"
    export GIT_AUTHOR_NAME=bats GIT_AUTHOR_EMAIL=bats@example.org
    export GIT_COMMITTER_NAME=bats GIT_COMMITTER_EMAIL=bats@example.org

    # ---- throwaway upstream + clone ------------------------------------
    UPSTREAM="$BATS_TEST_TMPDIR/upstream"
    git init -q -b main "$UPSTREAM"
    mkdir -p "$UPSTREAM/infra/docker" "$UPSTREAM/infra/lib" "$UPSTREAM/infra/packaging" \
             "$UPSTREAM/runtime" "$UPSTREAM/lib"
    cp "$REPO_SRC/infra/docker/deploy.sh" "$UPSTREAM/infra/docker/deploy.sh"
    cp "$REPO_SRC/infra/lib/deploy_common.sh" "$UPSTREAM/infra/lib/deploy_common.sh"
    # The REAL version carrier + extractor (#538/#652): source mode derives
    # GRAPPA_VERSION from them at init so every compose call inherits it, and a
    # cic build with an empty value is refused by vite (#692).
    cp "$REPO_SRC/VERSION" "$UPSTREAM/VERSION"
    cp "$REPO_SRC/infra/packaging/version.sh" "$UPSTREAM/infra/packaging/version.sh"
    chmod +x "$UPSTREAM/infra/docker/deploy.sh" "$UPSTREAM/infra/packaging/version.sh"
    # The ownership guard reads container_name out of compose.yaml.
    cat > "$UPSTREAM/compose.yaml" <<'EOF'
services:
  grappa:
    container_name: grappa
EOF
    touch "$UPSTREAM/runtime/.gitkeep"
    echo base > "$UPSTREAM/lib/base.txt"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "base"

    export REPO_ROOT="$BATS_TEST_TMPDIR/repo"
    git clone -q "$UPSTREAM" "$REPO_ROOT"

    # An installed box has a .env. Default: post-#485 (GRAPPA_PUBLISH only).
    cat > "$REPO_ROOT/.env" <<'EOF'
MIX_ENV=prod
PHX_HOST=staging.example.org
GRAPPA_PUBLISH=127.0.0.1:3100
EOF

    # ---- env the script needs ------------------------------------------
    export PREFLIGHT_RC=0
    export RELOAD_FAILS=0
    export HOT_HEALTHCHECK_RETRIES=2 HOT_HEALTHCHECK_SLEEP=0
    export COLD_HEALTHCHECK_RETRIES=2 COLD_HEALTHCHECK_SLEEP=0
    # The box is up and owned by us by default (so update doesn't force cold
    # for a down stack). Tests that need a down box unset this.
    export FAKE_OWNER_DIR="$REPO_ROOT"

    # ---- docker stub ---------------------------------------------------
    # Record $* unquoted (like deploy_docker_test.bats) so the preflight
    # cli([from, to, "docker"]) range is greppable verbatim.
    cat > "$FAKE_DIR/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$ARGV_LOG"
# Record the value the cic build would actually SEE. compose passes
# `GRAPPA_VERSION: ${GRAPPA_VERSION:-}` through from this environment, so an
# unexported variable reaches vite empty and the build refuses to run (#692).
case "$*" in
    *cicchetto-build*) printf 'env GRAPPA_VERSION=%s\n' "${GRAPPA_VERSION:-}" >> "$ARGV_LOG" ;;
esac
if [ "$1" = inspect ]; then
    [ -n "${FAKE_OWNER_DIR:-}" ] || exit 1
    printf '%s\n' "$FAKE_OWNER_DIR"
    exit 0
fi
case "$*" in
    *"run --no-start"*) exit "$PREFLIGHT_RC" ;;
    *"exec -T grappa curl"*reload*)
        if [ "$RELOAD_FAILS" = "1" ]; then
            printf '{"loaded":[],"failed":[{"module":"Foo","reason":"old_code_in_use"}]}'
        else
            printf '{"loaded":[],"failed":[]}'
        fi
        ;;
esac
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"

    DEPLOY="$REPO_ROOT/infra/docker/deploy.sh"
}

# Append a commit touching $1 in the upstream; echo its sha. The appended
# line is a `#` comment: inert in a text file AND harmless if $1 is a shell
# script the re-exec path pulls + runs (the re-exec test touches deploy.sh).
# rev-list count keeps the content unique per call so git always sees a diff.
commit_upstream() {
    local n
    n="$(git -C "$UPSTREAM" rev-list --count HEAD)"
    printf '# bats touch %s %s\n' "$1" "$n" >> "$UPSTREAM/$1"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "touch $1"
    git -C "$UPSTREAM" rev-parse HEAD
}

# Land a version bump upstream, the way a real release does: VERSION only, no
# deploy-code change — so the re-exec guard does NOT fire and the running
# process keeps whatever it derived before the pull.
bump_upstream_version() {
    printf '%s\n' "$1" > "$UPSTREAM/VERSION"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "bump to $1"
}

run_update() {
    cd "$REPO_ROOT"
    run "$DEPLOY" update "$@"
}

# ─────────────────────────── refusals / guards ──────────────────────────

@test "update: a box that was never installed is refused, not half-updated" {
    rm "$REPO_ROOT/.env"
    run_update
    [ "$status" -ne 0 ]
    [[ "$output" == *"install"* ]]
    refute grep -q "run --no-start" "$ARGV_LOG"
    refute grep -q "force-recreate" "$ARGV_LOG"
}

@test "update: a dirty working tree is refused before anything is pulled or recreated" {
    printf 'scribble\n' >> "$REPO_ROOT/lib/base.txt"
    commit_upstream lib/base.txt > /dev/null

    run_update
    [ "$status" -ne 0 ]
    [[ "$output" == *"uncommitted"* ]]
    [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$(git -C "$UPSTREAM" rev-parse HEAD)" ]
    refute grep -q "force-recreate" "$ARGV_LOG"
}

@test "update: a diverged branch fails loud instead of merging or recreating" {
    commit_upstream lib/base.txt > /dev/null
    printf 'local divergence\n' > "$REPO_ROOT/lib/base.txt"
    git -C "$REPO_ROOT" commit -qam "local"

    run_update
    [ "$status" -ne 0 ]
    refute grep -q "force-recreate" "$ARGV_LOG"
}

@test "update: a box owned by another checkout is refused, and the owner is named" {
    export FAKE_OWNER_DIR="$BATS_TEST_TMPDIR/some-other-checkout"
    commit_upstream lib/base.txt > /dev/null

    run_update
    [ "$status" -ne 0 ]
    [[ "$output" == *"$FAKE_OWNER_DIR"* ]]
    [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$(git -C "$UPSTREAM" rev-parse HEAD)" ]
    refute grep -q "force-recreate" "$ARGV_LOG"
}

# ───────────────────── hot-vs-cold via preflight (#503) ──────────────────

@test "update: box up + code change + HOT verdict reloads, never recreates" {
    export PREFLIGHT_RC=0
    prev="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    new="$(commit_upstream lib/base.txt)"

    run_update
    [ "$status" -eq 0 ]
    grep -q "cli(\[\"$prev\", \"$new\", \"docker\"\])" "$ARGV_LOG"
    grep -q "exec -T grappa curl.*reload" "$ARGV_LOG"
    refute grep -q "up -d" "$ARGV_LOG"                 # hot never recreates
}

@test "update: box up + code change + COLD verdict recreates, never reloads" {
    export PREFLIGHT_RC=3
    commit_upstream lib/base.txt > /dev/null

    run_update
    [ "$status" -eq 0 ]
    grep -q "up -d --force-recreate" "$ARGV_LOG"
    refute grep -q "exec -T grappa curl.*reload" "$ARGV_LOG"
}

@test "update: the cold cic rebuild carries GRAPPA_VERSION from the VERSION file (#692)" {
    export PREFLIGHT_RC=3
    commit_upstream lib/base.txt > /dev/null

    run_update
    [ "$status" -eq 0 ]
    grep -q "run --rm cicchetto-build" "$ARGV_LOG"
    # Exact value, not just "non-empty": the bundle bakes it into
    # <meta cicchetto-version>, so a wrong number is as bad as a missing one.
    grep -Fqx "env GRAPPA_VERSION=$(cat "$REPO_ROOT/VERSION")" "$ARGV_LOG"
}

@test "update: the cic rebuild carries the version the pull brought IN, not the one the box was on (#692)" {
    export PREFLIGHT_RC=3
    was_on="$(cat "$REPO_ROOT/VERSION")"
    bump_upstream_version 99.99.99

    run_update
    [ "$status" -eq 0 ]
    # Deriving before the pull still "works" — the build succeeds and bakes the
    # PREVIOUS number into <meta cicchetto-version>, which is the silent
    # staleness #652 exists to prevent. Pin both halves.
    grep -Fqx "env GRAPPA_VERSION=99.99.99" "$ARGV_LOG"
    refute grep -Fqx "env GRAPPA_VERSION=$was_on" "$ARGV_LOG"
}

@test "update: preflight non-verdict exit aborts and propagates the code" {
    export PREFLIGHT_RC=1
    commit_upstream lib/base.txt > /dev/null

    run_update
    [ "$status" -eq 1 ]
    [[ "$output" == *"preflight"* ]]
}

@test "update: hot reload reporting per-module failures aborts non-zero" {
    export PREFLIGHT_RC=0 RELOAD_FAILS=1
    commit_upstream lib/base.txt > /dev/null

    run_update
    [ "$status" -ne 0 ]
    [[ "$output" == *"failures"* ]]
    refute grep -q "up -d" "$ARGV_LOG"
}

# ─────────────────── down box + --no-pull → cold (start again) ───────────

@test "update: a stopped box is brought up cold even when the diff would be hot" {
    export PREFLIGHT_RC=0            # would be HOT if the box were up
    unset FAKE_OWNER_DIR            # nothing running → BOX_RUNNING=0
    commit_upstream lib/base.txt > /dev/null

    run_update
    [ "$status" -eq 0 ]
    refute grep -q "run --no-start" "$ARGV_LOG"        # down box skips preflight (forced cold)
    grep -q "up -d --force-recreate" "$ARGV_LOG"
}

@test "update --no-pull recreates from the working tree and leaves git alone" {
    export PREFLIGHT_RC=0            # would be HOT via preflight; --no-pull forces cold
    commit_upstream lib/base.txt > /dev/null      # upstream moves, we do NOT pull it
    before="$(git -C "$REPO_ROOT" rev-parse HEAD)"

    run_update --no-pull
    [ "$status" -eq 0 ]
    [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$before" ]   # no pull
    refute grep -q "run --no-start" "$ARGV_LOG"                    # empty range not classified
    grep -q "up -d --force-recreate" "$ARGV_LOG"
}

# ──────────────────────────── --force-* flags ───────────────────────────

@test "update --force-hot skips preflight and reloads" {
    commit_upstream lib/base.txt > /dev/null
    run_update --force-hot
    [ "$status" -eq 0 ]
    refute grep -q "run --no-start" "$ARGV_LOG"
    grep -q "exec -T grappa curl.*reload" "$ARGV_LOG"
}

@test "update --force-cold skips preflight and recreates" {
    export PREFLIGHT_RC=0
    commit_upstream lib/base.txt > /dev/null
    run_update --force-cold
    [ "$status" -eq 0 ]
    refute grep -q "run --no-start" "$ARGV_LOG"
    grep -q "up -d --force-recreate" "$ARGV_LOG"
}

@test "update: an unknown flag is a usage error" {
    run_update --bogus
    [ "$status" -ne 0 ]
    [[ "$output" == *"usage"* ]]
}

# ─────────────────────────── marker + re-exec ───────────────────────────

@test "update: completion writes the completed-deploy marker" {
    new="$(commit_upstream lib/base.txt)"
    run_update
    [ "$status" -eq 0 ]
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

@test "update: marker present → preflight base is the marker, not pre-pull HEAD" {
    marker="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    commit_upstream lib/base.txt > /dev/null
    git -C "$REPO_ROOT" pull -q --ff-only
    prev="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$marker" > "$REPO_ROOT/runtime/last-deployed-sha"
    new="$(commit_upstream lib/base.txt)"

    run_update
    [ "$status" -eq 0 ]
    grep -q "cli(\[\"$marker\", \"$new\", \"docker\"\])" "$ARGV_LOG"
    refute grep -q "cli(\[\"$prev\"" "$ARGV_LOG"
}

@test "update: deploy.sh touched in THIS pull re-execs (verb preserved) and completes" {
    new="$(commit_upstream infra/docker/deploy.sh)"
    run_update
    [ "$status" -eq 0 ]
    [[ "$output" == *"re-exec"* ]]
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

@test "update: lib change (deploy_common.sh) in THIS pull also re-execs" {
    echo "# bats touch update" >> "$UPSTREAM/infra/lib/deploy_common.sh"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "touch lib"

    run_update
    [ "$status" -eq 0 ]
    [[ "$output" == *"re-exec"* ]]
}

# ─────────────────────────────── #485 migration ─────────────────────────

@test "update: a pre-#485 .env is migrated in place, NGINX_PUBLISH → GRAPPA_PUBLISH" {
    cat > "$REPO_ROOT/.env" <<'EOF'
MIX_ENV=prod
PHX_HOST=staging.example.org
NGINX_PUBLISH=127.0.0.1:3100:80
EOF
    commit_upstream lib/base.txt > /dev/null

    run_update
    [ "$status" -eq 0 ]
    refute grep -q '^NGINX_PUBLISH=' "$REPO_ROOT/.env"
    grep -qE '^GRAPPA_PUBLISH=127\.0\.0\.1:3100$' "$REPO_ROOT/.env"
    [[ "$output" == *"NGINX_PUBLISH is deprecated"* ]]
}

# ─────────────────────────── bare = idempotent ──────────────────────────

@test "bare: with a .env present, runs update (pulls)" {
    new="$(commit_upstream lib/base.txt)"
    cd "$REPO_ROOT"
    run "$DEPLOY"
    [ "$status" -eq 0 ]
    [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$new" ]   # update pulled
}

@test "bare: with no .env, runs install (no pull, scaffolds .env)" {
    rm "$REPO_ROOT/.env"
    cp "$REPO_SRC/.env.example" "$REPO_ROOT/.env.example"
    cp "$REPO_SRC/infra/nginx-tls-frontend.example.conf" "$REPO_ROOT/infra/"
    before="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    commit_upstream lib/base.txt > /dev/null              # upstream moves; install must NOT pull

    cd "$REPO_ROOT"
    run "$DEPLOY"
    [ "$status" -eq 0 ]
    [ -f "$REPO_ROOT/.env" ]                              # install scaffolded it
    [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$before" ]  # install never pulls
}
