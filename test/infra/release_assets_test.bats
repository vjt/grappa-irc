#!/usr/bin/env bats
#
# Bats suite for infra/packaging/release_assets.sh (#573).
#
# The release publish job used to inline its "collect what built" find glob
# and had NO notion of what SHOULD have built — so two releases (v0.8.0,
# v0.9.0) shipped without their .rpm and the artifact list was
# indistinguishable from a complete one. This script is the SSOT of the
# EXPECTED release asset set; both the attach glob (`found`) and the
# completeness audit (`missing`/`notice`/`apply-body`) derive from that one
# list, so a silent hole is now impossible.
#
# Scope: the SET LOGIC (expected vs arrived) + the idempotent partial-release
# body marker — the bug-prone parts that must not live untested in YAML.
# Pure filesystem + string logic; no docker, no network, no mix.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    SCRIPT="$REPO_SRC/infra/packaging/release_assets.sh"

    # A downloaded-artifacts tree, nested per-artifact subdir (the layout
    # download-artifact usually produces).
    ASSETS="$BATS_TEST_TMPDIR/assets"
    mkdir -p "$ASSETS/grappa-deb" "$ASSETS/grappa-rpm" "$ASSETS/grappa-arch"
}

# Populate a COMPLETE, realistic asset tree (every expected kind present).
seed_complete() {
    : > "$ASSETS/grappa-deb/grappa_0.8.0_amd64.deb"
    : > "$ASSETS/grappa-rpm/grappa-0.8.0-1.x86_64.rpm"
    : > "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    : > "$ASSETS/grappa-arch/PKGBUILD"
    : > "$ASSETS/grappa-arch/.SRCINFO"
}

@test "found: a complete nested tree lists every expected asset file" {
    seed_complete
    run "$SCRIPT" found "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'grappa_0.8.0_amd64.deb'
    echo "$output" | grep -q 'grappa-0.8.0-1.x86_64.rpm'
    echo "$output" | grep -q 'grappa-0.8.0-1-x86_64.pkg.tar.zst'
    echo "$output" | grep -q '/PKGBUILD$'
    echo "$output" | grep -q '/.SRCINFO$'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 5 ]
}

@test "found: matches by NAME at any depth, not by a path-coupled glob (flat layout)" {
    # Regression guard for run 30399152630: download-artifact unpacked the
    # green artifact FLAT into assets/, so a path-coupled glob matched
    # nothing. Names, at any depth, must still be found.
    : > "$ASSETS/grappa_0.8.0_amd64.deb"
    run "$SCRIPT" found "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'grappa_0.8.0_amd64.deb'
}

@test "missing: a complete set reports nothing" {
    seed_complete
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "missing: a dropped .rpm is named (the #573 instance)" {
    seed_complete
    rm "$ASSETS/grappa-rpm/grappa-0.8.0-1.x86_64.rpm"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ "$output" = "RPM package (.rpm)" ]
}

@test "missing: a dead Arch leg names all three of its outputs" {
    seed_complete
    rm "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    rm "$ASSETS/grappa-arch/PKGBUILD"
    rm "$ASSETS/grappa-arch/.SRCINFO"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'Arch package (.pkg.tar.zst)'
    echo "$output" | grep -q 'Arch PKGBUILD recipe'
    echo "$output" | grep -q 'Arch .SRCINFO recipe'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 3 ]
}

@test "missing: an empty assets tree names every expected kind" {
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 5 ]
}

@test "notice: a complete set produces no marker block" {
    seed_complete
    run "$SCRIPT" notice "$ASSETS"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "notice: a partial set emits a sentinel-delimited block naming the gap" {
    seed_complete
    rm "$ASSETS/grappa-rpm/grappa-0.8.0-1.x86_64.rpm"
    run "$SCRIPT" notice "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q '<!-- grappa:partial-release:start -->'
    echo "$output" | grep -q '<!-- grappa:partial-release:end -->'
    echo "$output" | grep -q 'RPM package (.rpm)'
}

@test "apply-body: a partial set prepends the block, and is idempotent" {
    seed_complete
    rm "$ASSETS/grappa-rpm/grappa-0.8.0-1.x86_64.rpm"
    printf '## What'\''s Changed\n\n- a real changelog line\n' > "$BATS_TEST_TMPDIR/body.md"

    run bash -c "'$SCRIPT' apply-body '$ASSETS' < '$BATS_TEST_TMPDIR/body.md'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" > "$BATS_TEST_TMPDIR/body2.md"
    # block present exactly once, changelog preserved
    [ "$(grep -c 'grappa:partial-release:start' "$BATS_TEST_TMPDIR/body2.md")" -eq 1 ]
    grep -q 'a real changelog line' "$BATS_TEST_TMPDIR/body2.md"
    grep -q 'RPM package (.rpm)' "$BATS_TEST_TMPDIR/body2.md"

    # Feeding the already-marked body back in must NOT double the block.
    run bash -c "'$SCRIPT' apply-body '$ASSETS' < '$BATS_TEST_TMPDIR/body2.md'"
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | grep -c 'grappa:partial-release:start')" -eq 1 ]
}

@test "apply-body: a now-complete set strips a stale marker block (the repair converse)" {
    # A prior partial publish left a marker; the repair dispatch rebuilt the
    # missing leg, so the set is complete now — the marker must be removed.
    seed_complete
    {
        echo '<!-- grappa:partial-release:start -->'
        echo '> [!WARNING]'
        echo '> **Partial release.** Missing: RPM package (.rpm)'
        echo '<!-- grappa:partial-release:end -->'
        echo ''
        echo '## What'\''s Changed'
        echo ''
        echo '- a real changelog line'
    } > "$BATS_TEST_TMPDIR/body.md"

    run bash -c "'$SCRIPT' apply-body '$ASSETS' < '$BATS_TEST_TMPDIR/body.md'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q 'a real changelog line'
    refute grep -q 'grappa:partial-release' <<<"$output"
}

@test "usage: an unknown subcommand fails loudly" {
    run "$SCRIPT" frobnicate "$ASSETS"
    [ "$status" -ne 0 ]
}
