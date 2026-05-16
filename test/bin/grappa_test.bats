#!/usr/bin/env bats
#
# Bats suite for bin/grappa — the host-side operator dispatcher.
#
# Scope: tests grappa.sh's verb routing, kebab→snake mapping, help text,
# and the shape of subprocess invocations (docker compose / scripts/mix.sh).
# Stubs `docker` AND `scripts/mix.sh` via PATH + SCRIPTS_DIR override so
# no real container or DB write happens.
#
# Out of scope: this is NOT an integration test. The actual docker
# compose API surface drift is caught by scripts/integration.sh.

setup() {
    BIN_GRAPPA="$BATS_TEST_DIRNAME/../../bin/grappa"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR/scripts"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Stub `docker` + `scripts/mix.sh` on PATH / via SCRIPTS_DIR override.
    # Note: `git` is NOT stubbed — _lib.sh sources call `git rev-parse`
    # to derive REPO_ROOT. Tests assume the host has a real git checkout
    # (the worktree itself); running these in a non-git CWD will break.

    # Fake `docker` on PATH — records every invocation, exits 0.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"

    # Fake scripts/mix.sh — same recording shape, exits 0.
    cat > "$FAKE_DIR/scripts/mix.sh" <<EOF
#!/usr/bin/env bash
printf 'mix.sh' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
exit 0
EOF
    chmod +x "$FAKE_DIR/scripts/mix.sh"

    export PATH="$FAKE_DIR:$PATH"
    export SCRIPTS_DIR="$FAKE_DIR/scripts"
}

# --- help -----------------------------------------------------------------

@test "help lists every verb under each group header" {
    run "$BIN_GRAPPA" help
    [ "$status" -eq 0 ]
    [[ "$output" == *"Boot-time"* ]]
    [[ "$output" == *"Live-state"* ]]
    [[ "$output" == *"Debug"* ]]
    # boot-time verbs
    [[ "$output" == *"create-user"* ]]
    [[ "$output" == *"bind-network"* ]]
    [[ "$output" == *"add-server"* ]]
    [[ "$output" == *"set-network-caps"* ]]
    [[ "$output" == *"unbind-network"* ]]
    [[ "$output" == *"update-network-credential"* ]]
    [[ "$output" == *"seed-scrollback"* ]]
    [[ "$output" == *"gen-encryption-key"* ]]
    [[ "$output" == *"gen-vapid"* ]]
    [[ "$output" == *"remove-server"* ]]
    # live-state verbs (stubs in T-1)
    [[ "$output" == *"delete-visitor"* ]]
    [[ "$output" == *"reap-visitors"* ]]
    [[ "$output" == *"list-sessions"* ]]
    [[ "$output" == *"list-credentials"* ]]
    [[ "$output" == *"list-visitors"* ]]
    [[ "$output" == *"remote-shell"* ]]
    # debug verbs
    [[ "$output" == *"open-db"* ]]
    [[ "$output" == *"shell"* ]]
}

@test "no args prints help and exits 0" {
    run "$BIN_GRAPPA"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Boot-time"* ]]
}

# --- unknown verb ---------------------------------------------------------

@test "unknown verb exits 64 with usage to stderr" {
    run "$BIN_GRAPPA" frobnicate
    [ "$status" -eq 64 ]
    [[ "$output" == *"unknown verb"* ]]
    [[ "$output" == *"frobnicate"* ]]
    [[ "$output" == *"bin/grappa help"* ]]
}

# --- per-verb help --------------------------------------------------------

@test "help <stub-verb> prints inline T-2/T-3 pointer" {
    run "$BIN_GRAPPA" help delete-visitor
    [ "$status" -eq 0 ]
    [[ "$output" == *"T-3"* ]]
}

@test "help <boot-verb> delegates to scripts/mix.sh help grappa.<task>" {
    run "$BIN_GRAPPA" help create-user
    [ "$status" -eq 0 ]
    grep -q 'mix.sh --env=dev help grappa.create_user' "$ARGV_LOG"
}

@test "help <debug-verb> prints inline help" {
    run "$BIN_GRAPPA" help shell
    [ "$status" -eq 0 ]
    [[ "$output" == *"shell"* ]]
}

@test "help <unknown-verb> exits 64" {
    run "$BIN_GRAPPA" help frobnicate
    [ "$status" -eq 64 ]
}

# --- debug verbs ----------------------------------------------------------

@test "shell invokes docker compose exec grappa bash" {
    run "$BIN_GRAPPA" shell
    [ "$status" -eq 0 ]
    grep -qE 'docker .*compose .*exec grappa bash' "$ARGV_LOG"
}

@test "open-db invokes sqlite3 in container with RW (no -readonly)" {
    run "$BIN_GRAPPA" open-db
    [ "$status" -eq 0 ]
    grep -q 'sqlite3' "$ARGV_LOG"
    ! grep -q -- '-readonly' "$ARGV_LOG"
}

# --- boot-time verb dispatch ---------------------------------------------

@test "create-user dispatches scripts/mix.sh grappa.create_user with args" {
    run "$BIN_GRAPPA" create-user --name vjt --password 'pwd'
    [ "$status" -eq 0 ]
    grep -q 'mix.sh grappa.create_user --name vjt --password pwd' "$ARGV_LOG"
}

@test "kebab-to-snake mapping handles multi-word verbs" {
    run "$BIN_GRAPPA" update-network-credential --foo bar
    [ "$status" -eq 0 ]
    grep -q 'mix.sh grappa.update_network_credential --foo bar' "$ARGV_LOG"
}

@test "set-network-caps maps to grappa.set_network_caps" {
    run "$BIN_GRAPPA" set-network-caps --network azzurra --max 5
    [ "$status" -eq 0 ]
    grep -q 'mix.sh grappa.set_network_caps --network azzurra --max 5' "$ARGV_LOG"
}

# --- stub verbs (T-1 placeholders) ---------------------------------------

@test "delete-visitor stub exits 64 mentions T-3" {
    run "$BIN_GRAPPA" delete-visitor abc-uuid
    [ "$status" -eq 64 ]
    [[ "$output" == *"T-3"* ]]
    [[ "$output" == *"not yet implemented"* ]]
}

@test "reap-visitors stub exits 64 mentions T-3" {
    run "$BIN_GRAPPA" reap-visitors
    [ "$status" -eq 64 ]
    [[ "$output" == *"T-3"* ]]
}

@test "remote-shell stub exits 64 mentions T-2" {
    run "$BIN_GRAPPA" remote-shell
    [ "$status" -eq 64 ]
    [[ "$output" == *"T-2"* ]]
}

@test "list-sessions stub exits 64" {
    run "$BIN_GRAPPA" list-sessions
    [ "$status" -eq 64 ]
    [[ "$output" == *"not yet implemented"* ]]
}

@test "list-credentials stub exits 64" {
    run "$BIN_GRAPPA" list-credentials
    [ "$status" -eq 64 ]
    [[ "$output" == *"not yet implemented"* ]]
}

@test "list-visitors stub exits 64" {
    run "$BIN_GRAPPA" list-visitors
    [ "$status" -eq 64 ]
    [[ "$output" == *"not yet implemented"* ]]
}
