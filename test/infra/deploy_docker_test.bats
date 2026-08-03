#!/usr/bin/env bats
#
# Characterization suite for scripts/deploy.sh — the operator Docker
# deploy orchestrator's DECISION logic, LOCKED before the #503 extraction
# of the shared deploy lib (infra/lib/deploy_common.sh). Captures the
# behaviors the extraction must preserve: the require_main_checkout guard,
# mode parsing (--force-hot/--force-cold/auto), the preflight invocation
# (substrate "docker", range from=pre-pull-HEAD to="HEAD"), the hot reload
# "failed":[] honesty + post-reload healthcheck, and the cold path step
# ordering.
#
# Scope: pure shell-side logic, mirroring test/infra/deploy_jail_test.bats.
# The script runs against a throwaway git clone (REPO_ROOT) pulled from a
# throwaway upstream, with `docker` stubbed via PATH (compose subcommands
# recorded + answered) and the version.sh delegate stubbed as a committed
# recorder. Real docker/compose is out of scope.
#
# #503 enrich gains have their own RED-GREEN sections at the bottom: the
# runtime/last-deployed-sha marker (the preflight `to` token is now a
# resolved sha, not the symbolic "HEAD", so it can be written to the
# marker) and the self-modifying-script re-exec guard (+ DEPLOY_PREV_SHA
# carry) — all now landed, bringing this substrate to parity with the jail.

load ../bats_helpers

