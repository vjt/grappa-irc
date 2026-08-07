#!/usr/bin/env bats
#
# #1020 — a cic build must NEVER empty the directory a running server is
# serving. Every substrate used to aim vite's `outDir` straight at
# `runtime/cicchetto-dist`, which the BEAM resolves PER REQUEST
# (Grappa.Cic.Bundle.root/0 → Plug.Static + the SPA history-fallback), and
# vite empties `outDir` BEFORE it writes: the served tree was blank for the
# whole build and stayed blank if the build failed.
#
# What makes these tests able to go red, rather than mirrors of the fix: the
# fake builders below EMULATE vite (empty the outDir first, write the bundle
# last) and, at the most dangerous instant — right after the wipe — record
# what the SERVED directory contains. On the parent commit outDir IS the
# served dir, so that recording reads MISSING and the assertion fails. It is
# a property of the timing, not of any string in the script.
#
# Coverage, and its limit, stated plainly:
#   * infra/lib/cic_dist.sh          exercised directly (the swap semantics)
#   * infra/freebsd/jail_cic_build.sh  RUN, with su + npm stubbed  (prod)
#   * infra/linux/cic_build.sh         RUN, with sudo + bun stubbed
#   * the Docker substrate             STRUCTURE only — the build happens
#     inside a container against a compose bind mount, so no bats can run it.
#     Pinned instead: compose.yaml's mount source is the CIC_BUILD_OUT seam,
#     and every compose launcher sets it on the build command and promotes
#     afterwards. Nothing here proves a real container wrote where we think.

load ../bats_helpers

REPO_SRC=""

setup() {
    REPO_SRC="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    LIB="$REPO_SRC/infra/lib/cic_dist.sh"

    SERVED="$BATS_TEST_TMPDIR/runtime/cicchetto-dist"
    STAGED="$SERVED.next"
    mkdir -p "$SERVED/assets"
}

# A served tree that is complete and CURRENTLY BEING SERVED: index.html, one
# content-hashed chunk, and the tracked placeholder.
seed_served_bundle() {
    mkdir -p "$SERVED/assets"
    printf 'OLD\n' > "$SERVED/index.html"
    printf 'old chunk\n' > "$SERVED/assets/index-oldhash.js"
    touch "$SERVED/.gitkeep"
}

# A finished build waiting to be promoted.
seed_staged_bundle() {
    mkdir -p "$STAGED/assets"
    printf 'NEW\n' > "$STAGED/index.html"
    printf 'new chunk\n' > "$STAGED/assets/index-newhash.js"
}

# ======================================================================
# infra/lib/cic_dist.sh — the swap itself
# ======================================================================

@test "staging: the path is derived once, beside the served dir" {
    # shellcheck source=/dev/null
    . "$LIB"
    run cic_dist_staging /srv/grappa/runtime/cicchetto-dist
    [ "$status" -eq 0 ]
    [ "$output" = "/srv/grappa/runtime/cicchetto-dist.next" ]
}

@test "staging: an empty served path is refused, not turned into rm -rf .next" {
    # shellcheck source=/dev/null
    . "$LIB"
    run cic_dist_staging ""
    [ "$status" -ne 0 ]
}

@test "promote: the served tree goes complete-old to complete-new" {
    # shellcheck source=/dev/null
    . "$LIB"
    seed_served_bundle
    seed_staged_bundle

    run cic_dist_promote "$SERVED" "$STAGED"
    [ "$status" -eq 0 ]

    [ "$(cat "$SERVED/index.html")" = "NEW" ]
    [ -f "$SERVED/assets/index-newhash.js" ]
    # The stale-chunk cleanup --emptyOutDir used to provide, preserved: the
    # previous content-hashed assets leave with the previous directory.
    refute test -f "$SERVED/assets/index-oldhash.js"
    # No debris: a leftover .next would be promoted blind by the next run,
    # a leftover .prev would grow one dead bundle per deploy.
    refute test -e "$STAGED"
    refute test -e "$SERVED.prev"
}

@test "promote: the tracked .gitkeep is in the tree that LANDS" {
    # shellcheck source=/dev/null
    . "$LIB"
    seed_served_bundle
    seed_staged_bundle
    refute test -f "$STAGED/.gitkeep"

    run cic_dist_promote "$SERVED" "$STAGED"
    [ "$status" -eq 0 ]
    # Not restored afterwards — present the instant the tree becomes the
    # served one, so `git status` never sees `D runtime/cicchetto-dist/.gitkeep`.
    [ -f "$SERVED/.gitkeep" ]
}

