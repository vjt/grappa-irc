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

load ../bats_helpers

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

    mkdir -p "$UPSTREAM/infra/freebsd/bin" "$UPSTREAM/infra/lib" "$UPSTREAM/runtime" "$UPSTREAM/lib"
    cp "$DEPLOY_SH" "$UPSTREAM/infra/freebsd/deploy.sh"
    # The ported consumer sources the shared algorithm lib (#503). It must
    # exist in the throwaway clone for the script to run — committed so
    # pulls stay clean. Assertions below are UNCHANGED by the extraction.
    cp "$BATS_TEST_DIRNAME/../../infra/lib/deploy_common.sh" "$UPSTREAM/infra/lib/deploy_common.sh"
    echo wrapper > "$UPSTREAM/infra/freebsd/bin/grappa-source-alias"
    # jail_*.sh delegates → recorders. Committed so pulls stay clean.
    for stub in jail_cic_build.sh jail_release.sh jail_install_rcd.sh jail_install_source_alias.sh jail_beam_wait.sh; do
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
    # #541 outcome harness: the preflight oneshot compiles, so on a pull
    # that moved mix.exs/mix.lock it aborts on stale deps UNLESS deps.get
    # ran first. STRICT_PREFLIGHT_DEPS=1 makes the mix stub model that real
    # failure (via a marker deps.get drops); default off keeps every other
    # test's oneshot honoring PREFLIGHT_RC unconditionally.
    export DEPS_MARKER="$BATS_TEST_TMPDIR/deps-synced"

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
    # deps.get drops a marker; the oneshot models mix's stale-deps abort
    # (exit 1) when STRICT_PREFLIGHT_DEPS=1 and no deps.get preceded it.
    cat > "$FAKE_DIR/mix" <<'EOF'
#!/bin/sh
printf 'mix %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
    "deps.get"*) : > "$DEPS_MARKER" ;;
    "run --no-start"*)
        if [ "${STRICT_PREFLIGHT_DEPS:-0}" = 1 ] && [ ! -f "$DEPS_MARKER" ]; then
            echo "** (Mix) Can't continue due to errors on stale dependencies" >&2
            exit 1
        fi
        exit "$PREFLIGHT_RC"
        ;;
esac
exit 0
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
    refute grep -q "cli(\[\"$prev\"" "$ARGV_LOG"
}

@test "garbage marker: deploy aborts loudly before preflight runs" {
    printf 'deadbeef\n' > "$REPO_ROOT/runtime/last-deployed-sha"
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    [[ "$output" == *"last-deployed-sha"* ]]
    refute grep -q "run --no-start" "$ARGV_LOG"
}

@test "well-formed marker sha that is not a commit aborts loudly too" {
    printf '%040d\n' 0 > "$REPO_ROOT/runtime/last-deployed-sha"
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    [[ "$output" == *"last-deployed-sha"* ]]
    refute grep -q "run --no-start" "$ARGV_LOG"
}

@test "hot deploy completes and writes the marker as final step" {
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
    # The lib captures substrate_reload's stdout as the response body, so
    # the hook's pre-reload log must NOT leak into it — a polluted capture
    # would read "reload response: [deploy] POST ..." and make the
    # "failed":[] honesty glob depend on the log text.
    [[ "$output" != *"reload response: [deploy]"* ]]
}

