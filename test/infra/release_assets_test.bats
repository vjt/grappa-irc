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
#
# #1447 slice B — the kinds are matched by the PACKAGE NAME, not by extension
# alone. From this release the client ships as its own artifact, so a bare
# `*.deb` would be satisfied by EITHER package: a release that built the
# bouncer and lost the client would look complete and say nothing. That is the
# same failure #573 was filed for, one package later.
#
# issue 2129 — the SAME trap on a second axis. `deb` and `rpm` are now matrixed
# over two architectures, so `grappa_*.deb` is satisfied by the arm64 file just
# as well as by the amd64 one: a run where amd64 died and arm64 built would
# report every kind present and #1591's refuse-to-create gate would pass on
# half a release. The kinds are therefore scoped by NAME **and ARCH**, and
# "complete" below means BOTH legs of both matrixed jobs arrived.
#
# The arch spellings are not a choice: they are what the pinned nfpm 2.43.0
# actually writes, measured (deb keeps `amd64`/`arm64`; rpm translates to
# `x86_64`/`aarch64`). `arch` stays single-leg — Arch Linux has no official ARM
# port — so its four recipe kinds and two packages carry no arch axis.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    SCRIPT="$REPO_SRC/infra/packaging/release_assets.sh"

    # A downloaded-artifacts tree, nested per-artifact subdir (the layout
    # download-artifact usually produces). One subdir per upload-artifact
    # NAME, and since issue 2129 the matrixed jobs spell their arch into that
    # name — two legs uploading under one name collide.
    ASSETS="$BATS_TEST_TMPDIR/assets"
    mkdir -p \
        "$ASSETS/grappa-deb-amd64" "$ASSETS/grappa-deb-arm64" \
        "$ASSETS/grappa-rpm-x86_64" "$ASSETS/grappa-rpm-aarch64" \
        "$ASSETS/grappa-arch"
}

# Populate a COMPLETE, realistic asset tree (every expected kind present).
seed_complete() {
    seed_deb_amd64
    seed_rpm_x86_64
    seed_deb_arm64
    seed_rpm_aarch64
    : > "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    : > "$ASSETS/grappa-arch/PKGBUILD"
    : > "$ASSETS/grappa-arch/.SRCINFO"
    : > "$ASSETS/grappa-arch/shottino-0.3.0-1-x86_64.pkg.tar.zst"
    # The client's AUR recipe, staged under a distinct BASENAME: a release
    # asset is keyed by basename, so a second file called PKGBUILD would
    # overwrite the first (the publish fallback uploads with --clobber).
    : > "$ASSETS/grappa-arch/shottino.PKGBUILD"
    : > "$ASSETS/grappa-arch/shottino.SRCINFO"
}

# One helper per MATRIX LEG, so a test can kill exactly one leg and the
# fixture cannot drift from what that leg really uploads. The client package
# rides its own version line (#1447) but the same leg produces both — a dead
# runner loses the pair, which is why they are seeded together.
#
# Named as the real builders name them, measured against the pinned nfpm
# 2.43.0: `<name>_<ver>_<arch>.deb` and `<name>-<ver>-1.<arch>.rpm` (makepkg
# writes `<name>-<ver>-1-<arch>.pkg.tar.zst`).
seed_deb_amd64() {
    : > "$ASSETS/grappa-deb-amd64/grappa_0.8.0_amd64.deb"
    : > "$ASSETS/grappa-deb-amd64/shottino_0.3.0_amd64.deb"
}

seed_deb_arm64() {
    : > "$ASSETS/grappa-deb-arm64/grappa_0.8.0_arm64.deb"
    : > "$ASSETS/grappa-deb-arm64/shottino_0.3.0_arm64.deb"
}

seed_rpm_x86_64() {
    : > "$ASSETS/grappa-rpm-x86_64/grappa-0.8.0-1.x86_64.rpm"
    : > "$ASSETS/grappa-rpm-x86_64/shottino-0.3.0-1.x86_64.rpm"
}

seed_rpm_aarch64() {
    : > "$ASSETS/grappa-rpm-aarch64/grappa-0.8.0-1.aarch64.rpm"
    : > "$ASSETS/grappa-rpm-aarch64/shottino-0.3.0-1.aarch64.rpm"
}

