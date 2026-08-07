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
# Scope: guard ordering + the #526 loud-fail contract. Runs the scripts
# against a throwaway repo + a real `git worktree add` (so _lib.sh derives
# a genuine SRC_ROOT!=REPO_ROOT), with `docker` stubbed on PATH. Asserts
# the guard fires before the side-effect echo ("Pulling latest main..." /
# "Building cicchetto dist..."), AND that deploy-cic.sh treats an empty
# (HTTP 204) bundle-hash response as a hard failure — see #526: the server
# built the bundle but resolved the wrong CIC_DIST_ROOT, could not read
# index.html, so the refresh-banner hash was never broadcast; the script's
# empty-body branch printed a ✓ success and the silent degradation went
# unnoticed. A cic deploy with zero broadcast is a FAILED deploy.

setup() {
    DEPLOY_SH="$BATS_TEST_DIRNAME/../../scripts/deploy.sh"
    DEPLOY_CIC_SH="$BATS_TEST_DIRNAME/../../scripts/deploy-cic.sh"
    LIB_SH="$BATS_TEST_DIRNAME/../../scripts/_lib.sh"
    VERSION_SH="$BATS_TEST_DIRNAME/../../infra/packaging/version.sh"

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
    mkdir -p "$MAIN/scripts" "$MAIN/infra/lib" "$MAIN/lib" "$MAIN/runtime"
    cp "$DEPLOY_SH" "$MAIN/scripts/deploy.sh"
    cp "$DEPLOY_CIC_SH" "$MAIN/scripts/deploy-cic.sh"
    cp "$LIB_SH" "$MAIN/scripts/_lib.sh"
    # #503: deploy.sh now sources the shared deploy algorithm lib — it must
    # exist in the checkout for the script to reach the pull step.
    cp "$BATS_TEST_DIRNAME/../../infra/lib/deploy_common.sh" "$MAIN/infra/lib/deploy_common.sh"
    # #1020: both scripts also source the build-beside-then-swap helper, at the
    # top — before the guards these cases are about. Missing it would kill them
    # for the wrong reason.
    cp "$BATS_TEST_DIRNAME/../../infra/lib/cic_dist.sh" "$MAIN/infra/lib/cic_dist.sh"
    # #538/#652 — deploy-cic.sh (and deploy.sh's cold path) derive the cic
    # version from the repo-root VERSION file via infra/packaging/version.sh.
    # The fixture needs both the script and a VERSION file to derive from, or
    # the real derivation dies under `set -e` before the build.
    mkdir -p "$MAIN/infra/packaging"
    cp "$VERSION_SH" "$MAIN/infra/packaging/version.sh"
    chmod +x "$MAIN/infra/packaging/version.sh"
    printf '9.9.9\n' > "$MAIN/VERSION"
    printf 'defmodule Grappa.MixProject do\n  @version "9.9.9"\nend\n' > "$MAIN/mix.exs"
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
    *"run --rm cicchetto-build"*)
        # #1020 — the oneshot writes the bundle into the CIC_BUILD_OUT staging
        # dir; deploy-cic.sh then promotes it, and the promote refuses an empty
        # tree. Model the write so these guard cases fail on guards only.
        cic_out="\${CIC_BUILD_OUT:-./runtime/cicchetto-dist}"
        mkdir -p "\$cic_out/assets"
        printf '<!doctype html>\\n' > "\$cic_out/index.html"
        exit 0
        ;;
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

@test "deploy-cic.sh treats an empty (204) bundle-hash response as a hard failure" {
    # #526: the server built + served the bundle (nginx), but resolved the
    # wrong CIC_DIST_ROOT and could not read index.html — so
    # /admin/cic-bundle-changed returned 204 (empty body) and the refresh
    # banner was never broadcast. A cic deploy whose whole purpose is the
    # live broadcast MUST NOT report ✓ on an empty response; it exits
    # non-zero AND names 204 so the operator sees the degradation.
    #
    # Override the docker stub so the cic-bundle-changed POST returns an
    # empty body (204), keeping the build + container-id lookups working so
    # the script reaches the broadcast step.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
args="\$*"
case "\$args" in
    *"ps -q grappa"*)      echo "fakecontainerid"; exit 0 ;;
    *cic-bundle-changed*)  printf '%s' ''; exit 0 ;;
    *"run --rm cicchetto-build"*)
        # #1020, as above: the build must produce a promotable tree, or this
        # case would die at the swap instead of reaching the 204 it is about.
        cic_out="\${CIC_BUILD_OUT:-./runtime/cicchetto-dist}"
        mkdir -p "\$cic_out/assets"
        printf '<!doctype html>\\n' > "\$cic_out/index.html"
        exit 0
        ;;
    *)                     exit 0 ;;
esac
EOF
    chmod +x "$FAKE_DIR/docker"

    cd "$MAIN"
    run "$MAIN/scripts/deploy-cic.sh"
    [ "$status" -ne 0 ]
    # Got past the guards + build — the failure is the empty broadcast.
    [[ "$output" == *"Building cicchetto dist"* ]]
    [[ "$output" == *"204"* ]]
}
