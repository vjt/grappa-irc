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
    # …and the jail NAME (#2022), sourced BEFORE the operator hints that quote
    # it. Absent, `set -eu` kills the script on line 46 with `No such file or
    # directory` and every case below fails at its first assertion, with the
    # cause nowhere in the bats output — which is exactly how it reached main.
    # One cp per lib the script sources is the shape the docker and linux
    # fixtures already use; it is a hand-kept mirror of the source list, and
    # this is the second entry it has ever had.
    cp "$BATS_TEST_DIRNAME/../../infra/lib/bastille_jail.sh" "$UPSTREAM/infra/lib/bastille_jail.sh"
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
    # jail_release.sh needs a smarter body than the generic recorder: it
    # carries BOTH the migration and the #440 seed, and the seed must be
    # independently failable to exercise the warn-and-continue branch.
    cat > "$UPSTREAM/infra/freebsd/jail_release.sh" <<'EOF'
#!/bin/sh
printf 'jail_release.sh %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
    *seed_themes*) exit "$SEED_RC" ;;
    *check_migrations*) exit "${CHECK_RC:-0}" ;;
esac
exit 0
EOF
    chmod +x "$UPSTREAM/infra/freebsd/jail_release.sh"
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
    # #440: SEED_RC injects a failing seed. Default 0 so only the warn-path
    # assertions below read the failure branch.
    export SEED_RC=0
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

    # curl: reload POST answers a clean reload; healthcheck answers
    # $HEALTHZ_STATUS (200 by default).
    #
    # #1656: the /healthz probe is modelled as REAL curl behaves, because the
    # whole point of the fix is which invocation keeps the body. `-f` discards
    # the response body and exits 22 on a non-2xx; the same URL without `-f`
    # exits 0 and PRINTS the body. A stub that failed both ways would let a
    # cure that never re-asks pass.
    cat > "$FAKE_DIR/curl" <<'EOF'
#!/bin/sh
printf 'curl %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
    *"-X POST"*reload*) printf '{"loaded":[],"failed":[]}'; exit 0 ;;
esac
case "$*" in
    *-f*)
        [ "${HEALTHZ_STATUS:-200}" = 200 ] || exit 22
        ;;
    *)
        printf '%s' "${HEALTHZ_BODY:-}"
        ;;
esac
exit 0
EOF

    # service: every verb succeeds except `status`, which answers
    # $SERVICE_STATUS_RC (0 = running, like rc.subr's status_cmd).
    cat > "$FAKE_DIR/service" <<'EOF'
#!/bin/sh
printf 'service %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
    *status*) exit "${SERVICE_STATUS_RC:-0}" ;;
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

# --- issue 1112 (D4): the cold path migrates with the old node STOPPED --------
#
# The order used to be migrate → stop → start, inherited rather than chosen:
# for the seconds between the migration and the stop the OLD code served the
# NEW schema. vjt's ruling (F1/F3 (a)): the lib orders stop → migrate → seed →
# start, always.

@test "issue 1112: the cold path stops the node and waits for the BEAM to exit BEFORE it migrates" {
    export PREFLIGHT_RC=3
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]

    check_line=$(grep -n "Grappa.Release.check_migrations()" "$ARGV_LOG" | head -1 | cut -d: -f1)
    stop_line=$(grep -n "service grappa stop" "$ARGV_LOG" | head -1 | cut -d: -f1)
    wait_line=$(grep -n "jail_beam_wait.sh wait-stopped" "$ARGV_LOG" | head -1 | cut -d: -f1)
    mig_line=$(grep -n "Grappa.Release.migrate()" "$ARGV_LOG" | head -1 | cut -d: -f1)
    seed_line=$(grep -n "seed_themes" "$ARGV_LOG" | head -1 | cut -d: -f1)
    start_line=$(grep -n "service grappa start" "$ARGV_LOG" | head -1 | cut -d: -f1)
    [ -n "$check_line" ]
    [ -n "$stop_line" ]
    [ -n "$wait_line" ]
    [ -n "$mig_line" ]
    [ -n "$seed_line" ]
    [ -n "$start_line" ]
    # The check is the one migration step that runs with the node UP: its
    # whole point is to refuse while there is still a node serving (F2).
    [ "$check_line" -lt "$stop_line" ]
    # The wait, not just the stop: rc.subr's stop returning is not the BEAM
    # gone, and a migrator next to a live BEAM is the state this removes.
    [ "$stop_line" -lt "$wait_line" ]
    [ "$wait_line" -lt "$mig_line" ]
    [ "$mig_line" -lt "$seed_line" ]
    [ "$seed_line" -lt "$start_line" ]
}

