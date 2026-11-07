#!/usr/bin/env bats
#
# Characterization suite for infra/linux/deploy.sh — the native-systemd
# deploy orchestrator's DECISION logic, LOCKED before the #503 extraction
# of the shared deploy lib (infra/lib/deploy_common.sh). These tests
# capture the CURRENT behavior that the extraction must preserve:
# preflight range base (marker vs pre-pull HEAD), the marker-shape guard,
# the re-exec guard's range, the hot reload-honesty check, and the cold
# path's step ordering.
#
# Scope: pure shell-side logic, mirroring test/infra/deploy_jail_test.bats.
# The script runs against a throwaway git clone (REPO_ROOT) pulled from a
# throwaway upstream, with `sudo`, `mix`, `curl`, `systemctl` stubbed via
# PATH and the cic_build.sh / install_systemd.sh delegates stubbed as
# committed recorders inside the temp repo. What only a real host deploy
# exercises (systemd Type=exec, the live BEAM) is out of scope.
#
# #503 enrich gains have their own RED-GREEN sections at the bottom:
# --force-* flags, the marker-gated nothing-to-do fast path, and the
# DEPLOY_PREV_SHA carry across re-exec — all now landed, bringing this
# substrate to parity with the jail.

load ../bats_helpers

setup() {
    DEPLOY_SH="$BATS_TEST_DIRNAME/../../infra/linux/deploy.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$BATS_TEST_TMPDIR/argv.log"
    : > "$ARGV_LOG"
    export ARGV_LOG

    # Empty HOME so the deploy body's `export PATH="$HOME/.local/bin:
    # $HOME/.asdf/shims:$PATH"` prepend can't shadow our PATH stubs with a
    # real host toolchain (asdf shims carry a real `mix` on dev machines).
    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"

    # ---- throwaway upstream + clone ------------------------------------
    UPSTREAM="$BATS_TEST_TMPDIR/upstream"
    git init -q -b main "$UPSTREAM"
    git -C "$UPSTREAM" config user.email test@grappa.local
    git -C "$UPSTREAM" config user.name "bats"

    mkdir -p "$UPSTREAM/infra/linux" "$UPSTREAM/infra/lib" "$UPSTREAM/runtime" "$UPSTREAM/lib"
    cp "$DEPLOY_SH" "$UPSTREAM/infra/linux/deploy.sh"
    chmod +x "$UPSTREAM/infra/linux/deploy.sh"
    # The ported consumer sources the shared algorithm lib (#503). It must
    # exist in the throwaway clone for the script to run — committed so
    # pulls stay clean. Assertions below are UNCHANGED by the extraction.
    cp "$BATS_TEST_DIRNAME/../../infra/lib/deploy_common.sh" "$UPSTREAM/infra/lib/deploy_common.sh"
    # Delegates called by absolute SCRIPT_DIR path → committed recorders.
    for stub in cic_build.sh install_systemd.sh; do
        cat > "$UPSTREAM/infra/linux/$stub" <<EOF
#!/bin/sh
printf '%s %s\n' "$stub" "\$*" >> "\$ARGV_LOG"
exit 0
EOF
        chmod +x "$UPSTREAM/infra/linux/$stub"
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
    export GRAPPA_USER=grappa PORT=4000
    export HEALTHCHECK_RETRIES=2 HEALTHCHECK_SLEEP=0
    export PREFLIGHT_RC=0
    export RELOAD_FAILS=0
    export RELOAD_HTTP_FAILS=0
    # #440: SEED_RC injects a failing seed task (a busy DB, a bad payload —
    # all the same shape from out here). Default 0 so every other test's
    # seed succeeds and the warn-path assertions below are the only ones
    # reading the failure branch.
    export SEED_RC=0
    # #541 outcome harness: the preflight oneshot compiles, so on a pull
    # that moved mix.exs/mix.lock it aborts on stale deps UNLESS deps.get
    # ran first. STRICT_PREFLIGHT_DEPS=1 makes the mix stub model that real
    # failure (via a marker deps.get drops); default off keeps every other
    # test's oneshot honoring PREFLIGHT_RC unconditionally.
    export DEPS_MARKER="$BATS_TEST_TMPDIR/deps-synced"

    # ---- PATH stubs ------------------------------------------------------
    # sudo -u grappa -H bash -c '<cmd>' → run <cmd> in-process. Skip the
    # sudo flags (-u USER, -H, -n, …) then exec the trailing `bash -c …`.
    # Real `sudo -u` would drop privileges + env; the deploy body re-exports
    # what it needs and the stubs only read ARGV_LOG/PREFLIGHT_RC (which
    # ride in the ambient env this stub inherits).
    cat > "$FAKE_DIR/sudo" <<'EOF'
#!/bin/sh
while [ $# -gt 0 ]; do
    case "$1" in
        -u) shift 2 ;;
        -H|-E|-n|-i|-s) shift ;;
        --) shift; break ;;
        -*) shift ;;
        *) break ;;
    esac