@test "found: a complete nested tree lists every expected asset file" {
    seed_complete
    run "$SCRIPT" found "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'grappa_0.8.0_amd64.deb'
    echo "$output" | grep -q 'grappa_0.8.0_arm64.deb'
    echo "$output" | grep -q 'grappa-0.8.0-1.x86_64.rpm'
    echo "$output" | grep -q 'grappa-0.8.0-1.aarch64.rpm'
    echo "$output" | grep -q 'grappa-0.8.0-1-x86_64.pkg.tar.zst'
    echo "$output" | grep -q '/PKGBUILD$'
    echo "$output" | grep -q '/.SRCINFO$'
    echo "$output" | grep -q 'shottino_0.3.0_amd64.deb'
    echo "$output" | grep -q 'shottino_0.3.0_arm64.deb'
    echo "$output" | grep -q 'shottino-0.3.0-1.x86_64.rpm'
    echo "$output" | grep -q 'shottino-0.3.0-1.aarch64.rpm'
    echo "$output" | grep -q 'shottino-0.3.0-1-x86_64.pkg.tar.zst'
    echo "$output" | grep -q '/shottino.PKGBUILD$'
    echo "$output" | grep -q '/shottino.SRCINFO$'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 14 ]
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
    rm "$ASSETS/grappa-rpm-x86_64/grappa-0.8.0-1.x86_64.rpm"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ "$output" = "RPM package, bouncer, x86_64 (.rpm)" ]
}

@test "missing: a client package that did not build is named, not absorbed (#1447)" {
    # The whole reason the kinds are name-scoped. The bouncer's .deb is right
    # there, so an extension-only `*.deb` pattern would find it, call the kind
    # satisfied, and publish a release with no client — silently. A release
    # that loses an artifact it advertises must FAIL LOUDLY.
    seed_complete
    rm "$ASSETS/grappa-deb-amd64/shottino_0.3.0_amd64.deb"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ "$output" = "Debian package, client, amd64 (.deb)" ]
}

@test "missing: losing the client's whole leg names every one of its packages (#1447)" {
    seed_complete
    rm "$ASSETS/grappa-deb-amd64/shottino_0.3.0_amd64.deb"
    rm "$ASSETS/grappa-deb-arm64/shottino_0.3.0_arm64.deb"
    rm "$ASSETS/grappa-rpm-x86_64/shottino-0.3.0-1.x86_64.rpm"
    rm "$ASSETS/grappa-rpm-aarch64/shottino-0.3.0-1.aarch64.rpm"
    rm "$ASSETS/grappa-arch/shottino-0.3.0-1-x86_64.pkg.tar.zst"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'Debian package, client, amd64 (.deb)'
    echo "$output" | grep -q 'Debian package, client, arm64 (.deb)'
    echo "$output" | grep -q 'RPM package, client, x86_64 (.rpm)'
    echo "$output" | grep -q 'RPM package, client, aarch64 (.rpm)'
    echo "$output" | grep -q 'Arch package, client (.pkg.tar.zst)'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 5 ]
}