@test "issue 1112: a migration check that refuses stops NOTHING — exit 1, the node keeps serving" {
    # vjt's ruling (F2 (a)): since the migration runs with the node stopped,
    # a migration that fails is an outage. The duplicate-version audit runs
    # first, through the migrator's own door, and a refusal there must leave
    # the old node exactly as it was.
    export PREFLIGHT_RC=3 CHECK_RC=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 1 ]
    grep -q "Grappa.Release.check_migrations()" "$ARGV_LOG"
    refute grep -q "service grappa stop" "$ARGV_LOG"
    refute grep -q "jail_install_rcd.sh" "$ARGV_LOG"
    refute grep -q "Grappa.Release.migrate()" "$ARGV_LOG"
    refute grep -q "seed_themes" "$ARGV_LOG"
    refute grep -q "service grappa start" "$ARGV_LOG"
    [ ! -f "$REPO_ROOT/runtime/last-deployed-sha" ]
    [[ "$output" == *"NOTHING was stopped"* ]]
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

# --- #440: versioned built-in data is seeded on EVERY deploy ------------------
#
# The seed set is versioned CODE materialised into the DB, seeded once at
# install — so a built-in added later reached new installs only. Adding one
# touches a plain lib module, which Preflight classifies HOT, so a cold-only
# seed would miss the path that actually ships themes.

@test "#440 hot: the built-in gallery is seeded, AFTER the reload" {
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "jail_release.sh eval Grappa.Release.seed_themes()" "$ARGV_LOG"

    seed_line=$(grep -n "seed_themes" "$ARGV_LOG" | head -1 | cut -d: -f1)
    reload_line=$(grep -n "curl .*-X POST.*reload" "$ARGV_LOG" | head -1 | cut -d: -f1)
    # One guard per line: bash exempts every element of an `A && B` list
    # from errexit except the last.
    [ -n "$seed_line" ]
    [ -n "$reload_line" ]
    # Schema before data, exactly as on the cold path: since #41
    # /admin/reload applies pending expand migrations on the live pool
    # and only then loads modules, so the hot path is not migration-free.
    [ "$seed_line" -gt "$reload_line" ]
}

@test "#440 cold: the seed runs AFTER the migration and BEFORE the start" {
    export PREFLIGHT_RC=3
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]

    mig_line=$(grep -n "Grappa.Release.migrate()" "$ARGV_LOG" | head -1 | cut -d: -f1)
    seed_line=$(grep -n "seed_themes" "$ARGV_LOG" | head -1 | cut -d: -f1)
    start_line=$(grep -n "service grappa start" "$ARGV_LOG" | head -1 | cut -d: -f1)
    [ -n "$mig_line" ]
    [ -n "$seed_line" ]
    [ -n "$start_line" ]
    # Schema first: a built-in needing a column added in the same deploy
    # would crash a seed that ran ahead of the migrator.
    [ "$mig_line" -lt "$seed_line" ]
    [ "$seed_line" -lt "$start_line" ]
}

@test "#440: --defer-restart still stages a MIGRATED, SEEDED database, and starts nothing" {
    # The staged path exits before start/healthcheck/marker, and the host's
    # `bastille restart` boots whatever is on disk. If the migration or the
    # seed sat after the start hook they would never run on a deferred
    # deploy, and the one-bounce window would boot new code on the old schema
    # (or a stale gallery) with nothing left to fix it. Since issue 1112 both
    # run with the node stopped, so the stop comes first even here.
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-cold --defer-restart
    [ "$status" -eq 0 ]
    refute grep -q "service grappa start" "$ARGV_LOG"

    stop_line=$(grep -n "service grappa stop" "$ARGV_LOG" | head -1 | cut -d: -f1)
    mig_line=$(grep -n "Grappa.Release.migrate()" "$ARGV_LOG" | head -1 | cut -d: -f1)
    seed_line=$(grep -n "seed_themes" "$ARGV_LOG" | head -1 | cut -d: -f1)
    [ -n "$stop_line" ]
    [ -n "$mig_line" ]
    [ -n "$seed_line" ]
    [ "$stop_line" -lt "$mig_line" ]
    [ "$mig_line" -lt "$seed_line" ]
}

@test "#440: a failing seed warns loudly, names the gallery, and does NOT fail the deploy" {
    export SEED_RC=1
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    # Cosmetic data must never abort a deploy — on the cold path an abort
    # here leaves a migrated DB, the old daemon up, and no restart.
    [ "$status" -eq 0 ]
    grep -q "curl .*-X POST.*reload" "$ARGV_LOG"
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]

    [[ "$output" == *"theme gallery"* ]]
    [[ "$output" == *"seed_themes"* ]]
}

@test "#440: the seed warning is re-asserted AFTER the completion banner" {
    export SEED_RC=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]

    banner_line=$(grep -n "deploy complete" <<<"$output" | head -1 | cut -d: -f1)
    warn_line=$(grep -n "theme gallery" <<<"$output" | tail -1 | cut -d: -f1)
    [ -n "$banner_line" ]
    [ -n "$warn_line" ]
    [ "$warn_line" -gt "$banner_line" ]
}

