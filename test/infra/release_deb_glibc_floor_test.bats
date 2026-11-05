#!/usr/bin/env bats
#
# #2553 — the .deb's glibc FLOOR, as a recipe pin.
#
# `grappa_1.6.1_amd64.deb` and `grappa_1.6.2_amd64.deb` shipped a beam.smp
# that needs GLIBC_2.43, so neither runs on any Debian stable (trixie carries
# 2.41). The amd64 leg of the deb job ran on `ubuntu-latest`, GitHub moved
# that label from 24.04 to 26.04 between v1.6.0 and v1.6.1, and the bundled
# ERTS links the glibc of whatever host builds it. The arm64 leg, pinned to
# `ubuntu-24.04-arm`, stayed on GLIBC_2.38 the whole time. The job's own
# install proof stayed green for both releases, because it installs on the
# host that BUILT the package — the one host a glibc mismatch cannot show up on.
#
# Two cures, and this file pins both, because the deb job fires only on a tag
# or a dispatch and no pull request would otherwise notice either one go:
#
#   * every runner in the deb matrix names an Ubuntu RELEASE, and both legs
#     name the SAME one — a moving label is what moved the floor, and two
#     legs on two releases is the exact split the numbers above show;
#   * the deb job installs and boots both packages on a stock `debian:trixie`
#     BEFORE its first upload step. The order is the gate: `publish` runs on
#     `!cancelled()` and attaches whatever a leg uploaded, so a proof placed
#     after the upload (or in a separate job named in `publish`'s needs) would
#     go red while the broken package shipped anyway.
#
# What these cases CANNOT claim: that the floor proof passes. That is the deb
# job's work on a real tag or a `deb_validation` dispatch. The seam is the one
# release_image_credits_test.bats draws between reading the recipe and reading
# the artifact.

load ../bats_helpers

setup() {
    REPO_SRC="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    WORKFLOW="$REPO_SRC/.github/workflows/release.yml"
    PROOF="$REPO_SRC/infra/packaging/deb_floor_proof.sh"
}

# The deb job's lines: from its key to the next job key.
deb_job() {
    awk '/^  deb:$/ { on = 1; print; next }
         on && /^  [a-z][a-z0-9_-]*:$/ { exit }
         on' "$1"
}

# The runner of one matrix leg of the deb job, by its `arch:` value.
deb_runner() {
    deb_job "$1" | awk -v want="$2" '
        $1 == "-" && $2 == "arch:" { arch = $3; next }
        $1 == "runner:" && arch == want { print $2; exit }'
}

# A runner label that names an Ubuntu release (`ubuntu-24.04`,
# `ubuntu-24.04-arm`), never a moving one (`ubuntu-latest`).
names_a_release() {
    [[ "$1" =~ ^ubuntu-[0-9]+\.[0-9]+(-arm)?$ ]]
}

# Both legs on ONE Ubuntu release: the labels agree once the arm suffix goes.
same_release() {
    [ -n "$1" ] && [ "${1%-arm}" = "${2%-arm}" ]
}

# The floor proof is invoked against debian:trixie, ahead of the first upload.
floor_before_upload() {
    deb_job "$1" | awk '
        /infra\/packaging\/deb_floor_proof\.sh debian:trixie / && !floor { floor = NR }
        /uses: actions\/upload-artifact@/ && !upload { upload = NR }
        END { exit !(floor && upload && floor < upload) }'
}

@test "#2553 — the deb job's amd64 leg names an Ubuntu release, not ubuntu-latest" {
    runner="$(deb_runner "$WORKFLOW" amd64)"
    names_a_release "$runner" || {
        printf 'the amd64 deb leg runs on %q. A moving label moves the glibc the\n' "$runner" >&2
        printf 'bundled ERTS links: ubuntu-latest went 24.04 -> 26.04 and the package\n' >&2
        printf 'stopped running on Debian trixie (#2553).\n' >&2
        return 1
    }
}

