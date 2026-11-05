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
#     go red while the broken package shipped anyway. For the same reason the
#     proof and the uploads must carry no `if:` and no `continue-on-error:`;
#   * the proof runs the DISPATCHED ref's copy of the script. A repair
#     dispatch checks out an existing tag, and no tag cut before #2553 carries
#     it — the tag's copy would die 127 on the repair of 1.6.2 itself.
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

# The deb job's lines, from its key to the next job key. Comment lines are
# dropped: a commented-out step is not a step.
deb_job() {
    awk '/^  deb:$/ { on = 1; print; next }
         on && /^  [a-z][a-z0-9_-]*:$/ { exit }
         on && !/^[[:space:]]*#/' "$1"
}

# The runner of one matrix leg of the deb job, by its `arch:` value.
deb_runner() {
    deb_job "$1" | awk -v want="$2" '
        $1 == "-" && $2 == "arch:" { arch = $3; next }
        $1 == "runner:" && arch == want { print $2; exit }'
}

# The deb job's `runs-on:` value, verbatim.
deb_runs_on() {
    deb_job "$1" | awk '$1 == "runs-on:" { sub(/^[[:space:]]*runs-on:[[:space:]]*/, ""); print; exit }'
}

# Every step of the deb job that has a line matching the pattern, whole.
deb_steps() {
    deb_job "$1" | awk -v pat="$2" '
        function flush() { if (hit) printf "%s", buf; buf = ""; hit = 0 }
        /^      - / { flush() }
        { buf = buf $0 "\n" }
        $0 ~ pat { hit = 1 }
        END { flush() }'
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
        /deb_floor_proof\.sh"? debian:trixie / && !floor { floor = NR }
        /uses: actions\/upload-artifact@/ && !upload { upload = NR }
        END { exit !(floor && upload && floor < upload) }'
}

# Steps that run whatever happened before them: no step-level `if:` and no
# `continue-on-error:`. Empty input is not a step and does not pass.
no_escape() {
    [ -n "$1" ] && refute grep -qE '^      (- |  )(if|continue-on-error):' <<<"$1"
}