@test "#440: a healthy deploy says nothing about a failed seed" {
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "seed_themes" "$ARGV_LOG"
    # BOTH branches, because they print different sentences: the inline
    # warn ("NOT materialised") and the post-banner re-assert
    # ("reminder:"). Refuting only the first leaves an always-firing
    # re-assert undetectable — measured, this test survived that exact
    # mutation until the second refute was added.
    refute grep -q "NOT materialised" <<<"$output"
    refute grep -q "reminder:" <<<"$output"
}

# --- #1656: a failed healthcheck must not hide a dead node -------------------
#
# The 2026-08-21 v1.3.0 cold deploy exhausted the healthcheck budget and exited
# saying "healthcheck never returned 200". The fact on the ground was that the
# BEAM was GONE and production was down. Those are different emergencies and
# the script rendered them identical.
#
# The probes also HAD the diagnosis and threw it away: `/healthz` answers 503
# with a body naming the failing check (ready/repo/ets), and `curl -f` discards
# a non-2xx body.

@test "#1656: a failed healthcheck reports the last /healthz answer" {
    export HEALTHZ_STATUS=503
    export HEALTHZ_BODY='{"status":"fail","checks":[{"name":"repo","reason":"Repo.query failed: database is locked"}]}'
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-cold
    [ "$status" -eq 1 ]
    [[ "$output" == *"never returned 200"* ]]
    [[ "$output" == *"database is locked"* ]]
}

@test "#1656: healthcheck red + daemon alive reports the daemon is still RUNNING" {
    export HEALTHZ_STATUS=503 SERVICE_STATUS_RC=0
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-cold
    [ "$status" -eq 1 ]
    [[ "$output" == *"still RUNNING"* ]]
    refute grep -q "PRODUCTION IS DOWN" <<<"$output"
}

@test "#1656: healthcheck red + daemon gone shouts that production is DOWN" {
    export HEALTHZ_STATUS=503 SERVICE_STATUS_RC=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-cold
    [ "$status" -eq 1 ]
    [[ "$output" == *"PRODUCTION IS DOWN"* ]]
    refute grep -q "still RUNNING" <<<"$output"
}

@test "#1656: the failure arm asks the service manager, it does not infer" {
    export HEALTHZ_STATUS=503 SERVICE_STATUS_RC=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-cold
    [ "$status" -eq 1 ]
    grep -q "service grappa status" "$ARGV_LOG"
}

@test "#1656: a dead daemon is NOT restarted by the deploy — that is a decision" {
    export HEALTHZ_STATUS=503 SERVICE_STATUS_RC=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-cold
    [ "$status" -eq 1 ]
    # Exactly one `service grappa start`: the cold path's own. A second one
    # would mean the failure arm took the operator's decision for them.
    [ "$(grep -c 'service grappa start' "$ARGV_LOG")" -eq 1 ]
}

@test "#1656: the HOT path inherits the same liveness report" {
    # The loop is shared. If the report lived in the cold hook instead of the
    # loop, a hot deploy would keep telling the old half-truth.
    export HEALTHZ_STATUS=503 SERVICE_STATUS_RC=1
    export PREFLIGHT_RC=0
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-hot
    [ "$status" -eq 1 ]
    [[ "$output" == *"PRODUCTION IS DOWN"* ]]
}

@test "#1656: a healthy deploy says nothing about liveness" {
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-cold
    [ "$status" -eq 0 ]
    refute grep -q "PRODUCTION IS DOWN" <<<"$output"
    refute grep -q "still RUNNING" <<<"$output"
}

# --- #1851: the deploy must leave the checkout it just built CLEAN ----------
#
# `Grappa.Version.GitProbe` snapshots `git status --porcelain` at compile
# time, so anything the deploy machinery leaves behind in the working tree
# turns every release into the unreleased form `X.Y.Z-<sha>` (#391). `git
# pull --ff-only` advances the superproject and leaves every submodule
# working tree where it was, so ONE gitlink bump dirties the checkout
# permanently — measured on the prod jail across three releases.
#
# These two cases are a pair and must be read as one: the first says the
# cure cleans the tree, the second says it did NOT do so by blinding the
# probe. A green on the first alone is indistinguishable from a cure that
# silenced `git status` altogether, which would destroy the very signal
# #391 exists for.

