#!/usr/bin/env bats
#
# Bats suite for scripts/deploy-m42.sh — the HOST-side ssh wrapper.
#
# Focus: the --full-restart sequencing — stage (deploy.sh --force-cold
# --defer-restart) → bastille restart → healthcheck → marker write — plus
# the invariant that the existing single-ssh modes (--cic / --force-* /
# auto) are unchanged.
#
# ssh + git are stubbed via PATH. ssh records its full remote command to
# $SSH_LOG and exits per $HEALTH_RC for the healthcheck call (curl …/healthz),
# so the healthcheck-fails branch is drivable. git is stubbed just enough to
# satisfy the push-guard (rev-parse main == origin/main → not-ahead → pass).
#
# Scope: pure host-side sequencing. The real jail bounce (bastille, rc.d,
# the live BEAM) is out of scope — bats proves the ssh call sequence only.

load ../bats_helpers

setup() {
    DEPLOY_M42="$BATS_TEST_DIRNAME/../../scripts/deploy-m42.sh"

    # The jail these cases expect to be addressed comes from the same place
    # the script reads it (#2022) — asserting a literal here would let the
    # test and the default drift apart, which is the bug it now covers.
    # shellcheck source=infra/lib/bastille_jail.sh
    . "$BATS_TEST_DIRNAME/../../infra/lib/bastille_jail.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    SSH_LOG="$BATS_TEST_TMPDIR/ssh.log"
    : > "$SSH_LOG"
    export SSH_LOG

    # ssh stub: record the full remote command; the healthcheck call
    # (curl …/healthz) honours $HEALTH_RC so the failure branch is drivable.
    cat > "$FAKE_DIR/ssh" <<'EOF'
#!/bin/sh
printf 'ssh %s\n' "$*" >> "$SSH_LOG"
case "$*" in
    # #1656 — `-fsS` is the PROBE (body discarded, non-zero on non-2xx); the
    # same URL without it is the diagnostic re-ask that PRINTS the body.
    *"curl -fsS"*healthz*) exit "${HEALTH_RC:-0}" ;;
    *curl*healthz*)        printf '%s' "${HEALTHZ_BODY:-}"; exit 0 ;;
    *"service grappa status"*) exit "${SERVICE_STATUS_RC:-0}" ;;
    *) exit 0 ;;
esac
EOF

    # git stub: satisfy the push-guard. rev-parse main == origin/main
    # (equal shas → local not ahead → guard passes); fetch is a no-op.
    cat > "$FAKE_DIR/git" <<'EOF'
#!/bin/sh
case "$*" in
    "rev-parse --git-dir")   echo .git ;;
    "rev-parse main")        echo 1111111111111111111111111111111111111111 ;;
    "rev-parse origin/main") echo 1111111111111111111111111111111111111111 ;;
    *) ;;
