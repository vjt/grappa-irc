#!/usr/bin/env bats
#
# Bats suite for the worktree/branch guards on scripts/deploy.sh and
# scripts/deploy-cic.sh.
#
# #364 docker S10: both scripts did side effects BEFORE any worktree/branch
# guard could fire. deploy-cic.sh had NO branch guard at all and rebuilt
# runtime/cicchetto-dist (the bundle nginx serves — swapped on disk) before
# dying at in_container's late worktree check: dist deployed, non-zero exit,
# no refresh banner. deploy.sh performed `git pull` in REPO_ROOT (its own
# branch guard ran AFTER `cd REPO_ROOT`, so it checked main's branch and
# never caught a worktree) then died at the same late guard: tree updated,
# BEAM stale. The fix asserts SRC_ROOT==REPO_ROOT and branch==main as the
# FIRST step, before any pull/build.
#
# Scope: guard ordering. Runs the scripts against a throwaway repo + a real
# `git worktree add` (so _lib.sh derives a genuine SRC_ROOT!=REPO_ROOT),
# with `docker` stubbed on PATH. Asserts the guard fires before the
# side-effect echo ("Pulling latest main..." / "Building cicchetto dist...").

setup() {
    DEPLOY_SH="$BATS_TEST_DIRNAME/../../scripts/deploy.sh"
    DEPLOY_CIC_SH="$BATS_TEST_DIRNAME/../../scripts/deploy-cic.sh"
    LIB_SH="$BATS_TEST_DIRNAME/../../scripts/_lib.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Physical (symlink-resolved) base so _lib.sh's `pwd`-derived SRC_ROOT
    # and its `git rev-parse`-derived REPO_ROOT agree on macOS
    # (/var → /private/var). Without this the "main checkout" positive
    # cases would spuriously look like worktrees.
    TMP="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"

    MAIN="$TMP/main"
    git init -q -b main "$MAIN"
    git -C "$MAIN" config user.email test@grappa.local
    git -C "$MAIN" config user.name "bats"
    mkdir -p "$MAIN/scripts" "$MAIN/lib" "$MAIN/runtime"
    cp "$DEPLOY_SH" "$MAIN/scripts/deploy.sh"
    cp "$DEPLOY_CIC_SH" "$MAIN/scripts/deploy-cic.sh"
    cp "$LIB_SH" "$MAIN/scripts/_lib.sh"
    : > "$MAIN/compose.yaml"
    touch "$MAIN/runtime/.gitkeep"
    echo base > "$MAIN/lib/base.ex"
    git -C "$MAIN" add -A
    git -C "$MAIN" commit -qm "base"

    WT="$TMP/wt"
    git -C "$MAIN" worktree add -q -b wt "$WT"

    # docker stub — only the "main checkout" positive paths reach it.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
args="\$*"
case "\$args" in
    *"ps -q grappa"*)      echo "fakecontainerid"; exit 0 ;;
    *cic-bundle-changed*)  printf '%s' 'abc123';   exit 0 ;;
    *admin/reload*)        printf '%s' '{"reloaded":[],"failed":[]}'; exit 0 ;;
    *healthz*)             exit 0 ;;
    *)                     exit 0 ;;
esac
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"
}

# --- deploy.sh ---------------------------------------------------------------

@test "deploy.sh from a worktree dies BEFORE pulling" {
    cd "$WT"
    run "$WT/scripts/deploy.sh" --force-hot
    [ "$status" -ne 0 ]
    [[ "$output" == *"worktree"* ]]
    [[ "$output" != *"Pulling latest main"* ]]
}

@test "deploy.sh from the main checkout passes the worktree guard" {
    cd "$MAIN"
    run "$MAIN/scripts/deploy.sh" --force-hot
    # Reaching the pull echo proves the guard did not over-fire on main
    # (the pull itself then fails — the throwaway repo has no upstream).
    [[ "$output" == *"Pulling latest main"* ]]
    [[ "$output" != *"worktree"* ]]
}

@test "deploy.sh on a non-main branch dies at the branch guard before pulling" {
    git -C "$MAIN" checkout -q -b feature
    cd "$MAIN"
    run "$MAIN/scripts/deploy.sh" --force-hot
    [ "$status" -ne 0 ]
    [[ "$output" == *"branch"* ]]
    [[ "$output" != *"Pulling latest main"* ]]
}

# --- deploy-cic.sh -----------------------------------------------------------

@test "deploy-cic.sh from a worktree dies BEFORE building the dist" {
    cd "$WT"
    run "$WT/scripts/deploy-cic.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"worktree"* ]]
    [[ "$output" != *"Building cicchetto dist"* ]]
}

@test "deploy-cic.sh from the main checkout passes the guards and builds" {
    cd "$MAIN"
    run "$MAIN/scripts/deploy-cic.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Building cicchetto dist"* ]]
    [[ "$output" != *"worktree"* ]]
}

@test "deploy-cic.sh on a non-main branch dies at the branch guard before building" {
    git -C "$MAIN" checkout -q -b feature
    cd "$MAIN"
    run "$MAIN/scripts/deploy-cic.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"branch"* ]]
    [[ "$output" != *"Building cicchetto dist"* ]]
}