# Give $UPSTREAM a submodule and $REPO_ROOT an in-sync populated copy, then
# echo the submodule commit the next bump moves to. Callers must have
# exported the file-transport allowance first (see the cases).
seed_submodule() {
    local suborigin="$BATS_TEST_TMPDIR/subupstream" first
    git init -q -b main "$suborigin"
    git -C "$suborigin" config user.email test@grappa.local
    git -C "$suborigin" config user.name "bats"
    echo one > "$suborigin/f"
    git -C "$suborigin" add -A
    git -C "$suborigin" commit -qm one
    first="$(git -C "$suborigin" rev-parse HEAD)"
    echo two > "$suborigin/f"
    git -C "$suborigin" add -A
    git -C "$suborigin" commit -qm two

    git -C "$UPSTREAM" submodule add -q "$suborigin" sub
    git -C "$UPSTREAM/sub" checkout -q "$first"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "add sub pinned at its first commit"

    git -C "$REPO_ROOT" pull -q --ff-only
    git -C "$REPO_ROOT" submodule update -q --init

    git -C "$suborigin" rev-parse HEAD
}

# Move the upstream's gitlink to $1 — the gesture that dirties every
# already-deployed checkout.
bump_submodule() {
    git -C "$UPSTREAM/sub" fetch -q origin
    git -C "$UPSTREAM/sub" checkout -q "$1"
    git -C "$UPSTREAM" add sub
    git -C "$UPSTREAM" commit -qm "bump the submodule gitlink"
}

# The deploy writes runtime/last-deployed-sha INTO the checkout, so it is a
# THIRD would-be source of permanent dirt — already cured, by the repo's own
# `/runtime/*` ignore rule. The throwaway upstream carries no .gitignore at
# all, so without this it reports `?? runtime/last-deployed-sha` and the
# fixture lies about the shape of the thing under test. Mirroring the real
# rule is fixture FIDELITY, not a way to make the assertion pass: the general
# lesson is that any new deploy-written path must be checked against
# .gitignore or it poisons the version string the same way (#1851).
mirror_runtime_ignore() {
    printf '/runtime/*\n!/runtime/.gitkeep\n' > "$UPSTREAM/.gitignore"
    git -C "$UPSTREAM" add .gitignore
    git -C "$UPSTREAM" commit -qm "ignore the deploy marker, as the real repo does"
}

# The submodule remote is a filesystem path, which the CVE-2022-39253
# mitigation blocks by default. Exported (not a per-repo config) so it
# reaches the git the deploy runs through the `su` stub as well.
allow_file_transport() {
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0=protocol.file.allow
    export GIT_CONFIG_VALUE_0=always
}

@test "#1851: a deploy pull across a submodule gitlink bump leaves the checkout CLEAN" {
    allow_file_transport
    mirror_runtime_ignore
    target="$(seed_submodule)"
    # Assert the PRE-state: the tree is clean before the gesture, so a green
    # below cannot be a tree that was never dirty in the first place.
    [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]
    bump_submodule "$target"

    run_deploy --force-cold
    [ "$status" -eq 0 ]
    # THE assertion — this is exactly what GitProbe snapshots at compile
    # time, so an empty answer here is a bare `X.Y.Z` on the next release.
    # Printed on failure: "the tree is dirty" is useless without the entry,
    # which is the whole lesson of the issue this case comes from.
    porcelain="$(git -C "$REPO_ROOT" status --porcelain)"
    [ -z "$porcelain" ] || {
        printf 'checkout STILL dirty after the deploy:\n%s\n' "$porcelain" >&2
        false
    }
}

@test "#1851: the cure cleans the tree without blinding it — real dirt still shows" {
    allow_file_transport
    mirror_runtime_ignore
    target="$(seed_submodule)"
    bump_submodule "$target"
    # A stray untracked file is the OTHER half of the prod symptom (the cic
    # build's package-lock.json), and it is genuine dirt: the probe must go
    # on reporting it, or the #391 suffix has been cured to death.
    : > "$REPO_ROOT/an-operators-stray-file.json"

    run_deploy --force-cold
    [ "$status" -eq 0 ]
    [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]
    [[ "$(git -C "$REPO_ROOT" status --porcelain)" == *"an-operators-stray-file.json"* ]]
    # ...and the submodule is NOT what is dirtying it any more.
    refute grep -q ' M sub' <<<"$(git -C "$REPO_ROOT" status --porcelain)"
}

@test "#1656: a consumer with no liveness hook reports UNKNOWN, never DOWN" {
    # infra/docker/get.sh mirrors the lib and the consumer as separate files,
    # so new-lib/old-consumer is reachable on an operator's box. An undefined
    # function returns 127, and reading that as "dead" would fire the loudest
    # alarm we own on no evidence at all.
    run bash -c '
        set -eu
        . "'"$BATS_TEST_DIRNAME"'/../../infra/lib/deploy_common.sh"
        _deploy_report_liveness
    '
    [ "$status" -eq 0 ]
    [[ "$output" == *"UNKNOWN"* ]]
    refute grep -q "PRODUCTION IS DOWN" <<<"$output"
    refute grep -q "still RUNNING" <<<"$output"
}