# Regression: a substrate hook the lib evaluates inside `base=$(...)` must
# not emit to STDOUT — a `su -l grappa` login banner would otherwise splice
# into the captured preflight range base and crash the mix oneshot. The
# default `su` stub is noise-free (so the other suites can't catch this);
# here we make it emit a banner and assert the base stays clean.
@test "noisy su login banner does NOT pollute the preflight range base" {
    cat > "$FAKE_DIR/su" <<'EOF'
#!/bin/sh
echo "Last login: Tue on ttyv0"     # login-shell banner to STDOUT
while [ $# -gt 0 ]; do
    if [ "$1" = "-c" ]; then shift; exec /bin/sh -c "$1"; fi
    shift
done
echo "fake su: no -c arg" >&2
exit 64
EOF
    chmod +x "$FAKE_DIR/su"

    marker="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$marker" > "$REPO_ROOT/runtime/last-deployed-sha"
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    # base must be the bare marker sha — not "Last login...<marker>".
    grep -q "cli(\[\"$marker\", \"$new\", \"jail\"\])" "$ARGV_LOG"
    refute grep -q "cli(\[\"Last login" "$ARGV_LOG"
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
    refute grep -q "service" "$ARGV_LOG"
    refute grep -q "mix deps.get" "$ARGV_LOG"
}

@test "--force-cold overrides the nothing-to-do fast path" {
    head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$head" > "$REPO_ROOT/runtime/last-deployed-sha"

    run_deploy --force-cold
    [ "$status" -eq 0 ]
    [[ "$output" == *"force"* ]]
    grep -q "service grappa stop" "$ARGV_LOG"
    grep -q "service grappa start" "$ARGV_LOG"
    refute grep -q "run --no-start" "$ARGV_LOG"   # forced mode skips preflight
}

@test "--force-hot overrides the nothing-to-do fast path" {
    head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$head" > "$REPO_ROOT/runtime/last-deployed-sha"

    run_deploy --force-hot
    [ "$status" -eq 0 ]
    grep -q "mix deps.get --only prod" "$ARGV_LOG"
    refute grep -q "run --no-start" "$ARGV_LOG"
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

# --- #646: the source-alias wrapper is reconciled on EVERY deploy ------------
#
# Shipping #610 pulled a new privilege wrapper and never installed it: the
# install lived only in substrate_restart (cold), and no Preflight class
# covers `infra/freebsd/bin/*`, so a wrapper-only change classifies HOT and
# the installed wrapper stayed the pre-#610 one. The new code's `probe`
# exited 64 → mode 2 disarmed → 44 visitors rejected in production.
#
# The cure is reconciliation, not classification: the deploy installs the
# wrapper on BOTH paths, before the new code can call it.

@test "#646: hot deploy installs the source-alias wrapper before the reload" {
    commit_upstream infra/freebsd/bin/grappa-source-alias > /dev/null

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "jail_install_source_alias.sh" "$ARGV_LOG"
    # Order matters in one direction only: new code + old wrapper is the
    # outage (exit 64), old code + new wrapper is a benign seconds-long
    # window. So the install must land BEFORE /admin/reload.
    sa_line=$(grep -n "jail_install_source_alias.sh" "$ARGV_LOG" | head -1 | cut -d: -f1)
    reload_line=$(grep -n "curl .*reload" "$ARGV_LOG" | head -1 | cut -d: -f1)
    [ "$sa_line" -lt "$reload_line" ]
}

@test "#646: cold deploy installs the source-alias wrapper before the restart" {
    export PREFLIGHT_RC=3
    commit_upstream infra/freebsd/bin/grappa-source-alias > /dev/null

    run_deploy
    [ "$status" -eq 0 ]
    sa_line=$(grep -n "jail_install_source_alias.sh" "$ARGV_LOG" | head -1 | cut -d: -f1)
    start_line=$(grep -n "service grappa start" "$ARGV_LOG" | cut -d: -f1)
    [ "$sa_line" -lt "$start_line" ]
}

# --- --defer-restart: build-only cold path (one-bounce vhost bind) -----------
#
# The host wrapper (deploy-m42.sh --full-restart) calls
# `deploy.sh --force-cold --defer-restart`: it must run the cold path
# THROUGH the rc.d-wrapper refresh (so the new release + wrappers are
# staged and the BEAM is stopped) but then exit 0 WITHOUT starting the
# daemon, healthchecking, or writing the completed-deploy marker — the
# host `bastille restart` boots the staged release and completes it.

@test "--force-cold --defer-restart stages + stops but does NOT start, healthcheck, or write marker" {
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-cold --defer-restart
    [ "$status" -eq 0 ]
    grep -q "service grappa stop" "$ARGV_LOG"
    grep -q "jail_beam_wait.sh wait-stopped grappa" "$ARGV_LOG"
    grep -q "jail_install_rcd.sh" "$ARGV_LOG"
    refute grep -q "service grappa start" "$ARGV_LOG"
    refute grep -q "curl" "$ARGV_LOG"                                   # no healthcheck
    [ ! -f "$REPO_ROOT/runtime/last-deployed-sha" ]               # marker NOT written
    [[ "$output" == *"--defer-restart"* ]]
    [[ "$output" == *"bastille-restart"* ]]
}

@test "--defer-restart --force-cold (reversed flag order) behaves identically" {
    commit_upstream lib/base.txt > /dev/null

    run_deploy --defer-restart --force-cold
    [ "$status" -eq 0 ]
    grep -q "jail_install_rcd.sh" "$ARGV_LOG"
    refute grep -q "service grappa start" "$ARGV_LOG"
    [ ! -f "$REPO_ROOT/runtime/last-deployed-sha" ]
    [[ "$output" == *"--defer-restart"* ]]
}

@test "--force-hot --defer-restart is a usage error (defer needs a stop)" {
    run_deploy --force-hot --defer-restart
    [ "$status" -eq 64 ]
    refute grep -q "service grappa stop" "$ARGV_LOG"
}

@test "auto preflight HOT + --defer-restart is a usage error" {
    export PREFLIGHT_RC=0                                          # hot verdict
    commit_upstream lib/base.txt > /dev/null

    run_deploy --defer-restart
    [ "$status" -eq 64 ]
    refute grep -q "service grappa stop" "$ARGV_LOG"
}

@test "unknown flag alongside a valid one is still a usage error (64)" {
    run_deploy --force-cold --bogus
    [ "$status" -eq 64 ]
}

# --- #541: deps sync precedes the preflight oneshot (Co-authored abonforti) ---

@test "#541: a dep-moving pull still reaches a verdict — deps fetched before preflight" {
    # OUTCOME, not sequence: `mix run --no-start` compiles, so a pull that
    # moved mix.exs/mix.lock aborts it on stale deps (exit 1 — a crash, not
    # a 0/3 verdict) and the deploy strands before the build step's own
    # deps.get. Fetching deps before the oneshot lets preflight classify and
    # the deploy complete. STRICT_PREFLIGHT_DEPS models that abort.
    export STRICT_PREFLIGHT_DEPS=1
    new="$(commit_upstream mix.lock)"

    run_deploy
    [ "$status" -eq 0 ]                                        # deploy completed
    grep -q "cli(\[.*\"jail\"\])" "$ARGV_LOG"                  # preflight reached a verdict
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}