# The floor step takes the script from GITHUB_SHA and runs that copy.
floor_from_dispatched_ref() {
    local step
    step="$(deb_steps "$1" 'deb_floor_proof\.sh')"
    grep -qF 'git show "${GITHUB_SHA}:infra/packaging/deb_floor_proof.sh" > "$RUNNER_TEMP/deb_floor_proof.sh"' <<<"$step" &&
        grep -qE '^ +"\$RUNNER_TEMP/deb_floor_proof\.sh" debian:trixie ' <<<"$step"
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

@test "#2553 — both deb legs build on the same Ubuntu release, and the job runs on the leg's runner" {
    amd64="$(deb_runner "$WORKFLOW" amd64)"
    arm64="$(deb_runner "$WORKFLOW" arm64)"
    names_a_release "$arm64"
    same_release "$amd64" "$arm64" || {
        printf 'the deb legs build on %q (amd64) and %q (arm64). Two releases mean\n' "$amd64" "$arm64" >&2
        printf 'two glibc floors for one version number (#2553).\n' >&2
        return 1
    }

    # The matrix values pin nothing unless the job actually runs on them.
    runs_on="$(deb_runs_on "$WORKFLOW")"
    [ "$runs_on" = '${{ matrix.runner }}' ] || {
        printf 'the deb job runs on %q, not on its matrix leg'"'"'s runner — the pins\n' "$runs_on" >&2
        printf 'above are dead and the build floats again (#2553).\n' >&2
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

@test "#2553 — neither the floor proof nor an upload can be skipped past" {
    floor="$(deb_steps "$WORKFLOW" 'deb_floor_proof\.sh')"
    no_escape "$floor" || {
        printf 'the floor step carries an if: or continue-on-error: — a failure there\n' >&2
        printf 'would no longer stop the leg before it uploads (#2553):\n%s\n' "$floor" >&2
        return 1
    }
    uploads="$(deb_steps "$WORKFLOW" 'uses: actions/upload-artifact@')"
    no_escape "$uploads" || {
        printf 'an upload step carries an if: or continue-on-error: — it could upload\n' >&2
        printf 'after the floor proof failed (#2553):\n%s\n' "$uploads" >&2
        return 1
    }
}

@test "#2553 — the floor proof runs the dispatched ref's copy, so a repair of an old tag can run it" {
    floor_from_dispatched_ref "$WORKFLOW" || {
        printf 'the floor step does not take deb_floor_proof.sh from GITHUB_SHA. A repair\n' >&2
        printf 'dispatch checks out the TAG, and no tag before #2553 carries the script:\n' >&2
        printf 'the step would die 127 on the repair of 1.6.2 itself.\n' >&2
        deb_steps "$WORKFLOW" 'deb_floor_proof\.sh' >&2
        return 1
    }
}

@test "#2553 — RED: the predicates reject each way the gate can be undone" {
    refute names_a_release ubuntu-latest
    refute names_a_release ubuntu-24.04-latest
    refute same_release ubuntu-26.04 ubuntu-24.04-arm
    refute same_release "" ""
    refute no_escape ""

    # POSITIVE controls: predicates broken into always-false would report
    # every RED below as a pass.
    names_a_release ubuntu-24.04
    names_a_release ubuntu-24.04-arm
    same_release ubuntu-24.04 ubuntu-24.04-arm

    local f="$BATS_TEST_TMPDIR/release.yml"
    cat > "$f" <<'EOF'
jobs:
  deb:
    runs-on: ${{ matrix.runner }}
    steps:
      - name: Floor
        run: |
          git show "${GITHUB_SHA}:infra/packaging/deb_floor_proof.sh" > "$RUNNER_TEMP/deb_floor_proof.sh"
          "$RUNNER_TEMP/deb_floor_proof.sh" debian:trixie "$deb" "$client"
      - name: Upload .deb artifact
        uses: actions/upload-artifact@0000000000000000000000000000000000000000 # v0
  arch:
    steps: []
EOF
    [ "$(deb_runs_on "$f")" = '${{ matrix.runner }}' ]
    floor_before_upload "$f"
    no_escape "$(deb_steps "$f" 'deb_floor_proof\.sh')"
    no_escape "$(deb_steps "$f" 'uses: actions/upload-artifact@')"
    floor_from_dispatched_ref "$f"

    # A job that ignores its matrix.
    sed 's/runs-on: .*/runs-on: ubuntu-latest/' "$f" > "$f.runs-on"
    [ "$(deb_runs_on "$f.runs-on")" = ubuntu-latest ]

    # The proof after the upload.
    cat > "$f.late" <<'EOF'
jobs:
  deb:
    steps:
      - name: Upload .deb artifact
        uses: actions/upload-artifact@0000000000000000000000000000000000000000 # v0
      - name: Floor
        run: '"$RUNNER_TEMP/deb_floor_proof.sh" debian:trixie "$deb" "$client"'
EOF
    run floor_before_upload "$f.late"
    [ "$status" -ne 0 ]

    # The proof in the NEXT job is not in the deb job at all.
    cat > "$f.next" <<'EOF'
jobs:
  deb:
    steps:
      - name: Upload .deb artifact
        uses: actions/upload-artifact@0000000000000000000000000000000000000000 # v0
  floor:
    steps:
      - run: '"$RUNNER_TEMP/deb_floor_proof.sh" debian:trixie "$deb" "$client"'
EOF
    run floor_before_upload "$f.next"
    [ "$status" -ne 0 ]

    # The proof commented out.
    awk '/"\$RUNNER_TEMP\/deb_floor_proof\.sh" debian:trixie/ { sub(/"/, "# \"") } { print }' "$f" > "$f.commented"
    grep -q '# "\$RUNNER_TEMP/deb_floor_proof.sh" debian:trixie' "$f.commented"
    run floor_before_upload "$f.commented"
    [ "$status" -ne 0 ]

    # An escape on the floor step, and one on the upload.
    awk '{ print } /- name: Floor$/ { print "        continue-on-error: true" }' "$f" > "$f.coe"
    refute no_escape "$(deb_steps "$f.coe" 'deb_floor_proof\.sh')"
    awk '{ print } /- name: Upload/ { print "        if: always()" }' "$f" > "$f.if"
    refute no_escape "$(deb_steps "$f.if" 'uses: actions/upload-artifact@')"

    # The tag's copy instead of the dispatched one.
    awk '/git show/ { next } { sub(/"\$RUNNER_TEMP\/deb_floor_proof\.sh"/, "infra/packaging/deb_floor_proof.sh"); print }' "$f" > "$f.tagcopy"
    floor_before_upload "$f.tagcopy"
    refute floor_from_dispatched_ref "$f.tagcopy"
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
