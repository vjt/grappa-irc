#!/usr/bin/env bats
#
# Bats suite for scripts/db.sh — the MIX_ENV probe and the worktree door
# (#1409 D-S11).
#
# WHY THIS EXISTS
#
# CLAUDE.md names `scripts/db.sh` a first-resort investigation tool, and it
# also rules that every code change happens in a worktree. The tool was
# therefore broken exactly where it is meant to be used, and it broke MUTE:
# measured from a real worktree, `scripts/db.sh "SELECT 1;"` exited 1 having
# written nothing at all, to either stream.
#
# The mechanism is worth stating, because it is not the one the review
# guessed. `db.sh` probed the env with
#
#     env="$(in_container printenv MIX_ENV 2>/dev/null || echo dev)"
#
# and `in_container` calls `die`, which is an `exit 1`. An `exit` inside a
# command substitution terminates the SUBSHELL — so `|| echo dev` never ran
# and the fallback was dead code. `env` came back empty, `set -e` killed the
# script on the assignment, and `die`'s message had already gone into
# `2>/dev/null`. It never reported `dev`, and it never reached the second
# `in_container` call the review expected to fail.
#
# Scope: asserts the SHAPE of the docker invocation — which door is used and
# which db path is opened. Stubs `docker` on PATH so no container is touched;
# `git` is real, so `_lib.sh` derives a genuine SRC_ROOT != REPO_ROOT from an
# actual `git worktree add`.

load ../bats_helpers

setup() {
    DB_SH="$BATS_TEST_DIRNAME/../../scripts/db.sh"
    LIB_SH="$BATS_TEST_DIRNAME/../../scripts/_lib.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Physical base so _lib.sh's `pwd`-derived SRC_ROOT and its
    # `git rev-parse`-derived REPO_ROOT agree on macOS (/var → /private/var).
    TMP="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"

    MAIN="$TMP/main"
    git init -q -b main "$MAIN"
    git -C "$MAIN" config user.email test@grappa.local
    git -C "$MAIN" config user.name "bats"
    mkdir -p "$MAIN/scripts" "$MAIN/lib"
    cp "$DB_SH" "$MAIN/scripts/db.sh"
    cp "$LIB_SH" "$MAIN/scripts/_lib.sh"
    : > "$MAIN/compose.yaml"
    echo base > "$MAIN/lib/base.ex"
    git -C "$MAIN" add -A
    git -C "$MAIN" commit -qm base

    WT="$TMP/wt"
    git -C "$MAIN" worktree add -q -b wt "$WT"

    # `MIX_ENV` the probe will read, and whether a live container exists.
    # Per-test overridable via the environment the stub re-reads at run time.
    STUB_ENV_FILE="$FAKE_DIR/mixenv"
    STUB_CID_FILE="$FAKE_DIR/cid"
    printf 'dev' > "$STUB_ENV_FILE"
    printf 'fakecontainerid\n' > "$STUB_CID_FILE"

    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
args="\$*"
case "\$args" in
    *"ps -q grappa"*)   cat "$STUB_CID_FILE"; exit 0 ;;
    *"printenv MIX_ENV"*)
        # No container up → compose exec fails, exactly as it would live.
        if [ ! -s "$STUB_CID_FILE" ]; then exit 1; fi
        cat "$STUB_ENV_FILE"
        exit 0
        ;;
    *)                  exit 0 ;;
esac
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"
}

@test "db.sh from a worktree opens the db instead of dying mute" {
    cd "$WT"
    run "$WT/scripts/db.sh" "SELECT 1;"
    [ "$status" -eq 0 ]
    # A oneshot, because the live container carries main's source, not ours.
    grep -q "run --rm" "$ARGV_LOG"
    grep -q "sqlite3" "$ARGV_LOG"
}

@test "db.sh from a worktree that cannot reach the db says so out loud" {
    # The residual failure mode must still be legible: whatever goes wrong,
    # it may not go wrong in silence the way the swallowed `die` did.
    printf '' > "$STUB_CID_FILE"
    cd "$WT"
    run "$WT/scripts/db.sh" "SELECT 1;"
    # Either it works through the oneshot or it fails — but a non-zero exit
    # with an empty message is the one outcome this test forbids.
    if [ "$status" -ne 0 ]; then
        [ -n "$output" ]
    fi
}

@test "no live container falls back to dev, not to an empty db path" {
    printf '' > "$STUB_CID_FILE"
    cd "$MAIN"
    run "$MAIN/scripts/db.sh" "SELECT 1;"
    [ "$status" -eq 0 ]
    grep -q "grappa_dev.db" "$ARGV_LOG"
    refute grep -q "grappa_.db" "$ARGV_LOG"
}

@test "a CR from the container never reaches the db path" {
    # `detect_mix_env` strips it; the hand-rolled probe db.sh used did not,
    # so a `\r` produced db_path_for_env "prod\r" and a nonexistent file.
    printf 'prod\r' > "$STUB_ENV_FILE"
    cd "$MAIN"
    run "$MAIN/scripts/db.sh" "SELECT 1;"
    [ "$status" -eq 0 ]
    grep -q "grappa_prod.db" "$ARGV_LOG"
    refute grep -q 'grappa_prod\$' "$ARGV_LOG"
}

@test "prod passes -readonly as one argument" {
    printf 'prod' > "$STUB_ENV_FILE"
    cd "$MAIN"
    run "$MAIN/scripts/db.sh" "SELECT 1;"
    [ "$status" -eq 0 ]
    grep -q " -readonly " "$ARGV_LOG"
}

@test "dev passes no empty argument to sqlite3" {
    # Guards the naive repair of the unquoted `$MODE_ARG`: quoting it as a
    # scalar hands sqlite3 an empty string as its FIRST argument, which it
    # reads as a filename. The mode has to be an array, not a quoted scalar.
    printf 'dev' > "$STUB_ENV_FILE"
    cd "$MAIN"
    run "$MAIN/scripts/db.sh" "SELECT 1;"
    [ "$status" -eq 0 ]
    refute grep -q "sqlite3 ''" "$ARGV_LOG"
}
