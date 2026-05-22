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

@test "help delete-visitor shows real usage (uuid arg + Operator entry point)" {
    run "$BIN_GRAPPA" help delete-visitor
    [ "$status" -eq 0 ]
    [[ "$output" == *"uuid"* ]]
    [[ "$output" != *"STUB"* ]]
    [[ "$output" != *"land in T-3"* ]]
}

@test "help remote-shell shows real usage (not the T-1 stub)" {
    run "$BIN_GRAPPA" help remote-shell
    [ "$status" -eq 0 ]
    [[ "$output" == *"--batch"* ]]
    [[ "$output" == *"-e"* ]]
    [[ "$output" != *"STUB"* ]]
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

# --- live-state verbs (T-3 — wired through --rpc-eval) ------------------

@test "delete-visitor invokes docker exec -T grappa with --rpc-eval calling Operator.delete_visitor!" {
    run "$BIN_GRAPPA" delete-visitor abc-uuid-1234
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q -- 'grappa@grappa' "$ARGV_LOG"
    grep -q 'Grappa.Operator.delete_visitor' "$ARGV_LOG"
    grep -q 'abc-uuid-1234' "$ARGV_LOG"
    # --rpc-eval (NOT --remsh which would eval on client) — same shape
    # as remote-shell --batch per T-2.
    ! grep -q -- '--remsh' "$ARGV_LOG"
}

@test "delete-visitor with no args exits 64 with usage" {
    run "$BIN_GRAPPA" delete-visitor
    [ "$status" -eq 64 ]
    [[ "$output" == *"delete-visitor"* ]]
    [[ "$output" == *"uuid"* ]]
}

@test "reap-visitors invokes docker exec -T grappa with --rpc-eval calling Operator.reap_visitors!" {
    run "$BIN_GRAPPA" reap-visitors
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Grappa.Operator.reap_visitors' "$ARGV_LOG"
}

@test "remote-shell with no args invokes docker exec grappa iex --remsh grappa@grappa" {
    run "$BIN_GRAPPA" remote-shell
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec grappa sh' "$ARGV_LOG"
    # printf %q escapes the inner sh -c quotes; assert the load-bearing
    # tokens individually rather than reconstructing the escaped form.
    grep -q 'iex' "$ARGV_LOG"
    grep -q -- '--sname' "$ARGV_LOG"
    grep -q -- 'admin-' "$ARGV_LOG"
    grep -q -- '--cookie' "$ARGV_LOG"
    grep -q 'RELEASE_COOKIE' "$ARGV_LOG"
    grep -q -- '--remsh' "$ARGV_LOG"
    grep -q -- 'grappa@grappa' "$ARGV_LOG"
    # Interactive mode — NO -T flag in the docker exec.
    ! grep -qE 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
}

@test "remote-shell --batch -e <expr> invokes docker exec -T with --rpc-eval" {
    run "$BIN_GRAPPA" remote-shell --batch -e 'Process.list() |> length()'
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Process.list' "$ARGV_LOG"
    grep -q -- 'grappa@grappa' "$ARGV_LOG"
    # Batch uses --rpc-eval (eval on REMOTE), NOT --remsh (which would
    # eval on the client node before attaching the shell).
    ! grep -q -- '--remsh' "$ARGV_LOG"
}

@test "remote-shell --batch without -e exits 64 with usage" {
    run "$BIN_GRAPPA" remote-shell --batch
    [ "$status" -eq 64 ]
    [[ "$output" == *"--batch"* ]]
    [[ "$output" == *"-e"* ]]
}

@test "remote-shell shape includes --sname admin- and --cookie literal RELEASE_COOKIE" {
    run "$BIN_GRAPPA" remote-shell
    [ "$status" -eq 0 ]
    # The cookie value is expanded INSIDE the container's sh -c, so the
    # host-side argv contains the LITERAL string "$RELEASE_COOKIE".
    grep -q -- 'admin-' "$ARGV_LOG"
    grep -q -- '\$RELEASE_COOKIE' "$ARGV_LOG"
}

@test "list-sessions invokes docker exec -T grappa with --rpc-eval calling Operator.list_sessions_text!" {
    run "$BIN_GRAPPA" list-sessions
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Grappa.Operator.list_sessions_text' "$ARGV_LOG"
}

@test "list-credentials invokes docker exec -T grappa with --rpc-eval calling Operator.list_credentials_text!" {
    run "$BIN_GRAPPA" list-credentials
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Grappa.Operator.list_credentials_text' "$ARGV_LOG"
}

@test "list-visitors invokes docker exec -T grappa with --rpc-eval calling Operator.list_visitors_text!" {
    run "$BIN_GRAPPA" list-visitors
    [ "$status" -eq 0 ]
    grep -q 'docker .*compose .*exec -T grappa sh' "$ARGV_LOG"
    grep -q -- '--rpc-eval' "$ARGV_LOG"
    grep -q 'Grappa.Operator.list_visitors_text' "$ARGV_LOG"
}

# --- M3 (REV-I) — VERBS table single-source-of-truth invariants ---------

@test "rpc verb with extra args exits 64 (nullary rpc handler refuses args)" {
    # Per M3 (REV-I) prefer-bespoke rule: nullary rpc verbs go through
    # dispatch_rpc which refuses extra args. If a future arg-taking
    # rpc verb is added without a bespoke verb_<snake>() handler, this
    # test will catch the mistake at the right call site.
    run "$BIN_GRAPPA" reap-visitors --extra
    [ "$status" -eq 64 ]
    [[ "$output" == *"reap-visitors"* ]]
    [[ "$output" == *"no arguments"* ]]
}