@test "promote: a staged tree with no index.html is refused and the old bundle keeps serving" {
    # shellcheck source=/dev/null
    . "$LIB"
    seed_served_bundle
    mkdir -p "$STAGED/assets"
    printf 'orphan chunk\n' > "$STAGED/assets/index-newhash.js"

    run cic_dist_promote "$SERVED" "$STAGED"
    [ "$status" -ne 0 ]
    [ "$(cat "$SERVED/index.html")" = "OLD" ]
    [ -f "$SERVED/assets/index-oldhash.js" ]
}

@test "promote: the new bundle does not land NESTED inside the served dir" {
    # `mv a b` where b is an existing DIRECTORY moves a INSIDE b. That failure
    # is silent — the server keeps serving the old bundle and every step
    # reports success — so it gets its own case rather than riding on the
    # content assertions above.
    # shellcheck source=/dev/null
    . "$LIB"
    seed_served_bundle
    seed_staged_bundle

    run cic_dist_promote "$SERVED" "$STAGED"
    [ "$status" -eq 0 ]
    refute test -e "$SERVED/cicchetto-dist.next"
}

@test "promote: a served dir that does not exist yet is created by the swap" {
    # shellcheck source=/dev/null
    . "$LIB"
    rm -rf "$SERVED"
    seed_staged_bundle

    run cic_dist_promote "$SERVED" "$STAGED"
    [ "$status" -eq 0 ]
    [ "$(cat "$SERVED/index.html")" = "NEW" ]
}

@test "docker stage: the staging dir is cleared, created, and echoed compose-shaped" {
    # shellcheck source=/dev/null
    . "$LIB"
    mkdir -p "$STAGED"
    printf 'debris from a crashed run\n' > "$STAGED/index.html"

    cd "$BATS_TEST_TMPDIR"
    run cic_dist_docker_stage runtime/cicchetto-dist
    [ "$status" -eq 0 ]
    # A compose bind-mount source without a leading ./ is parsed as a NAMED
    # VOLUME, so the prefix is load-bearing, not cosmetic.
    [ "$output" = "./runtime/cicchetto-dist.next" ]
    [ -d "$STAGED" ]
    refute test -e "$STAGED/index.html"
}

# ======================================================================
# Shared fake builder — emulates vite closely enough to catch the timing
# ======================================================================

# Writes a stub named $1 into $FAKE_DIR that behaves like `vite build`:
# empties --outDir first, RECORDS what the served dir holds at that instant,
# then writes a bundle. Honors $FAKE_BUILD_RC to model a failed build.
write_fake_builder() {
    cat > "$FAKE_DIR/$1" <<'EOF'
#!/bin/sh
# `<tool> install` / `<tool> ci` — nothing to do, just succeed.
case "${1:-}" in
    install|ci) exit 0 ;;
esac

outdir=""
prev=""
for arg in "$@"; do
    [ "$prev" = "--outDir" ] && outdir="$arg"
    prev="$arg"
done
[ -n "$outdir" ] || { echo "fake builder: no --outDir in: $*" >&2; exit 2; }
printf '%s\n' "$outdir" >> "$OUTDIR_LOG"