setup() {
    # Normalize the tmpdir to its PHYSICAL path. On macOS $TMPDIR is a
    # symlink (/var/folders -> /private/var/folders); _lib.sh derives
    # SRC_ROOT via logical `pwd` but REPO_ROOT via git's physical
    # --path-format=absolute, so an unnormalized symlinked base makes the
    # two disagree and trips require_main_checkout's "this is a worktree"
    # guard. Real checkouts aren't under a symlinked path, so this is a
    # test-env artifact, not a production bug.
    BATS_TEST_TMPDIR="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"

    DEPLOY_SH="$BATS_TEST_DIRNAME/../../scripts/deploy.sh"
    LIB_SH="$BATS_TEST_DIRNAME/../../scripts/_lib.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$BATS_TEST_TMPDIR/argv.log"
    : > "$ARGV_LOG"
    export ARGV_LOG
    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"

    # ---- throwaway upstream + clone ------------------------------------
    UPSTREAM="$BATS_TEST_TMPDIR/upstream"
    git init -q -b main "$UPSTREAM"
    git -C "$UPSTREAM" config user.email test@grappa.local
    git -C "$UPSTREAM" config user.name "bats"

    mkdir -p "$UPSTREAM/scripts" "$UPSTREAM/infra/packaging" \
             "$UPSTREAM/infra/lib" "$UPSTREAM/runtime" "$UPSTREAM/lib"
    cp "$DEPLOY_SH" "$UPSTREAM/scripts/deploy.sh"
    cp "$LIB_SH" "$UPSTREAM/scripts/_lib.sh"
    chmod +x "$UPSTREAM/scripts/deploy.sh"
    # The ported consumer sources the shared algorithm lib (#503). It must
    # exist in the throwaway clone for the script to run — committed so
    # pulls stay clean. Assertions below are UNCHANGED by the extraction.
    cp "$BATS_TEST_DIRNAME/../../infra/lib/deploy_common.sh" "$UPSTREAM/infra/lib/deploy_common.sh"
    # version.sh delegate → committed recorder that echoes a version.
    cat > "$UPSTREAM/infra/packaging/version.sh" <<'EOF'
#!/bin/sh
echo 0.0.0-test
EOF
    chmod +x "$UPSTREAM/infra/packaging/version.sh"
    touch "$UPSTREAM/runtime/.gitkeep"
    echo base > "$UPSTREAM/lib/base.txt"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "base"

    export REPO_ROOT="$BATS_TEST_TMPDIR/repo"
    git clone -q "$UPSTREAM" "$REPO_ROOT"
    git -C "$REPO_ROOT" config user.email test@grappa.local
    git -C "$REPO_ROOT" config user.name "bats"

    # ---- env the script needs ------------------------------------------
    export PREFLIGHT_RC=0
    export RELOAD_FAILS=0
    export HOT_HEALTHCHECK_RETRIES=2 HOT_HEALTHCHECK_SLEEP=0

    # ---- PATH stubs ------------------------------------------------------
    # docker: record every compose invocation, then answer the ones the
    # deploy body reads back:
    #   compose ps -q grappa            → a fake container id (so in_container
    #                                      doesn't die "not running")
    #   compose run … mix run --no-start → preflight oneshot, honors PREFLIGHT_RC
    #   compose exec … curl … reload     → reload JSON (clean, or failing when
    #                                      $RELOAD_FAILS=1)
    #   everything else (build, run cicchetto-build, deps.get, ecto.migrate,
    #   up -d, exec … curl … healthz)    → succeed silently
    cat > "$FAKE_DIR/docker" <<'EOF'
#!/bin/sh
printf 'docker %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
    *"ps -q grappa"*)  echo fakecid ;;
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
    chmod +x "$FAKE_DIR"/*
    export PATH="$FAKE_DIR:$PATH"
}

# Append a commit touching $1 in the upstream; echo its sha.
commit_upstream() {
    echo "$RANDOM $(date +%s%N)" >> "$UPSTREAM/$1"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "touch $1"
    git -C "$UPSTREAM" rev-parse HEAD
}

make_env() { echo "SECRET_KEY_BASE=x" > "$REPO_ROOT/.env"; }

run_deploy() {
    # cd into the clone so _lib.sh's PWD-based SRC_ROOT detection resolves
    # to the clone (its .git is a directory), not the surrounding worktree
    # (whose .git is a FILE — the marker _lib.sh reads as "this is a
    # worktree", which would trip require_main_checkout before anything).
    cd "$REPO_ROOT"
    run "$REPO_ROOT/scripts/deploy.sh" "$@"
}

# --- require_main_checkout guard --------------------------------------------

@test "refuses to run on a non-main branch before any side effect" {
    git -C "$REPO_ROOT" checkout -q -b feature
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    [[ "$output" == *"branch"* ]]
    refute grep -q "docker" "$ARGV_LOG"          # aborted before any docker call
}

# --- mode parsing ------------------------------------------------------------

@test "unknown flag is a usage error" {
    run_deploy --bogus
    [ "$status" -ne 0 ]
    [[ "$output" == *"usage"* ]]
}

@test "auto mode: preflight classifies pre-pull HEAD .. new HEAD as substrate docker" {
    prev="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    # #503 enrich: the `to` token is now the RESOLVED new sha (not the
    # symbolic "HEAD"), so it can be written to the completed-deploy
    # marker — parity with jail + linux.
    grep -q "cli(\[\"$prev\", \"$new\", \"docker\"\])" "$ARGV_LOG"
}

@test "--force-hot skips preflight and reloads" {
    run_deploy --force-hot
    [ "$status" -eq 0 ]
    refute grep -q "run --no-start" "$ARGV_LOG"
    grep -q "exec -T grappa curl.*reload" "$ARGV_LOG"
}

@test "--force-cold skips preflight and cold-deploys" {
    make_env
    run_deploy --force-cold
    [ "$status" -eq 0 ]
    refute grep -q "run --no-start" "$ARGV_LOG"
    grep -q "up -d --force-recreate" "$ARGV_LOG"
}

@test "preflight non-verdict exit aborts and propagates the code" {
    export PREFLIGHT_RC=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 1 ]
    [[ "$output" == *"preflight"* ]]
}

# --- hot path ----------------------------------------------------------------

@test "hot path: reload then post-reload healthcheck, exit 0" {
    export PREFLIGHT_RC=0
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "exec -T grappa curl.*reload" "$ARGV_LOG"
    grep -q "exec -T grappa curl.*healthz" "$ARGV_LOG"
    refute grep -q "up -d" "$ARGV_LOG"           # hot path never recreates
}

@test "hot reload reporting per-module failures aborts non-zero" {
    export PREFLIGHT_RC=0 RELOAD_FAILS=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    [[ "$output" == *"failures"* ]]
    refute grep -q "up -d" "$ARGV_LOG"
}

# --- cold path ---------------------------------------------------------------

@test "cold path requires a .env file" {
    export PREFLIGHT_RC=3
    commit_upstream lib/base.txt > /dev/null
    # no make_env

    run_deploy
    [ "$status" -ne 0 ]
    [[ "$output" == *".env"* ]]
}

@test "cold path order: build -> cicchetto-build -> deps.get -> migrate -> up -> healthcheck" {
    export PREFLIGHT_RC=3
    make_env
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "build grappa" "$ARGV_LOG"
    grep -q "cicchetto-build" "$ARGV_LOG"
    grep -q "deps.get" "$ARGV_LOG"
    grep -q "ecto.migrate" "$ARGV_LOG"
    grep -q "up -d --force-recreate" "$ARGV_LOG"

    build_line=$(grep -n "build grappa" "$ARGV_LOG" | head -1 | cut -d: -f1)
    cic_line=$(grep -n "cicchetto-build" "$ARGV_LOG" | head -1 | cut -d: -f1)
    deps_line=$(grep -n "deps.get" "$ARGV_LOG" | head -1 | cut -d: -f1)
    mig_line=$(grep -n "ecto.migrate" "$ARGV_LOG" | head -1 | cut -d: -f1)
    up_line=$(grep -n "up -d --force-recreate" "$ARGV_LOG" | head -1 | cut -d: -f1)
    [ "$build_line" -lt "$cic_line" ]
    [ "$cic_line" -lt "$deps_line" ]
    [ "$deps_line" -lt "$mig_line" ]
    [ "$mig_line" -lt "$up_line" ]
}

# --- #503 enrich: completed-deploy marker (parity with jail + linux) ----------

@test "hot deploy writes the completed-deploy marker as final step" {
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

@test "cold deploy writes the completed-deploy marker as final step" {
    export PREFLIGHT_RC=3
    make_env
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

@test "marker present: preflight base is the marker, not the pre-pull HEAD" {
    marker="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    commit_upstream lib/base.txt > /dev/null
    git -C "$REPO_ROOT" pull -q --ff-only   # cic-deploy analogue: HEAD advances
    prev="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$marker" > "$REPO_ROOT/runtime/last-deployed-sha"
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "cli(\[\"$marker\", \"$new\", \"docker\"\])" "$ARGV_LOG"
    refute grep -q "cli(\[\"$prev\"" "$ARGV_LOG"
}

@test "garbage marker aborts loudly before preflight runs" {
    printf 'deadbeef\n' > "$REPO_ROOT/runtime/last-deployed-sha"
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    [[ "$output" == *"last-deployed-sha"* ]]
    refute grep -q "run --no-start" "$ARGV_LOG"
}

# --- #503 enrich: self-modifying-script re-exec guard (+ prev-sha carry) ------

@test "deploy.sh touched in THIS pull re-execs and still completes" {
    new="$(commit_upstream scripts/deploy.sh)"

    run_deploy
    [ "$status" -eq 0 ]
    [[ "$output" == *"re-exec"* ]]
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

@test "re-exec carries the pre-pull HEAD as preflight base (no marker)" {
    prev="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    new="$(commit_upstream scripts/deploy.sh)"   # deploy.sh change → re-exec

    run_deploy
    [ "$status" -eq 0 ]
    [[ "$output" == *"re-exec"* ]]
    # Doubles as the carry regression gate: re-exec ON but carry OFF would
    # collapse the range to new..new (the re-pulled run's own pre-pull HEAD
    # equals new). The carry keeps the ORIGINAL pre-pull HEAD.
    grep -q "cli(\[\"$prev\", \"$new\", \"docker\"\])" "$ARGV_LOG"
    refute grep -q "cli(\[\"$new\", \"$new\"" "$ARGV_LOG"
}

@test "lib change (deploy_common.sh) in THIS pull also re-execs" {
    # Append a harmless COMMENT (not commit_upstream's random text, which
    # would corrupt the sourced lib and abort the re-exec'd run) — the
    # re-exec guard matches infra/lib/deploy_common.sh as well as the
    # consumer script, so the extracted algorithm reloads its own bytes.
    echo "# bats touch $RANDOM" >> "$UPSTREAM/infra/lib/deploy_common.sh"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "touch lib"

    run_deploy
    [ "$status" -eq 0 ]
    [[ "$output" == *"re-exec"* ]]
}