done
exec "$@"
EOF

    # mix: preflight oneshot honors $PREFLIGHT_RC; build/migrate succeed.
    # deps.get drops a marker; the oneshot models mix's stale-deps abort
    # (exit 1) when STRICT_PREFLIGHT_DEPS=1 and no deps.get preceded it.
    cat > "$FAKE_DIR/mix" <<'EOF'
#!/bin/sh
printf 'mix %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
    "deps.get"*) : > "$DEPS_MARKER" ;;
    "grappa.seed_themes"*) exit "$SEED_RC" ;;
    "grappa.migrate"*) exit "${MIGRATE_RC:-0}" ;;
    "grappa.check_migrations"*) exit "${CHECK_RC:-0}" ;;
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

    # curl: reload POST answers clean (or failing, gated by $RELOAD_FAILS);
    # healthcheck answers 200 (curl -f success).
    #
    # $RELOAD_HTTP_FAILS is a DIFFERENT failure from $RELOAD_FAILS and the
    # distinction is the point: RELOAD_FAILS is a 200 reporting per-module
    # failures IN-BAND, while RELOAD_HTTP_FAILS is a non-2xx, on which
    # `curl -f` exits non-zero and discards the body — the branch where the
    # deploy knows the POST failed and nothing about why, so its printed
    # guess is all the operator gets. Nothing exercised that branch before
    # #1348.
    cat > "$FAKE_DIR/curl" <<'EOF'
#!/bin/sh
printf 'curl %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
    *"-X POST"*reload*)
        if [ "$RELOAD_HTTP_FAILS" = "1" ]; then
            exit 22
        elif [ "$RELOAD_FAILS" = "1" ]; then
            printf '{"loaded":[],"failed":[{"module":"Foo","reason":"old_code_in_use"}]}'
        else
            printf '{"loaded":[],"failed":[]}'
        fi
        ;;
esac
# #1656 — the /healthz probe, modelled as real curl behaves: `-f` discards the
# body and exits non-zero on a non-2xx, the same URL without `-f` exits 0 and
# PRINTS it.
case "$*" in
    *-f*)
        [ "${HEALTHZ_STATUS:-200}" = 200 ] || exit 22
        ;;
    *healthz*)
        printf '%s' "${HEALTHZ_BODY:-}"
        ;;
esac
exit 0
EOF

    cat > "$FAKE_DIR/systemctl" <<'EOF'
#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
    *is-active*) exit "${SYSTEMCTL_ACTIVE_RC:-0}" ;;
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
    run "$REPO_ROOT/infra/linux/deploy.sh" "$@"
}

# --- preflight range base ----------------------------------------------------