# Vite's prepare-out-dir step: the directory is emptied BEFORE anything is
# written. This is the whole defect — if outdir IS the served dir, the SPA
# is gone from here until the build finishes.
mkdir -p "$outdir"
rm -rf "$outdir"/* "$outdir"/.[!.]* 2>/dev/null || true

# The observation that makes this suite able to fail: what does a browser
# hitting the live server get RIGHT NOW, mid-build?
if [ -f "$SERVED/index.html" ]; then
    cat "$SERVED/index.html" > "$MIDBUILD_OBSERVED"
else
    echo MISSING > "$MIDBUILD_OBSERVED"
fi

[ "${FAKE_BUILD_RC:-0}" = 0 ] || { echo "fake builder: failing on purpose" >&2; exit "$FAKE_BUILD_RC"; }

mkdir -p "$outdir/assets"
printf 'NEW\n' > "$outdir/index.html"
printf 'new chunk\n' > "$outdir/assets/index-newhash.js"
EOF
    chmod +x "$FAKE_DIR/$1"
}

setup_builder_harness() {
    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    # Ahead of the real toolchain for the whole test, including the child
    # shells `su`/`sudo` spawn — those inherit this PATH.
    export PATH="$FAKE_DIR:$PATH"
    OUTDIR_LOG="$BATS_TEST_TMPDIR/outdir.log"
    MIDBUILD_OBSERVED="$BATS_TEST_TMPDIR/midbuild.observed"
    : > "$OUTDIR_LOG"
    export OUTDIR_LOG MIDBUILD_OBSERVED SERVED FAKE_BUILD_RC=0

    # Empty HOME: infra/linux/cic_build.sh prepends ~/.local/bin and
    # ~/.asdf/shims to PATH, and a real bun there would shadow the stub.
    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"
}

# A throwaway checkout with the pieces a cic build reads: the version single
# source of truth, the shared swap lib, a cicchetto dir, and runtime/.
seed_fake_checkout() {
    FAKE_ROOT="$1"
    mkdir -p "$FAKE_ROOT/cicchetto" "$FAKE_ROOT/infra/packaging" "$FAKE_ROOT/infra/lib" "$FAKE_ROOT/runtime"
    cp "$REPO_SRC/infra/packaging/version.sh" "$FAKE_ROOT/infra/packaging/version.sh"
    chmod +x "$FAKE_ROOT/infra/packaging/version.sh"
    cp "$LIB" "$FAKE_ROOT/infra/lib/cic_dist.sh"
    printf '9.9.9\n' > "$FAKE_ROOT/VERSION"
    printf '{"name":"cicchetto"}\n' > "$FAKE_ROOT/cicchetto/package.json"
}

# ======================================================================
# infra/freebsd/jail_cic_build.sh — the PRODUCTION substrate
# ======================================================================

setup_jail_harness() {
    setup_builder_harness
    FAKE_ROOT="$BATS_TEST_TMPDIR/jail/home/grappa/grappa"
    seed_fake_checkout "$FAKE_ROOT"
    SERVED="$FAKE_ROOT/runtime/cicchetto-dist"
    STAGED="$SERVED.next"
    export SERVED
    seed_served_bundle

    write_fake_builder npm

    # `su -l grappa -c BODY` → run BODY under /bin/sh, with the jail's
    # hardcoded /home/grappa/grappa rewritten onto the throwaway checkout.
    # The RELOCATION is the only edit: the body that runs is the real script's
    # body, so the build command, the outDir and the promote are the shipped
    # ones. A change to the hardcoded root makes the cd miss and reddens here.
    cat > "$FAKE_DIR/su" <<EOF
#!/bin/sh
body=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        -c) body="\$2"; shift 2 ;;
        *) shift ;;
    esac
done
printf '%s' "\$body" | sed "s#/home/grappa/grappa#$FAKE_ROOT#g" > "$BATS_TEST_TMPDIR/su-body.sh"
exec /bin/sh "$BATS_TEST_TMPDIR/su-body.sh"
EOF
    chmod +x "$FAKE_DIR/su"
}

@test "jail: the served bundle is still serving while vite builds" {
    setup_jail_harness
    run "$REPO_SRC/infra/freebsd/jail_cic_build.sh"
    [ "$status" -eq 0 ]

    # THE red on the parent commit: there, outDir is the served dir, so the
    # wipe had already taken the SPA down by this point.
    [ "$(cat "$MIDBUILD_OBSERVED")" = "OLD" ]
    refute grep -qFx "$SERVED" "$OUTDIR_LOG"
}

@test "jail: the new bundle lands, stale chunks and debris do not" {
    setup_jail_harness
    run "$REPO_SRC/infra/freebsd/jail_cic_build.sh"
    [ "$status" -eq 0 ]

    [ "$(cat "$SERVED/index.html")" = "NEW" ]
    [ -f "$SERVED/.gitkeep" ]
    refute test -f "$SERVED/assets/index-oldhash.js"
    refute test -e "$STAGED"
}

@test "jail: a FAILED build leaves the previous bundle serving" {
    setup_jail_harness
    FAKE_BUILD_RC=1
    export FAKE_BUILD_RC

    run "$REPO_SRC/infra/freebsd/jail_cic_build.sh"
    [ "$status" -ne 0 ]

    # On the parent this directory was emptied at the start of the build and
    # `set -eu` walked away from the wreckage.
    [ "$(cat "$SERVED/index.html")" = "OLD" ]
    [ -f "$SERVED/assets/index-oldhash.js" ]
    [ -f "$SERVED/.gitkeep" ]
}

# ======================================================================
# infra/linux/cic_build.sh
# ======================================================================

setup_linux_harness() {
    setup_builder_harness
    FAKE_ROOT="$BATS_TEST_TMPDIR/linux"
    seed_fake_checkout "$FAKE_ROOT"
    SERVED="$FAKE_ROOT/runtime/cicchetto-dist"
    STAGED="$SERVED.next"
    export SERVED
    seed_served_bundle

    write_fake_builder bun

    # sudo -u grappa -H bash -c '<cmd>' → run <cmd> in-process (same shape as
    # deploy_linux_test.bats): real privilege-dropping is not what is under test.
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
    chmod +x "$FAKE_DIR/sudo"
}

@test "linux: the served bundle is still serving while vite builds" {
    setup_linux_harness
    run "$REPO_SRC/infra/linux/cic_build.sh" "$FAKE_ROOT"
    [ "$status" -eq 0 ]

    [ "$(cat "$MIDBUILD_OBSERVED")" = "OLD" ]
    refute grep -qFx "$SERVED" "$OUTDIR_LOG"
}

@test "linux: the new bundle lands, stale chunks and debris do not" {
    setup_linux_harness
    run "$REPO_SRC/infra/linux/cic_build.sh" "$FAKE_ROOT"
    [ "$status" -eq 0 ]

    [ "$(cat "$SERVED/index.html")" = "NEW" ]
    [ -f "$SERVED/.gitkeep" ]
    refute test -f "$SERVED/assets/index-oldhash.js"
    refute test -e "$STAGED"
}

@test "linux: a FAILED build leaves the previous bundle serving" {
    setup_linux_harness
    FAKE_BUILD_RC=1
    export FAKE_BUILD_RC

    run "$REPO_SRC/infra/linux/cic_build.sh" "$FAKE_ROOT"
    [ "$status" -ne 0 ]

    [ "$(cat "$SERVED/index.html")" = "OLD" ]
    [ -f "$SERVED/assets/index-oldhash.js" ]
    [ -f "$SERVED/.gitkeep" ]
}

# ======================================================================
# Docker — structure only, and it says so
# ======================================================================

# The compose oneshot writes to whatever host dir is bind-mounted at
# /app/dist, so the seam that keeps it off the served tree lives in
# compose.yaml. Byte-pinned: the default must stay the served dir (a bare
# `compose --profile prod up` has no live server to protect and reaches the
# build through grappa's depends_on, with nobody to promote afterwards).
@test "docker: the cicchetto-build mount source is the CIC_BUILD_OUT seam" {
    grep -qF '${CIC_BUILD_OUT:-./runtime/cicchetto-dist}:/app/dist' "$REPO_SRC/compose.yaml"
}

# Comments are prose; only code counts. Same stripping as
# cic_version_export_test.bats, for the same reason.
code_of() {
    sed -e 's/[[:space:]]*#.*$//' "$1"
}

DOCKER_LAUNCHERS=(
    scripts/deploy.sh
    scripts/deploy-cic.sh
    infra/docker/deploy.sh
)

@test "docker: every compose launcher aims the build at a staging dir and promotes it" {
    local offenders=() rel code
    for rel in "${DOCKER_LAUNCHERS[@]}"; do
        code="$(code_of "$REPO_SRC/$rel")"
        # CIC_BUILD_OUT must be set ON the build command, not exported at
        # large: a stray export would still be in the environment for the
        # `up`/`restart` compose calls that follow.
        grep -qE 'CIC_BUILD_OUT=.*run --rm cicchetto-build' <<< "$code" \
            || offenders+=("$rel (build not aimed at CIC_BUILD_OUT)")
        grep -q 'cic_dist_promote' <<< "$code" \
            || offenders+=("$rel (never promotes the staged bundle)")
    done
    [ "${#offenders[@]}" -eq 0 ] || {
        printf 'compose launchers that build into the SERVED dist (see #1020):\n' >&2
        printf '  %s\n' "${offenders[@]}" >&2
        return 1
    }
}

@test "docker: no launcher restores .gitkeep after the build any more" {
    # The three post-build `touch runtime/cicchetto-dist/.gitkeep` calls existed
    # ONLY to undo vite's in-place wipe. Leaving one behind would mean the
    # served dir is still being written to directly.
    local offenders=() rel
    for rel in "${DOCKER_LAUNCHERS[@]}" infra/linux/cic_build.sh infra/freebsd/jail_cic_build.sh; do
        # An `if`, not `grep ... && offenders+=`: a non-matching grep at the
        # head of an AND list makes the whole list return 1, and bats runs
        # test bodies under errexit (see test/bats_helpers.bash).
        if grep -q 'touch .*cicchetto-dist/\.gitkeep' <<< "$(code_of "$REPO_SRC/$rel")"; then
            offenders+=("$rel")
        fi
    done
    [ "${#offenders[@]}" -eq 0 ] || {
        printf 'post-build .gitkeep restores left behind (see #1020):\n' >&2
        printf '  %s\n' "${offenders[@]}" >&2
        return 1
    }
}
