#!/usr/bin/env bats
#
# issue 2570 — the SHA256SUMS attached to every release, in two halves.
#
#   1. infra/packaging/sha256sums.sh, the logic: published names from the API
#      listing, every built file cross-checked against a published digest,
#      SHA256SUMS itself never listed. Pure shell, exercised on real files.
#   2. release.yml's publish job, the wiring: the step exists, reads the
#      release back AFTER the upload, uploads the result, and cannot be
#      skipped past. Read off the recipe with comment lines dropped, so a
#      step that survives only as a comment does not count.
#
# What these cases CANNOT claim: that the step passes on a real release. In
# particular, that the API returns every digest the moment the upload call
# returns is GitHub's behaviour, not something a fixture can show — the
# script refuses an empty digest, so if that ever fails it fails red.

load ../bats_helpers

setup() {
    REPO_SRC="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    SCRIPT="$REPO_SRC/infra/packaging/sha256sums.sh"
    WORKFLOW="$REPO_SRC/.github/workflows/release.yml"

    # A downloaded-artifacts tree as publish sees it, one subdir per artifact.
    ASSETS="$BATS_TEST_TMPDIR/assets"
    mkdir -p "$ASSETS/grappa-deb-amd64" "$ASSETS/grappa-arch"
    LISTING="$BATS_TEST_TMPDIR/listing.tsv"
    : > "$LISTING"
}

# Write <content> to an attached file under the assets tree.
built() {
    printf '%s\n' "$2" > "$ASSETS/$1"
}

# The bare sha256 hex of a file.
hex_of() {
    local out
    out="$(sha256sum "$1")"
    printf '%s' "${out%% *}"
}

# Add one release asset to the API listing: <published name> <file whose
# bytes the release holds under that name>.
published() {
    printf '%s\tsha256:%s\n' "$1" "$(hex_of "$2")" >> "$LISTING"
}

# A release as GitHub holds it after the upload, with both renames measured on
# real releases: `.SRCINFO` -> `default.SRCINFO` (v1.6.2) and `~` -> `.` on a
# pre-release (v1.3.0-rc2).
seed_release() {
    built grappa-deb-amd64/grappa_1.7.0~rc1_amd64.deb 'deb payload'
    built grappa-arch/.SRCINFO 'srcinfo payload'
    built grappa-arch/shottino-debug-0.3.1-1-x86_64.pkg.tar.zst 'debug payload'
    published grappa_1.7.0.rc1_amd64.deb "$ASSETS/grappa-deb-amd64/grappa_1.7.0~rc1_amd64.deb"
    published default.SRCINFO "$ASSETS/grappa-arch/.SRCINFO"
    published shottino-debug-0.3.1-1-x86_64.pkg.tar.zst \
        "$ASSETS/grappa-arch/shottino-debug-0.3.1-1-x86_64.pkg.tar.zst"
}

@test "issue 2570 — SHA256SUMS names the PUBLISHED assets and sha256sum -c accepts it" {
    seed_release

    run "$SCRIPT" "$ASSETS" < "$LISTING"
    [ "$status" -eq 0 ]

    # Sorted by name, one `<hex><two spaces><name>` line per asset.
    expected="$(printf '%s  %s\n' \
        "$(hex_of "$ASSETS/grappa-arch/.SRCINFO")" default.SRCINFO \
        "$(hex_of "$ASSETS/grappa-deb-amd64/grappa_1.7.0~rc1_amd64.deb")" grappa_1.7.0.rc1_amd64.deb \
        "$(hex_of "$ASSETS/grappa-arch/shottino-debug-0.3.1-1-x86_64.pkg.tar.zst")" \
        shottino-debug-0.3.1-1-x86_64.pkg.tar.zst)"
    [ "$output" = "$expected" ]

    # The outcome a packager depends on: the file verifies the assets as they
    # are named on the download page, not as the build named them.
    dl="$BATS_TEST_TMPDIR/download"
    mkdir -p "$dl"
    cp "$ASSETS/grappa-deb-amd64/grappa_1.7.0~rc1_amd64.deb" "$dl/grappa_1.7.0.rc1_amd64.deb"
    cp "$ASSETS/grappa-arch/.SRCINFO" "$dl/default.SRCINFO"
    printf '%s\n' "$output" > "$dl/SHA256SUMS"
    (cd "$dl" && sha256sum -c --ignore-missing SHA256SUMS)
}

