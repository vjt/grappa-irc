#!/usr/bin/env bats
#
# Bats suite for infra/freebsd/deploy.sh — the jail deploy orchestrator's
# DECISION logic: preflight range base (defect #7), the nothing-to-do
# fast path vs --force-* (defect #8), the re-exec guard's range, and the
# cold path's stop synchronization call (defect #9, deploy.sh side).
#
# Scope: pure shell-side logic. The script runs against a throwaway git
# clone (REPO_ROOT) pulled from a throwaway upstream, with `su`, `mix`,
# `curl`, `service` stubbed via PATH and the jail_*.sh delegates stubbed
# as committed recorders inside the temp repo. What only a real jail
# deploy exercises (rc.subr, run_erl, the live BEAM) is out of scope —
# see the manual verification plan in the shipping commit.

setup() {
    DEPLOY_SH="$BATS_TEST_DIRNAME/../../infra/freebsd/deploy.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$BATS_TEST_TMPDIR/argv.log"
    : > "$ARGV_LOG"
    export ARGV_LOG

    # ---- throwaway upstream + clone ------------------------------------
    UPSTREAM="$BATS_TEST_TMPDIR/upstream"
    git init -q -b main "$UPSTREAM"
    git -C "$UPSTREAM" config user.email test@grappa.local
    git -C "$UPSTREAM" config user.name "bats"

    mkdir -p "$UPSTREAM/infra/freebsd" "$UPSTREAM/runtime" "$UPSTREAM/lib"
    cp "$DEPLOY_SH" "$UPSTREAM/infra/freebsd/deploy.sh"
    # jail_*.sh delegates → recorders. Committed so pulls stay clean.
    for stub in jail_cic_build.sh jail_release.sh jail_install_rcd.sh jail_beam_wait.sh; do
        cat > "$UPSTREAM/infra/freebsd/$stub" <<EOF
#!/bin/sh
printf '%s %s\n' "$stub" "\$*" >> "\$ARGV_LOG"
exit 0
EOF
        chmod +x "$UPSTREAM/infra/freebsd/$stub"
    done
    touch "$UPSTREAM/runtime/.gitkeep"
    echo base > "$UPSTREAM/lib/base.txt"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "base"

    export REPO_ROOT="$BATS_TEST_TMPDIR/repo"
    git clone -q "$UPSTREAM" "$REPO_ROOT"
    git -C "$REPO_ROOT" config user.email test@grappa.local
    git -C "$REPO_ROOT" config user.name "bats"

    # ---- env the script needs ------------------------------------------
    export ENV_FILE="$BATS_TEST_TMPDIR/grappa.env"
    echo "DUMMY=1" > "$ENV_FILE"
    export HEALTHCHECK_RETRIES=2 HEALTHCHECK_SLEEP=0
    export PREFLIGHT_RC=0

    # ---- PATH stubs ------------------------------------------------------
    # su -l grappa -c '<cmd>' → run <cmd> in-process (env preserved; the
    # real `su -l` strips env, but the deploy body re-exports what it
    # needs and the stubs only need ARGV_LOG/PREFLIGHT_RC from the test).
    cat > "$FAKE_DIR/su" <<'EOF'
#!/bin/sh
while [ $# -gt 0 ]; do
    if [ "$1" = "-c" ]; then shift; exec /bin/sh -c "$1"; fi
    shift
done
echo "fake su: no -c arg" >&2
exit 64
EOF

    # mix: preflight oneshot honors $PREFLIGHT_RC; build verbs succeed.
    cat > "$FAKE_DIR/mix" <<'EOF'
#!/bin/sh
printf 'mix %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
    "run --no-start"*) exit "$PREFLIGHT_RC" ;;
    *) exit 0 ;;
esac
EOF

    # curl: reload POST answers a clean reload; healthcheck answers 200.
    cat > "$FAKE_DIR/curl" <<'EOF'
#!/bin/sh
printf 'curl %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
    *"-X POST"*reload*) printf '{"loaded":[],"failed":[]}' ;;
esac
exit 0
EOF

    cat > "$FAKE_DIR/service" <<'EOF'
#!/bin/sh
printf 'service %s\n' "$*" >> "$ARGV_LOG"
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

run_deploy() {
    run "$REPO_ROOT/infra/freebsd/deploy.sh" "$@"
}

# --- #7: preflight range base ----------------------------------------------