@test "no marker: preflight falls back to pre-pull HEAD as range base (substrate linux)" {
    prev="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "cli(\[\"$prev\", \"$new\", \"linux\"\])" "$ARGV_LOG"
}

@test "marker present: preflight base is the marker, not the pre-pull HEAD" {
    marker="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    commit_upstream lib/base.txt > /dev/null
    git -C "$REPO_ROOT" pull -q --ff-only
    prev="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$marker" > "$REPO_ROOT/runtime/last-deployed-sha"
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "cli(\[\"$marker\", \"$new\", \"linux\"\])" "$ARGV_LOG"
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

# --- hot path ----------------------------------------------------------------

@test "hot deploy completes and writes the marker as final step" {
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "curl .*-X POST.*reload" "$ARGV_LOG"
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
    refute grep -q "systemctl" "$ARGV_LOG"   # hot path never restarts
}

@test "a non-2xx reload names BOTH 409 causes, and says which one a cold deploy fixes (#1348)" {
    # `curl -f` threw the body away, so these printed lines are the whole
    # of what the operator learns. Since #1348 a 409 has two causes and
    # they need OPPOSITE moves: a pending CONTRACT migration is what a
    # cold deploy is for, while a duplicated version is a repo defect a
    # cold deploy walks straight back into. Naming only the first sends
    # the operator to restart production for nothing.
    export RELOAD_HTTP_FAILS=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    [[ "$output" == *"CONTRACT"* ]]
    [[ "$output" == *"duplicate"* ]]
    [[ "$output" == *"cold deploy will not"* ]]
    [ ! -f "$REPO_ROOT/runtime/last-deployed-sha" ]
}

@test "hot reload reporting per-module failures aborts non-zero, no marker" {
    export RELOAD_FAILS=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    [[ "$output" == *"failure"* ]] || [[ "$output" == *"failed"* ]]
    [ ! -f "$REPO_ROOT/runtime/last-deployed-sha" ]
}

# --- re-exec guard -----------------------------------------------------------

@test "deploy.sh touched in THIS pull re-execs and still completes" {
    new="$(commit_upstream infra/linux/deploy.sh)"

    run_deploy
    [ "$status" -eq 0 ]
    [[ "$output" == *"re-exec"* ]]
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

# --- cold path ---------------------------------------------------------------

@test "cold path order: cic_build -> check -> install_systemd -> stop -> migrate -> seed -> start, writes marker" {
    # Issue 1112 (D4): the migration runs with the old node STOPPED. It used
    # to run first, so for the seconds before the stop the old code served
    # the new schema — an order nobody chose (vjt's ruling, F1/F3 (a)).
    export PREFLIGHT_RC=3
    new="$(commit_upstream lib/base.txt)"

    run_deploy
    [ "$status" -eq 0 ]

    cic_line=$(grep -n "cic_build.sh" "$ARGV_LOG" | head -1 | cut -d: -f1)
    check_line=$(grep -n "mix grappa.check_migrations" "$ARGV_LOG" | head -1 | cut -d: -f1)
    unit_line=$(grep -n "install_systemd.sh" "$ARGV_LOG" | head -1 | cut -d: -f1)
    stop_line=$(grep -n "systemctl stop grappa" "$ARGV_LOG" | head -1 | cut -d: -f1)
    mig_line=$(grep -n "mix grappa.migrate" "$ARGV_LOG" | head -1 | cut -d: -f1)
    seed_line=$(grep -n "mix grappa.seed_themes" "$ARGV_LOG" | head -1 | cut -d: -f1)
    start_line=$(grep -n "systemctl start grappa" "$ARGV_LOG" | head -1 | cut -d: -f1)
    [ -n "$cic_line" ]
    [ -n "$check_line" ]
    [ -n "$unit_line" ]
    [ -n "$stop_line" ]
    [ -n "$mig_line" ]
    [ -n "$seed_line" ]
    [ -n "$start_line" ]
    # The migration check (F2) runs while the old node still serves.
    [ "$cic_line" -lt "$check_line" ]
    [ "$check_line" -lt "$unit_line" ]
    [ "$unit_line" -lt "$stop_line" ]
    [ "$stop_line" -lt "$mig_line" ]
    [ "$mig_line" -lt "$seed_line" ]
    [ "$seed_line" -lt "$start_line" ]

    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

@test "issue 1112: a migration that fails AFTER the stop says production is DOWN, and starts nothing" {
    # The price of stopping first: a migration that fails used to leave the
    # old node serving, and now leaves no node at all. "The deploy failed"
    # and "production is down" are different emergencies (#1656), so this
    # one must be named, not inferred from a non-zero exit.
    export PREFLIGHT_RC=3 MIGRATE_RC=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    grep -q "systemctl stop grappa" "$ARGV_LOG"
    grep -q "mix grappa.migrate" "$ARGV_LOG"
    refute grep -q "systemctl start grappa" "$ARGV_LOG"
    refute grep -q "mix grappa.seed_themes" "$ARGV_LOG"
    [ ! -f "$REPO_ROOT/runtime/last-deployed-sha" ]
    [[ "$output" == *"PRODUCTION IS DOWN"* ]]
}

@test "issue 1112: a migration check that refuses stops NOTHING — exit 1, the node keeps serving" {
    export PREFLIGHT_RC=3 CHECK_RC=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 1 ]
    grep -q "mix grappa.check_migrations" "$ARGV_LOG"
    refute grep -q "install_systemd.sh" "$ARGV_LOG"
    refute grep -q "systemctl stop grappa" "$ARGV_LOG"
    refute grep -q "mix grappa.migrate" "$ARGV_LOG"
    refute grep -q "systemctl start grappa" "$ARGV_LOG"
    [ ! -f "$REPO_ROOT/runtime/last-deployed-sha" ]
    [[ "$output" == *"NOTHING was stopped"* ]]
}

# --- #503 enrich: --force-* flags (parity with jail + docker) ----------------

@test "--force-hot skips preflight and hot-reloads (no systemctl)" {
    export PREFLIGHT_RC=3   # would be COLD if preflight ran; --force-hot overrides
    new="$(commit_upstream lib/base.txt)"

    run_deploy --force-hot
    [ "$status" -eq 0 ]
    refute grep -q "run --no-start" "$ARGV_LOG"          # forced mode skips preflight
    grep -q "curl .*-X POST.*reload" "$ARGV_LOG"
    refute grep -q "systemctl" "$ARGV_LOG"               # hot path never restarts
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

@test "--force-cold skips preflight and cold-deploys" {
    export PREFLIGHT_RC=0   # would be HOT if preflight ran; --force-cold overrides
    new="$(commit_upstream lib/base.txt)"

    run_deploy --force-cold
    [ "$status" -eq 0 ]
    refute grep -q "run --no-start" "$ARGV_LOG"
    grep -q "systemctl stop grappa" "$ARGV_LOG"
    grep -q "systemctl start grappa" "$ARGV_LOG"
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

@test "unknown flag is a usage error (64)" {
    run_deploy --bogus
    [ "$status" -eq 64 ]
}

# --- #503 enrich: marker-gated nothing-to-do (defect #8 parity) ---------------

@test "auto + same HEAD + marker match exits 0 without building" {
    head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$head" > "$REPO_ROOT/runtime/last-deployed-sha"

    run_deploy
    [ "$status" -eq 0 ]
    [[ "$output" == *"nothing to do"* ]]
    refute grep -q "mix deps.get" "$ARGV_LOG"       # build never runs
    refute grep -q "systemctl" "$ARGV_LOG"
    refute grep -q "run --no-start" "$ARGV_LOG"      # never reaches preflight
}

@test "--force-cold overrides the nothing-to-do fast path" {
    head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '%s\n' "$head" > "$REPO_ROOT/runtime/last-deployed-sha"

    run_deploy --force-cold
    [ "$status" -eq 0 ]
    # The nothing-to-do OVERRIDE line (not just any "force" — the
    # skip-preflight log also says force); proves the fast path saw the
    # match but honored the operator order.
    [[ "$output" == *"marker match"* ]]
    [[ "$output" == *"overrides"* ]]
    grep -q "systemctl stop grappa" "$ARGV_LOG"
    refute grep -q "run --no-start" "$ARGV_LOG"      # forced mode skips preflight
}

# --- #503 enrich: DEPLOY_PREV_SHA carry across re-exec ------------------------

@test "re-exec carries the pre-pull HEAD as preflight base (no marker)" {
    prev="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    new="$(commit_upstream infra/linux/deploy.sh)"   # deploy.sh change → re-exec

    run_deploy
    [ "$status" -eq 0 ]
    [[ "$output" == *"re-exec"* ]]
    # After re-exec the re-pulled run's own pre-pull HEAD == new (the pull
    # is a no-op the second time). Without the carry the range collapses to
    # new..new and the real change silently drops out; the carry keeps the
    # ORIGINAL pre-pull HEAD as the base.
    grep -q "cli(\[\"$prev\", \"$new\", \"linux\"\])" "$ARGV_LOG"
    refute grep -q "cli(\[\"$new\", \"$new\"" "$ARGV_LOG"
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
    grep -q "cli(\[.*\"linux\"\])" "$ARGV_LOG"                 # preflight reached a verdict
    [ "$(cat "$REPO_ROOT/runtime/last-deployed-sha")" = "$new" ]
}

# --- #440: versioned built-in data is seeded on EVERY deploy ------------------
#
# The seed set is versioned CODE materialised into the DB, but seeding only
# ever happened at install — so a built-in added later reached new installs
# only. Adding one touches a plain lib module, which Preflight classifies
# HOT, so a cold-only seed would miss the common case: both paths, or the
# bug is still open on the path that actually ships themes.

@test "#440 hot: the built-in gallery is seeded, AFTER the reload" {
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "mix grappa.seed_themes" "$ARGV_LOG"

    seed_line=$(grep -n "mix grappa.seed_themes" "$ARGV_LOG" | head -1 | cut -d: -f1)
    reload_line=$(grep -n "curl .*-X POST.*reload" "$ARGV_LOG" | head -1 | cut -d: -f1)
    # One guard per line: bash exempts every element of an `A && B` list
    # from errexit except the last, so a chained guard is the same
    # can't-fail assertion the `refute` helper exists to kill.
    [ -n "$seed_line" ]
    [ -n "$reload_line" ]
    # Schema before data, exactly as on the cold path: since #41 the hot
    # path is NOT migration-free — /admin/reload applies pending expand
    # migrations on the live pool and only then loads modules. Seeding
    # ahead of it would hit the pre-migration schema.
    [ "$seed_line" -gt "$reload_line" ]
}

@test "#440 hot: a REFUSED reload seeds nothing" {
    # A reload reporting per-module failures aborts the deploy. Seeding
    # into a deploy that did not take is work at best, misleading at
    # worst — and on a contract-migration refusal the schema the seed
    # would need never arrived.
    export RELOAD_FAILS=1
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -ne 0 ]
    refute grep -q "mix grappa.seed_themes" "$ARGV_LOG"
}

@test "#440 cold: the seed runs AFTER the migration and BEFORE the start" {
    export PREFLIGHT_RC=3
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]

    mig_line=$(grep -n "mix grappa.migrate" "$ARGV_LOG" | head -1 | cut -d: -f1)
    seed_line=$(grep -n "mix grappa.seed_themes" "$ARGV_LOG" | head -1 | cut -d: -f1)
    start_line=$(grep -n "systemctl start grappa" "$ARGV_LOG" | head -1 | cut -d: -f1)
    [ -n "$mig_line" ]
    [ -n "$seed_line" ]
    [ -n "$start_line" ]
    # Schema first: a built-in whose payload needs a column added in the
    # same deploy would crash a seed that ran before the migrator.
    [ "$mig_line" -lt "$seed_line" ]
    # Before the start, so the new code boots on a seeded DB — the shared
    # lib keeps that order for the substrate that stages (the jail's
    # --defer-restart), and this one rides on the same lib.
    [ "$seed_line" -lt "$start_line" ]
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

    # Loud, and it says WHAT was not seeded — not a bare "seed failed".
    [[ "$output" == *"theme gallery"* ]]
    # ...and how to fix it by hand.
    [[ "$output" == *"grappa.seed_themes"* ]]
}

@test "#440: the seed warning is re-asserted AFTER the completion banner" {
    # A warn 200 lines up a build log is a warn nobody reads. The last
    # thing on the operator's screen must not be an unqualified ✓.
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
    # The re-assert must be gated on the OUTCOME, not printed every run —
    # a warning that always fires is a warning that means nothing.
    commit_upstream lib/base.txt > /dev/null

    run_deploy
    [ "$status" -eq 0 ]
    grep -q "mix grappa.seed_themes" "$ARGV_LOG"
    # BOTH branches, because they print different sentences: the inline
    # warn ("NOT materialised") and the post-banner re-assert
    # ("reminder:"). Refuting only the first leaves an always-firing
    # re-assert undetectable — measured, this test survived that exact
    # mutation until the second refute was added.
    refute grep -q "NOT materialised" <<<"$output"
    refute grep -q "reminder:" <<<"$output"
}

# --- #1656: the failed-healthcheck arm is the shared lib's, so systemd
# inherits it — but only if this substrate actually wires the hook.

@test "#1656: healthcheck red + unit dead shouts PRODUCTION IS DOWN and names the restart" {
    export HEALTHZ_STATUS=503 SYSTEMCTL_ACTIVE_RC=3
    export HEALTHZ_BODY='{"status":"fail","checks":[{"name":"repo","reason":"Repo.query failed"}]}'
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-cold
    [ "$status" -eq 1 ]
    [[ "$output" == *"Repo.query failed"* ]]
    [[ "$output" == *"PRODUCTION IS DOWN"* ]]
    [[ "$output" == *"systemctl start grappa"* ]]
    grep -q "systemctl is-active" "$ARGV_LOG"
}

@test "#1656: healthcheck red + unit active reports the daemon is still RUNNING" {
    export HEALTHZ_STATUS=503 SYSTEMCTL_ACTIVE_RC=0
    commit_upstream lib/base.txt > /dev/null

    run_deploy --force-cold
    [ "$status" -eq 1 ]
    [[ "$output" == *"still RUNNING"* ]]
    refute grep -q "PRODUCTION IS DOWN" <<<"$output"
}