@test "missing: a dead amd64 leg is named while arm64 built (issue 2129)" {
    # THE half-set this axis exists for, and the one #1591 must refuse. The
    # arm64 files are right there, so an arch-blind `grappa_*.deb` /
    # `grappa-*.rpm` finds them, calls both kinds satisfied, and publishes a
    # release carrying no x86 package at all — silently, on the architecture
    # essentially every operator is on. Exactly #1447's absorption one axis
    # over.
    seed_complete
    rm "$ASSETS/grappa-deb-amd64"/*
    rm "$ASSETS/grappa-rpm-x86_64"/*
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'Debian package, bouncer, amd64 (.deb)'
    echo "$output" | grep -q 'Debian package, client, amd64 (.deb)'
    echo "$output" | grep -q 'RPM package, bouncer, x86_64 (.rpm)'
    echo "$output" | grep -q 'RPM package, client, x86_64 (.rpm)'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 4 ]
}

@test "missing: a dead arm64 leg is named while amd64 built (issue 2129)" {
    # The converse, and NOT a mirror of the test above: the pre-2129 patterns
    # were spelled against the amd64 names, so this direction is the one an
    # arch-blind table happens to get right for the wrong reason. Both
    # directions are asserted because the table is symmetric by construction
    # and a half-applied edit would leave exactly one of them blind.
    seed_complete
    rm "$ASSETS/grappa-deb-arm64"/*
    rm "$ASSETS/grappa-rpm-aarch64"/*
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'Debian package, bouncer, arm64 (.deb)'
    echo "$output" | grep -q 'Debian package, client, arm64 (.deb)'
    echo "$output" | grep -q 'RPM package, bouncer, aarch64 (.rpm)'
    echo "$output" | grep -q 'RPM package, client, aarch64 (.rpm)'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 4 ]
}

@test "missing: the Arch leg carries no arch axis — it is single-leg (issue 2129)" {
    # The deliberate non-goal, asserted so nobody "completes" the split later.
    # Arch Linux has no official ARM port, makepkg runs on a real x86_64 Arch
    # container and the pacman repository stays x86_64 — so a complete release
    # has ONE Arch package per program, and a table that grew an
    # `*-aarch64.pkg.tar.zst` kind would mark every release partial forever.
    seed_complete
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ -z "$output" ]

    run "$SCRIPT" found "$ASSETS"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | grep -c 'pkg.tar.zst')" -eq 2 ]
}

@test "missing: a dead Arch leg names all three of its outputs" {
    seed_complete
    rm "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    rm "$ASSETS/grappa-arch/PKGBUILD"
    rm "$ASSETS/grappa-arch/.SRCINFO"
    rm "$ASSETS/grappa-arch/shottino-0.3.0-1-x86_64.pkg.tar.zst"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'Arch package, bouncer (.pkg.tar.zst)'
    echo "$output" | grep -q 'Arch package, client (.pkg.tar.zst)'
    echo "$output" | grep -q 'Arch PKGBUILD recipe, bouncer'
    echo "$output" | grep -q 'Arch .SRCINFO recipe, bouncer'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 4 ]
}

@test "missing: an empty assets tree names every expected kind" {
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 14 ]
}

@test "missing: the client's recipe is its own kind, not the bouncer's (#1447)" {
    # The two recipes are DIFFERENT files with different sentinels, staged
    # under different basenames precisely so one cannot stand in for the
    # other. An expected-kinds table that matched `PKGBUILD` alone would call
    # the pair complete with the client's recipe missing.
    seed_complete
    rm "$ASSETS/grappa-arch/shottino.PKGBUILD"
    rm "$ASSETS/grappa-arch/shottino.SRCINFO"
    run "$SCRIPT" missing "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q 'Arch PKGBUILD recipe, client'
    echo "$output" | grep -q 'Arch .SRCINFO recipe, client'
    [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 2 ]
}

@test "notice: a complete set produces no marker block" {
    seed_complete
    run "$SCRIPT" notice "$ASSETS"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "notice: a partial set emits a sentinel-delimited block naming the gap" {
    seed_complete
    rm "$ASSETS/grappa-rpm-x86_64/grappa-0.8.0-1.x86_64.rpm"
    run "$SCRIPT" notice "$ASSETS"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q '<!-- grappa:partial-release:start -->'
    echo "$output" | grep -q '<!-- grappa:partial-release:end -->'
    echo "$output" | grep -q 'RPM package, bouncer, x86_64 (.rpm)'
}

@test "apply-body: a partial set prepends the block, and is idempotent" {
    seed_complete
    rm "$ASSETS/grappa-rpm-x86_64/grappa-0.8.0-1.x86_64.rpm"
    printf '## What'\''s Changed\n\n- a real changelog line\n' > "$BATS_TEST_TMPDIR/body.md"

    run bash -c "'$SCRIPT' apply-body '$ASSETS' < '$BATS_TEST_TMPDIR/body.md'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" > "$BATS_TEST_TMPDIR/body2.md"
    # block present exactly once, changelog preserved
    [ "$(grep -c 'grappa:partial-release:start' "$BATS_TEST_TMPDIR/body2.md")" -eq 1 ]
    grep -q 'a real changelog line' "$BATS_TEST_TMPDIR/body2.md"
    grep -q 'RPM package, bouncer, x86_64 (.rpm)' "$BATS_TEST_TMPDIR/body2.md"

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

# ── publishable: creating a release is irreversible, topping one up is not ──
#
# #1591. `publish` runs on `!cancelled()`, so a red package leg still reached
# `gh release create` and PUBLISHED — a partial release, marked as such, but
# public. #504/#573 chose that deliberately and for a good reason: a distro
# breakage must not withhold the artifacts that built green. The reason holds
# for a release that ALREADY EXISTS, where attaching what built is the only
# way to complete it. It does not hold for the first run of a fresh tag, where
# the same rule turns "one leg failed" into a public artefact that deleting
# the tag does not retract.
#
# So the axis is not completeness alone — it is completeness × whether the
# release object already exists. That decision lives here rather than in YAML
# because it is the SAME table the rest of this script owns, and because a
# two-variable rule inlined in a workflow step is exactly what #573 was filed
# about.

@test "publishable: a complete set may create a brand-new release" {
    seed_complete
    run "$SCRIPT" publishable "$ASSETS" absent
    [ "$status" -eq 0 ]
}

@test "publishable: a complete set may top up an existing release" {
    seed_complete
    run "$SCRIPT" publishable "$ASSETS" present
    [ "$status" -eq 0 ]
}

@test "publishable: a PARTIAL set must NOT create a new release (#1591)" {
    # The irreversible act. `gh release create` publishes; deleting the tag
    # afterwards does not retract what was published.
    seed_complete
    rm "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    run "$SCRIPT" publishable "$ASSETS" absent
    [ "$status" -ne 0 ]
    # It must name the gap, not just refuse: the operator's next move is to
    # fix that leg and re-run, and a bare refusal makes them go find out which.
    grep -q 'Arch package, bouncer' <<<"$output"
}

@test "publishable: an arm64-only set must NOT create a new release (issue 2129)" {
    # The reason the arch axis had to land in the SAME commit as the matrix.
    # Before it, this exact tree — a green arm64 leg beside a red amd64 one —
    # satisfied every expected kind, so #1591's gate returned 0 and a release
    # carrying no x86 package got CREATED. Publication cannot be retracted, so
    # the loud red of a failed leg would have become a silent partial release.
    seed_complete
    rm "$ASSETS/grappa-deb-amd64"/*
    rm "$ASSETS/grappa-rpm-x86_64"/*
    run "$SCRIPT" publishable "$ASSETS" absent
    [ "$status" -ne 0 ]
    # Name the gap by ARCH, not just by format: "the .deb is missing" sends the
    # operator to a job that is green.
    grep -q 'Debian package, bouncer, amd64' <<<"$output"
    grep -q 'RPM package, bouncer, x86_64' <<<"$output"
}

@test "publishable: a PARTIAL set MAY still top up an existing release (#504/#573 preserved)" {
    # The converse, and the reason this is a two-variable rule rather than a
    # completeness check: the repair dispatch of #573 (b) exists precisely to
    # attach a leg that failed the first time, and it runs against a release
    # that is already public. Refusing here would break the repair path in the
    # name of protecting a publication that has already happened.
    seed_complete
    rm "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    run "$SCRIPT" publishable "$ASSETS" present
    [ "$status" -eq 0 ]
}

@test "publishable: an unknown release state is refused, never read as 'present'" {
    # Fail closed on the permissive side. The workflow computes this from
    # `gh release view`, and a probe that errors for an unrelated reason (rate
    # limit, token scope) must not be silently read as "already public,
    # publish anyway".
    seed_complete
    rm "$ASSETS/grappa-arch/grappa-0.8.0-1-x86_64.pkg.tar.zst"
    for state in "" maybe yes PRESENT; do
        run "$SCRIPT" publishable "$ASSETS" "$state"
        [ "$status" -ne 0 ]
        # Named, so the refusal is distinguishable from the usage error an
        # absent subcommand produces — otherwise this case is green today,
        # against a script that has never heard of `publishable`.
        grep -qi 'release state' <<<"$output"
    done
}

@test "usage: an unknown subcommand fails loudly" {
    run "$SCRIPT" frobnicate "$ASSETS"
    [ "$status" -ne 0 ]
}