@test "no marker: preflight falls back to pre-pull HEAD as range base" {
    prev="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "cli(\[\"$prev\", \"$new\", \"jail\"\])" "$ARGV_LOG"
}

@test "marker present: preflight base is the marker, not the pre-pull HEAD" {
    marker="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    commit_upstream lib/base.txt > /dev/null
    git -C "$REPO_ROOT" pull -q --ff-only   # cic-deploy analogue: HEAD advances, no server deploy
    prev="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$marker" > "$REPO_ROOT/runtime/last-deployed-sha"
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "cli(\[\"$marker\", \"$new\", \"jail\"\])" "$ARGV_LOG"
    ! grep -q "cli(\[\"$prev\"" "$ARGV_LOG"
}

@test "garbage marker: deploy aborts loudly before preflight runs" {
    printf 'deadbeef\n' > "$REPO_ROOT/runtime/last-deployed-sha"
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    [[ "$output" == *"last-deployed-sha"* ]]
    ! grep -q "run --no-start" "$ARGV_LOG"
}

@test "well-formed marker sha that is not a commit aborts loudly too" {
    printf '%040d\n' 0 > "$REPO_ROOT/runtime/last-deployed-sha"
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    [[ "$output" == *"last-deployed-sha"* ]]
    ! grep -q "run --no-start" "$ARGV_LOG"
}

@test "hot deploy completes and writes the marker as final step" {
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

# --- #7 caveat (a): re-exec guard stays keyed on the PRE-PULL range ---------

@test "deploy.sh touched between marker and pre-pull HEAD does NOT re-exec" {
    marker="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    commit_upstream infra/freebsd/deploy.sh > /dev/null
    git -C "$REPO_ROOT" pull -q --ff-only   # running bytes already current
    printf '%s\n' "$marker" > "$REPO_ROOT/runtime/last-deployed-sha"
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    [[ "$output" != *"re-exec"* ]]
    grep -q "cli(\[\"$marker\", \"$new\", \"jail\"\])" "$ARGV_LOG"
}

@test "deploy.sh touched in THIS pull still re-execs" {
    new="$(commit_upstream infra/freebsd/deploy.sh)"

    run_deploy
    [ "$status" -eq 0 ]
    [[ "$output" == *"re-exec"* ]]
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

# --- #8: nothing-to-do fast path is auto-mode only ---------------------------

@test "auto + same HEAD + marker match exits 0 stating what it observed" {
    head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$head" > "$REPO_ROOT/runtime/last-deployed-sha"

    run_deploy
    [ "$status" -eq 0 ]
    [[ "$output" == *"marker"* ]]
    ! grep -q "service" "$ARGV_LOG"
    ! grep -q "mix deps.get" "$ARGV_LOG"
}

@test "--force-cold overrides the nothing-to-do fast path" {
    head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$head" > "$REPO_ROOT/runtime/last-deployed-sha"

    run_deploy --force-cold
    [ "$status" -eq 0 ]
    [[ "$output" == *"force"* ]]
    grep -q "service grappa stop" "$ARGV_LOG"
    grep -q "service grappa start" "$ARGV_LOG"
    ! grep -q "run --no-start" "$ARGV_LOG"   # forced mode skips preflight
}

@test "--force-hot overrides the nothing-to-do fast path" {
    head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$head" > "$REPO_ROOT/runtime/last-deployed-sha"

    run_deploy --force-hot
    [ "$status" -eq 0 ]
    grep -q "mix deps.get --only prod" "$ARGV_LOG"
    ! grep -q "run --no-start" "$ARGV_LOG"
}

# --- #9 (deploy.sh side): cold path synchronizes on BEAM stop ----------------

@test "cold path waits for BEAM exit + name release between stop and start" {
    export PREFLIGHT_RC=3
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "jail_beam_wait.sh wait-stopped grappa" "$ARGV_LOG"
    # ordering: stop → wait-stopped → rc.d refresh → start
    stop_line=$(grep -n "service grappa stop" "$ARGV_LOG" | cut -d: -f1)
    wait_line=$(grep -n "jail_beam_wait.sh wait-stopped" "$ARGV_LOG" | cut -d: -f1)
    rcd_line=$(grep -n "jail_install_rcd.sh" "$ARGV_LOG" | cut -d: -f1)
    start_line=$(grep -n "service grappa start" "$ARGV_LOG" | cut -d: -f1)
    [ "$stop_line" -lt "$wait_line" ]
    [ "$wait_line" -lt "$rcd_line" ]
    [ "$rcd_line" -lt "$start_line" ]
}