@test "#2553 — both deb legs build on the same Ubuntu release" {
    amd64="$(deb_runner "$WORKFLOW" amd64)"
    arm64="$(deb_runner "$WORKFLOW" arm64)"
    names_a_release "$arm64"
    same_release "$amd64" "$arm64" || {
        printf 'the deb legs build on %q (amd64) and %q (arm64). Two releases mean\n' "$amd64" "$arm64" >&2
        printf 'two glibc floors for one version number (#2553).\n' >&2
        return 1
    }
}

@test "#2553 — the deb job proves the trixie install before it uploads anything" {
    floor_before_upload "$WORKFLOW" || {
        printf 'release.yml'"'"'s deb job does not run deb_floor_proof.sh against\n' >&2
        printf 'debian:trixie ahead of its first upload-artifact step. publish attaches\n' >&2
        printf 'whatever a leg uploaded, so only the ORDER keeps a package that cannot\n' >&2
        printf 'run on the floor out of the release (#2553).\n' >&2
        deb_job "$WORKFLOW" | grep -n 'deb_floor_proof\|upload-artifact@' >&2 || true
        return 1
    }
}

@test "#2553 — RED: the predicates reject a moving label, a split release and a late proof" {
    refute names_a_release ubuntu-latest
    refute names_a_release ubuntu-24.04-latest
    refute same_release ubuntu-26.04 ubuntu-24.04-arm
    refute same_release "" ""

    # POSITIVE controls: predicates broken into always-false would report
    # every RED above as a pass.
    names_a_release ubuntu-24.04
    names_a_release ubuntu-24.04-arm
    same_release ubuntu-24.04 ubuntu-24.04-arm

    local late="$BATS_TEST_TMPDIR/late.yml" early="$BATS_TEST_TMPDIR/early.yml"
    cat > "$late" <<'EOF'
jobs:
  deb:
    steps:
      - name: Upload .deb artifact
        uses: actions/upload-artifact@0000000000000000000000000000000000000000 # v0
      - name: Floor
        run: infra/packaging/deb_floor_proof.sh debian:trixie "$deb" "$client"
  arch:
    steps: []
EOF
    run floor_before_upload "$late"
    [ "$status" -ne 0 ]

    # A proof that sits in the NEXT job is not in the deb job at all.
    cat > "$early" <<'EOF'
jobs:
  deb:
    steps:
      - name: Upload .deb artifact
        uses: actions/upload-artifact@0000000000000000000000000000000000000000 # v0
  floor:
    steps:
      - run: infra/packaging/deb_floor_proof.sh debian:trixie "$deb" "$client"
EOF
    run floor_before_upload "$early"
    [ "$status" -ne 0 ]

    cat > "$early" <<'EOF'
jobs:
  deb:
    steps:
      - name: Floor
        run: infra/packaging/deb_floor_proof.sh debian:trixie "$deb" "$client"
      - name: Upload .deb artifact
        uses: actions/upload-artifact@0000000000000000000000000000000000000000 # v0
  arch:
    steps: []
EOF
    run floor_before_upload "$early"
    [ "$status" -eq 0 ]
}

@test "#2553 — deb_floor_proof.sh refuses a missing package before it reaches docker" {
    # A docker on PATH that records being called: the refusal must come first,
    # or a typo'd path would surface as an apt error inside a container.
    local bin="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$bin"
    printf '#!/bin/sh\necho called >> "%s/docker.log"\n' "$BATS_TEST_TMPDIR" > "$bin/docker"
    chmod +x "$bin/docker"
    : > "$BATS_TEST_TMPDIR/grappa_1.0.0_amd64.deb"

    PATH="$bin:$PATH" run "$PROOF" debian:trixie \
        "$BATS_TEST_TMPDIR/grappa_1.0.0_amd64.deb" "$BATS_TEST_TMPDIR/missing.deb"
    [ "$status" -ne 0 ]
    grep -qF 'missing.deb' <<<"$output"
    refute test -e "$BATS_TEST_TMPDIR/docker.log"
}