@test "issue 2570 — SHA256SUMS never lists itself, so a re-run's stale copy drops out" {
    seed_release
    # A repair dispatch finds the previous run's SHA256SUMS on the release.
    printf 'SHA256SUMS\tsha256:%064d\n' 0 >> "$LISTING"

    run "$SCRIPT" "$ASSETS" < "$LISTING"
    [ "$status" -eq 0 ]
    refute grep -q 'SHA256SUMS' <<<"$output"
    [ "$(grep -c '' <<<"$output")" -eq 3 ]
}

@test "issue 2570 — an asset this run did not build is still covered: the file describes the release" {
    seed_release
    # A repair whose rpm leg failed: the release keeps the earlier run's rpm.
    old="$BATS_TEST_TMPDIR/old.rpm"
    printf 'an earlier run\n' > "$old"
    published grappa-1.7.0~rc1-1.x86_64.rpm "$old"

    run "$SCRIPT" "$ASSETS" < "$LISTING"
    [ "$status" -eq 0 ]
    grep -qx "$(hex_of "$old")  grappa-1.7.0~rc1-1.x86_64.rpm" <<<"$output"
}

@test "issue 2570 — a built file the release does not hold is refused, naming the file" {
    seed_release
    # The release carries different bytes under the deb's name.
    printf 'a different deb\n' > "$BATS_TEST_TMPDIR/other.deb"
    grep -v '^grappa_1.7.0.rc1_amd64.deb' "$LISTING" > "$LISTING.new"
    mv "$LISTING.new" "$LISTING"
    published grappa_1.7.0.rc1_amd64.deb "$BATS_TEST_TMPDIR/other.deb"

    run "$SCRIPT" "$ASSETS" < "$LISTING"
    [ "$status" -eq 1 ]
    [[ "$output" == *"grappa-deb-amd64/grappa_1.7.0~rc1_amd64.deb"* ]]
    [[ "$output" == *"matches no asset on the release"* ]]
}

@test "issue 2570 — an asset without a usable digest is refused, never summed as blank" {
    seed_release
    for bad in '' 'md5:0cc175b9c0f1b6a831c399e269772661' \
        "sha256:$(printf '%063d' 0)" "sha256:$(printf '%064d' 0 | tr 0 A)"; do
        cp "$LISTING" "$LISTING.bad"
        printf 'PKGBUILD\t%s\n' "$bad" >> "$LISTING.bad"
        run "$SCRIPT" "$ASSETS" < "$LISTING.bad"
        [ "$status" -eq 1 ] || {
            printf 'digest %q was accepted\n' "$bad" >&2
            return 1
        }
        [[ "$output" == *"asset PKGBUILD has no sha256 digest"* ]]
    done
}

@test "issue 2570 — nothing to sum, or nothing to check, is refused" {
    seed_release

    # A release holding only SHA256SUMS.
    printf 'SHA256SUMS\tsha256:%064d\n' 0 > "$LISTING.only"
    run "$SCRIPT" "$ASSETS" < "$LISTING.only"
    [ "$status" -eq 1 ]
    [[ "$output" == *"nothing to sum"* ]]

    # No attached file to cross-check: the check would pass vacuously.
    empty="$BATS_TEST_TMPDIR/empty"
    mkdir -p "$empty"
    run "$SCRIPT" "$empty" < "$LISTING"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no attached file"* ]]

    # A blank listing line: no name to publish a sum under.
    printf '\n' > "$LISTING.noname"
    run "$SCRIPT" "$ASSETS" < "$LISTING.noname"
    [ "$status" -eq 1 ]
    [[ "$output" == *"carries no asset name"* ]]
}

@test "issue 2570 — usage errors exit 2" {
    run "$SCRIPT" < "$LISTING"
    [ "$status" -eq 2 ]
    run "$SCRIPT" "$BATS_TEST_TMPDIR/no-such-dir" < "$LISTING"
    [ "$status" -eq 2 ]
}

# ── release.yml wiring ──────────────────────────────────────────────────────

# The publish job's lines, from its key to the next job key. Comment lines are
# dropped: a commented-out step is not a step.
publish_job() {
    awk '/^  publish:$/ { on = 1; print; next }
         on && /^  [a-z][a-z0-9_-]*:$/ { exit }
         on && !/^[[:space:]]*#/' "$1"
}

# Every step of the publish job that has a line matching the pattern, whole.
publish_steps() {
    publish_job "$1" | awk -v pat="$2" '
        function flush() { if (hit) printf "%s", buf; buf = ""; hit = 0 }
        /^      - / { flush() }
        { buf = buf $0 "\n" }
        $0 ~ pat { hit = 1 }
        END { flush() }'
}

