#!/usr/bin/env bats
#
# Bats suite for infra/freebsd/jail_beam_wait.sh — the shared BEAM
# stop/start synchronization helper (defect #9). Stubs pgrep/pkill/epmd
# via PATH; BEAM/epmd state lives in $STATE files the fakes read and
# the fake pkill mutates (simulating the kill taking effect).
#
# The load-bearing distinction under test: `wait-stopped` may escalate
# (SIGKILL the BEAM after timeout, restart a stale epmd AFTER the BEAM
# is confirmed dead) while `wait-name-free` must NEVER kill anything —
# pkill'ing epmd while a BEAM is alive makes the BEAM respawn it and
# races the new node's name registration (live-repro 2026-05-31).

setup() {
    BEAM_WAIT="$BATS_TEST_DIRNAME/../../infra/freebsd/jail_beam_wait.sh"

    STATE="$BATS_TEST_TMPDIR/state"
    mkdir -p "$STATE"
    export STATE
    KILL_LOG="$STATE/kill.log"
    : > "$KILL_LOG"
    export KILL_LOG

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"

    # beam.smp is "running" while $STATE/beam exists.
    cat > "$FAKE_DIR/pgrep" <<'EOF'
#!/bin/sh
[ -f "$STATE/beam" ] && exit 0
exit 1
EOF

    # pkill records, then makes the kill take effect on the state files.
    cat > "$FAKE_DIR/pkill" <<'EOF'
#!/bin/sh
printf 'pkill %s\n' "$*" >> "$KILL_LOG"
case "$*" in
    *beam.smp*) rm -f "$STATE/beam" ;;
    *epmd*)     rm -f "$STATE/epmd_names" ;;
esac
exit 0
EOF

    # epmd -names prints the registration table or fails when not running.
    cat > "$FAKE_DIR/epmd" <<'EOF'
#!/bin/sh
if [ -f "$STATE/epmd_names" ]; then
    cat "$STATE/epmd_names"
    exit 0
fi
echo "epmd: Cannot connect to local epmd" >&2
exit 1
EOF

    chmod +x "$FAKE_DIR"/*
    export PATH="$FAKE_DIR:$PATH"
}

beam_running() { touch "$STATE/beam"; }
name_registered() { printf 'name %s at port 39559\n' "$1" > "$STATE/epmd_names"; }

# --- wait-stopped ------------------------------------------------------------

@test "wait-stopped: BEAM gone and name free returns 0 without killing" {
    run "$BEAM_WAIT" wait-stopped grappa 5
    [ "$status" -eq 0 ]
    [ ! -s "$KILL_LOG" ]
}

@test "wait-stopped: BEAM alive past timeout gets SIGKILL, then returns 0" {
    beam_running

    run "$BEAM_WAIT" wait-stopped grappa 1
    [ "$status" -eq 0 ]
    grep -q "pkill -9 beam.smp" "$KILL_LOG"
}

@test "wait-stopped: stale epmd name after BEAM exit gets epmd restarted" {
    name_registered grappa

    run "$BEAM_WAIT" wait-stopped grappa 1
    [ "$status" -eq 0 ]
    grep -q "pkill epmd" "$KILL_LOG"
    ! grep -q "beam.smp" "$KILL_LOG"
}

@test "wait-stopped: other node names do not block" {
    name_registered other_node

    run "$BEAM_WAIT" wait-stopped grappa 1
    [ "$status" -eq 0 ]
    [ ! -s "$KILL_LOG" ]
}

# --- wait-name-free -----------------------------------------------------------

@test "wait-name-free: free name returns 0 immediately" {
    run "$BEAM_WAIT" wait-name-free grappa 5
    [ "$status" -eq 0 ]
    [ ! -s "$KILL_LOG" ]
}

@test "wait-name-free: registered name times out loud and NEVER kills" {
    name_registered grappa
    beam_running   # the dangerous case: old node still draining

    run "$BEAM_WAIT" wait-name-free grappa 1
    [ "$status" -eq 1 ]
    [[ "$output" == *"still registered"* ]]
    [ ! -s "$KILL_LOG" ]
}

# --- usage ---------------------------------------------------------------------

@test "unknown verb is a usage error (64)" {
    run "$BEAM_WAIT" frobnicate grappa 1
    [ "$status" -eq 64 ]
}

@test "missing args is a usage error (64)" {
    run "$BEAM_WAIT" wait-stopped
    [ "$status" -eq 64 ]
}
