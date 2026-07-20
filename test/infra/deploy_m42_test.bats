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

setup() {
    DEPLOY_M42="$BATS_TEST_DIRNAME/../../scripts/deploy-m42.sh"

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
    *curl*healthz*) exit "${HEALTH_RC:-0}" ;;
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
    grep -q "bastille restart grappa" "$SSH_LOG"
    grep -q "curl -fsS -o /dev/null http://127.0.0.1:4000/healthz" "$SSH_LOG"
    grep -q "last-deployed-sha" "$SSH_LOG"

    stage_line=$(grep -n "force-cold --defer-restart" "$SSH_LOG" | head -1 | cut -d: -f1)
    restart_line=$(grep -n "bastille restart grappa" "$SSH_LOG" | head -1 | cut -d: -f1)
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
    grep -q "bastille restart grappa" "$SSH_LOG"
    grep -q "healthz" "$SSH_LOG"
    ! grep -q "last-deployed-sha" "$SSH_LOG"
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

# --- passthrough modes: app deploy + nginx self-heal, no bounce, no marker ---

@test "--force-cold: app deploy + nginx refresh, no bounce, no marker" {
    run_m42 --force-cold
    [ "$status" -eq 0 ]
    grep -q "deploy.sh --force-cold" "$SSH_LOG"
    # #74355599 — refresh_nginx runs on EVERY path (self-heals the jail
    # /admin/* allowlist), so a passthrough deploy is now TWO ssh calls:
    # the app deploy + the nginx reinstall. What still distinguishes
    # --force-cold from --full-restart is the ABSENCE of a bastille bounce
    # and a marker write.
    grep -q "jail_install_nginx.sh" "$SSH_LOG"
    ! grep -q "bastille restart" "$SSH_LOG"
    ! grep -q "last-deployed-sha" "$SSH_LOG"
    [ "$(grep -c '^ssh ' "$SSH_LOG")" -eq 2 ]   # app deploy + nginx refresh
}

@test "unknown flag is a usage error (64)" {
    run_m42 --bogus
    [ "$status" -eq 64 ]
}