# The step reads the release back from the API, sums it, and uploads the file.
sums_step_wired() {
    local step
    step="$(publish_steps "$1" 'infra/packaging/sha256sums\.sh')"
    grep -qF 'gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}" --jq '"'"'.assets[] | [.name, (.digest // "")] | @tsv'"'"' > "$RUNNER_TEMP/release-assets.tsv"' <<<"$step" &&
        grep -qE '^ +infra/packaging/sha256sums\.sh assets < "\$RUNNER_TEMP/release-assets\.tsv" > "\$RUNNER_TEMP/SHA256SUMS"$' <<<"$step" &&
        grep -qF 'gh release upload "${RELEASE_TAG}" --repo "${GITHUB_REPOSITORY}" --clobber "$RUNNER_TEMP/SHA256SUMS"' <<<"$step"
}

# The sums are taken after the attach step's upload, never before it.
sums_after_attach() {
    publish_job "$1" | awk '
        /gh release create / && !attach { attach = NR }
        /infra\/packaging\/sha256sums\.sh / && !sums { sums = NR }
        END { exit !(attach && sums && attach < sums) }'
}

# No step-level `if:` and no `continue-on-error:`. Empty input is not a step.
no_escape() {
    [ -n "$1" ] && refute grep -qE '^      (- |  )(if|continue-on-error):' <<<"$1"
}

@test "issue 2570 — publish reads the release back, sums it, and attaches SHA256SUMS" {
    sums_step_wired "$WORKFLOW" || {
        printf 'release.yml'"'"'s publish job has no live step that reads the release\n' >&2
        printf 'back from the API, runs sha256sums.sh over it and uploads SHA256SUMS.\n' >&2
        publish_steps "$WORKFLOW" 'sha256sums|SHA256SUMS' >&2
        return 1
    }
}

@test "issue 2570 — the sums are taken after the upload, and the step cannot be skipped past" {
    sums_after_attach "$WORKFLOW" || {
        printf 'sha256sums.sh does not run after `gh release create` in publish: read\n' >&2
        printf 'before the upload, the listing misses this run'"'"'s assets.\n' >&2
        return 1
    }
    step="$(publish_steps "$WORKFLOW" 'infra/packaging/sha256sums\.sh')"
    no_escape "$step" || {
        printf 'the SHA256SUMS step carries an if: or continue-on-error::\n%s\n' "$step" >&2
        return 1
    }
}

@test "issue 2570 — RED: the predicates reject a step kept only as a comment, or misplaced" {
    refute no_escape ""

    local live="$BATS_TEST_TMPDIR/live.yml"
    cat > "$live" <<'EOF'
jobs:
  publish:
    steps:
      - name: Attach
        run: |
          gh release create "${RELEASE_TAG}" "${assets[@]}"
      - name: Attach SHA256SUMS
        run: |
          # infra/packaging/sha256sums.sh turns the listing into SHA256SUMS
          gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}" --jq '.assets[] | [.name, (.digest // "")] | @tsv' > "$RUNNER_TEMP/release-assets.tsv"
          infra/packaging/sha256sums.sh assets < "$RUNNER_TEMP/release-assets.tsv" > "$RUNNER_TEMP/SHA256SUMS"
          gh release upload "${RELEASE_TAG}" --repo "${GITHUB_REPOSITORY}" --clobber "$RUNNER_TEMP/SHA256SUMS"
  apt-repo:
    steps: []
EOF
    # POSITIVE control: predicates broken into always-false would report
    # every RED below as a pass.
    sums_step_wired "$live"
    sums_after_attach "$live"
    no_escape "$(publish_steps "$live" 'infra/packaging/sha256sums\.sh')"

    # The key line deleted, its comment kept.
    local commented="$BATS_TEST_TMPDIR/commented.yml"
    grep -v '^          infra/packaging/sha256sums\.sh assets' "$live" > "$commented"
    grep -q 'sha256sums.sh turns the listing' "$commented"
    refute sums_step_wired "$commented"
    refute sums_after_attach "$commented"

    # The step moved ahead of the upload.
    local early="$BATS_TEST_TMPDIR/early.yml"
    awk '/^      - name: Attach$/ { hold = 1 }
         /^      - name: Attach SHA256SUMS$/ { hold = 0 }
         hold { buf = buf $0 "\n"; next }
         /^  apt-repo:$/ { printf "%s", buf }
         { print }' "$live" > "$early"
    sums_step_wired "$early"
    refute sums_after_attach "$early"

    # A step-level escape hatch.
    local escape="$BATS_TEST_TMPDIR/escape.yml"
    awk '{ print } /^      - name: Attach SHA256SUMS$/ { print "        continue-on-error: true" }' "$live" > "$escape"
    refute no_escape "$(publish_steps "$escape" 'infra/packaging/sha256sums\.sh')"
}