esac
exit 0
EOF

    chmod +x "$FAKE_DIR"/*
    export PATH="$FAKE_DIR:$PATH"

    # Fast, deterministic healthcheck loop (production defaults are 30×2s).
    export FULL_RESTART_HC_RETRIES=2 FULL_RESTART_HC_SLEEP=0
}

run_m42() {
    run "$DEPLOY_M42" "$@"
}

# --- --full-restart: stage → bounce → verify → marker ------------------------

@test "--full-restart: ssh sequence is stage → bastille restart → healthcheck → marker" {
    run_m42 --full-restart
    [ "$status" -eq 0 ]

    grep -q "deploy.sh --force-cold --defer-restart" "$SSH_LOG"
    grep -q "bastille restart ${BASTILLE_JAIL}" "$SSH_LOG"
    grep -q "curl -fsS -o /dev/null http://127.0.0.1:4000/healthz" "$SSH_LOG"
    grep -q "last-deployed-sha" "$SSH_LOG"

    stage_line=$(grep -n "force-cold --defer-restart" "$SSH_LOG" | head -1 | cut -d: -f1)
    restart_line=$(grep -n "bastille restart ${BASTILLE_JAIL}" "$SSH_LOG" | head -1 | cut -d: -f1)
    health_line=$(grep -n "healthz" "$SSH_LOG" | head -1 | cut -d: -f1)
    marker_line=$(grep -n "last-deployed-sha" "$SSH_LOG" | head -1 | cut -d: -f1)
    [ "$stage_line" -lt "$restart_line" ]
    [ "$restart_line" -lt "$health_line" ]
    [ "$health_line" -lt "$marker_line" ]
}

@test "--full-restart healthcheck failure: no marker write, non-zero exit" {
    export HEALTH_RC=1
    run_m42 --full-restart
    [ "$status" -ne 0 ]
    grep -q "deploy.sh --force-cold --defer-restart" "$SSH_LOG"
    grep -q "bastille restart ${BASTILLE_JAIL}" "$SSH_LOG"
    grep -q "healthz" "$SSH_LOG"
    refute grep -q "last-deployed-sha" "$SSH_LOG"
}

@test "--full-restart still refuses when local main is ahead of origin (push-guard)" {
    # git stub: local main != origin/main AND origin is an ancestor of local
    # → local is AHEAD → push-guard must die before any ssh.
    cat > "$FAKE_DIR/git" <<'EOF'
#!/bin/sh
case "$*" in
    "rev-parse --git-dir")        echo .git ;;
    "rev-parse main")             echo 2222222222222222222222222222222222222222 ;;
    "rev-parse origin/main")      echo 1111111111111111111111111111111111111111 ;;
    "merge-base --is-ancestor"*)  exit 0 ;;   # origin IS an ancestor of local
    *) ;;
esac
exit 0
EOF
    chmod +x "$FAKE_DIR/git"

    run_m42 --full-restart
    [ "$status" -ne 0 ]
    [[ "$output" == *"push"* ]]
    [ ! -s "$SSH_LOG" ]   # died before any ssh
}

# --- passthrough modes: app deploy only, no bounce, no marker ----------------

@test "--force-cold: app deploy only, no bounce, no marker" {
    run_m42 --force-cold
    [ "$status" -eq 0 ]
    grep -q "deploy.sh --force-cold" "$SSH_LOG"
    refute grep -q "bastille restart" "$SSH_LOG"
    refute grep -q "last-deployed-sha" "$SSH_LOG"
    [ "$(grep -c '^ssh ' "$SSH_LOG")" -eq 1 ]   # app deploy, nothing else
}

# --- the jail runs no nginx: no path may ssh an nginx step -------------------
#
# There used to be a refresh_nginx step on EVERY path (reinstall the jail's
# dumb-proxy config + reload). The jail nginx is gone — the m42 HOST vhost
# proxies straight to the jail BEAM on :4000 — so an nginx ssh call on ANY
# mode would be pushing a config at a service that is not there. Pin the
# absence per-mode rather than once: it is the whole point of the removal,
# and it is exactly the kind of step that gets copy-pasted back into one
# branch of the case statement.

@test "no mode ssh's an nginx step (the jail has no nginx to reload)" {
    for mode in "" --force-hot --force-cold --cic --full-restart; do
        : > "$SSH_LOG"
        # shellcheck disable=SC2086  # empty mode must expand to NO argument
        run_m42 $mode
        [ "$status" -eq 0 ]
        [ -s "$SSH_LOG" ]                       # it really did deploy something
        refute grep -qi "nginx" "$SSH_LOG"
    done
}

@test "unknown flag is a usage error (64)" {
    run_m42 --bogus
    [ "$status" -eq 64 ]
}

# --- #1656: the host-side --full-restart loop told the same half-truth -------

@test "#1656 --full-restart: a failed healthcheck reports what /healthz said" {
    export HEALTH_RC=1
    export HEALTHZ_BODY='{"status":"fail","checks":[{"name":"ready","reason":"supervision tree boot not complete"}]}'
    run_m42 --full-restart
    [ "$status" -ne 0 ]
    [[ "$output" == *"supervision tree boot not complete"* ]]
}

@test "#1656 --full-restart: healthcheck red + daemon gone shouts PRODUCTION IS DOWN" {
    export HEALTH_RC=1 SERVICE_STATUS_RC=1
    run_m42 --full-restart
    [ "$status" -ne 0 ]
    grep -q "service grappa status" "$SSH_LOG"
    [[ "$output" == *"PRODUCTION IS DOWN"* ]]
    refute grep -q "last-deployed-sha" "$SSH_LOG"
}

@test "#1656 --full-restart: healthcheck red + daemon alive says it is still RUNNING" {
    export HEALTH_RC=1 SERVICE_STATUS_RC=0
    run_m42 --full-restart
    [ "$status" -ne 0 ]
    [[ "$output" == *"still RUNNING"* ]]
    refute grep -q "PRODUCTION IS DOWN" <<<"$output"
}

# --- #2022: the default addresses a jail that EXISTS -------------------------
#
# `JAIL` defaulted to `grappa`, which was then the jail's host.hostname, not
# its bastille NAME (`grappa-new`, renamed `grappa` by #2481) — so an
# unoverridden run addressed nothing.
# These two pin the default itself and the recovery line, because the second
# is read while production is down and a wrong jail there costs an outage.

@test "#2022 no JAIL override: the ssh addresses the jail by its declared name" {
    run_m42
    [ "$status" -eq 0 ]
    grep -q "bastille cmd ${BASTILLE_JAIL} " "$SSH_LOG"
    # …and says so on stdout, which is what the operator reads back.
    [[ "$output" == *"jail=${BASTILLE_JAIL} "* ]]
}

@test "#2022 the PRODUCTION IS DOWN line names a jail that exists" {
    export HEALTH_RC=1 SERVICE_STATUS_RC=1
    run_m42 --full-restart
    [ "$status" -ne 0 ]
    [[ "$output" == *"PRODUCTION IS DOWN"* ]]
    # The pasteable recovery command, not just the shout.
    [[ "$output" == *"bastille cmd ${BASTILLE_JAIL} service grappa start"* ]]
}

@test "#1656 --full-restart: a dead jail is never restarted for you" {
    export HEALTH_RC=1 SERVICE_STATUS_RC=1
    run_m42 --full-restart
    [ "$status" -ne 0 ]
    refute grep -q "service grappa start" "$SSH_LOG"
    refute grep -q "bastille start" "$SSH_LOG"
}
