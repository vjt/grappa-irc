#!/usr/bin/env bats
#
# Bats suite for GH #1447 — shottino has its OWN package, and since slice B the
# bouncer no longer ships the client binary at all.
#
# Slice A was deliberately additive: `grappa` still shipped /usr/bin/shottino,
# both packages owned that path, and they could NOT be co-installed — so the
# standalone package was built, inspected, and kept off the release. Slice B is
# the other half of that one decision: the bouncer drops the file, the takeover
# relations become true, and the client package is published.
#
# THE ORDER IS THE WHOLE POINT. Dropping the file without publishing the
# replacement would take the client away from everyone who has it today, and
# publishing without dropping would ship a pair that cannot be installed
# together. Neither half is shippable alone, which is why they are one slice.
#
# The upload derivation below survives from slice A with its polarity flipped.
# Then, a package's absence from every upload directory was the gate; now, the
# client package's OWN upload step is the property — publication is explicit,
# never a side effect of a glob widening.
#
# The other three properties are the ones that make the package a CLIENT
# package rather than a second copy of the bouncer: its own version line, one
# file, no maintainer scripts, no ERTS deps.
#
# Every derivation carries a floor — a derivation that matched nothing would
# make its assertion pass vacuously.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    PKG_DIR="$REPO_ROOT/infra/packaging"
    NFPM_SERVER="$PKG_DIR/nfpm.yaml"
    NFPM_CLIENT="$PKG_DIR/nfpm-shottino.yaml"
    VERSION_SH="$PKG_DIR/version.sh"
    BUILD_SH="$PKG_DIR/build.sh"
    WORKFLOW="$REPO_ROOT/.github/workflows/release.yml"
    VERSION_H="$REPO_ROOT/frontends/shottino/version.h"
    PKGBUILD="$PKG_DIR/aur/PKGBUILD"
    PKGBUILD_CLIENT="$PKG_DIR/aur/shottino/PKGBUILD"
    SRCINFO_CLIENT="$PKG_DIR/aur/shottino/.SRCINFO"
    REGEN="$PKG_DIR/aur/regen.sh"
}

# The `contents:` block of an nfpm config: from `contents:` to the next
# top-level key. Top-level keys sit at column 0, everything inside is deeper.
contents_block() {
    awk '/^contents:/ { f = 1; next } f && /^[a-z]/ { exit } f' "$1"
}

# Every `dst:` a config installs, one per line.
installed_paths() {
    contents_block "$1" | sed -n 's/^[[:space:]]*dst:[[:space:]]*//p'
}

# The directories the release workflow UPLOADS from — the dirname of every
# `path:` under an upload-artifact step. These are the directories a build
# output must stay out of to remain unpublished.
upload_dirs() {
    awk '
        /uses: actions\/upload-artifact/ { hit = 1 }
        hit && /^[[:space:]]+path:[[:space:]]/ {
            sub(/^[[:space:]]+path:[[:space:]]*/, "")
            sub(/\/[^\/]*$/, "")
            print
            hit = 0
        }
    ' "$WORKFLOW" | sort -u
}

# ── The pair that must land together ───────────────────────────────────────

@test "#1447 the workflow's upload globs are path-scoped, so publication is per-directory" {
    # The floor for the test below: if this derivation found nothing, "the
    # client package's directory is uploaded" would hold vacuously.
    run upload_dirs
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    [ "$(printf '%s\n' "$output" | wc -l)" -ge 2 ]
}

@test "#1447 the bouncer package no longer ships the client binary" {
    # THE assertion slice A could not make. Until the bouncer stops owning
    # /usr/bin/shottino, the standalone package's Replaces:/Breaks: describe a
    # takeover that has not happened and the two cannot be co-installed.
    run installed_paths "$NFPM_SERVER"
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    refute grep -qx '/usr/bin/shottino' <<<"$output"
}

@test "#1447 the client package IS published, from its own output directory" {
    # The converse of slice A's gate, and deliberately not "some glob happens
    # to reach it": the client's directory has an upload step of its own, so
    # publishing it stays a decision someone had to write down.
    grep -q 'SHOTTINO_OUT_DIR' "$BUILD_SH"

    client_out="$(sed -n 's/^SHOTTINO_OUT_DIR="\${SHOTTINO_OUT_DIR:-\${REPO_ROOT}\/\(.*\)}"$/\1/p' "$BUILD_SH")"
    [ -n "$client_out" ]

    upload_dirs | grep -qxF "$client_out"
}

@test "#1447 the bouncer recommends the client, per format, or an upgrade removes it" {
    # NOT cosmetic, and the reason is the upgrade path: the file leaves the
    # bouncer package in this release, so `apt upgrade` on a host that has
    # shottino today would delete /usr/bin/shottino and pull nothing back.
    # A Recommends is installed by default on Debian and by dnf's weak deps on
    # Fedora, so the replacement arrives in the same transaction. Per format,
    # because the two override blocks are disjoint (see nfpm.yaml).
    deb_block="$(awk '/^  deb:/ { f = 1; next } f && /^  [a-z]/ { exit } f' "$NFPM_SERVER")"
    rpm_block="$(awk '/^  rpm:/ { f = 1; next } f && /^  [a-z]/ { exit } f' "$NFPM_SERVER")"
    [ -n "$deb_block" ]
    [ -n "$rpm_block" ]

    grep -qF -- '- shottino' <<<"$deb_block"
    grep -qF -- '- shottino' <<<"$rpm_block"
}

# ── The Arch recipe, where the same decision has different mechanics ────────

@test "#1447 the AUR client is a SECOND recipe, and only it installs the binary" {
    # NOT a split package, and the reason is measured: PKGBUILD(5) § PACKAGE
    # SPLITTING names the variables a package_*() may override and `pkgver` is
    # not one of them, so a split would stamp the client with the bouncer's
    # version — the exact disagreement the own-version-line ruling forbids.
    # Two version lines, two pkgbases.
    [ -f "$PKGBUILD_CLIENT" ]
    grep -qx 'pkgname=shottino' "$PKGBUILD_CLIENT"
    grep -qF 'usr/bin/shottino' "$PKGBUILD_CLIENT"

    # And the bouncer recipe neither builds nor installs it any more. Read off
    # the FUNCTION BODIES, not the file: the recipe names shottino in prose
    # (the optdepends pointer and its why-comment), and a whole-file grep would
    # be satisfied by that prose while the install line was still there.
    bouncer_pkg="$(awk '/^package\(\)/ { f = 1 } f { print } f && /^}/ { exit }' "$PKGBUILD")"
    bouncer_build="$(awk '/^build\(\)/ { f = 1 } f { print } f && /^}/ { exit }' "$PKGBUILD")"
    [ -n "$bouncer_pkg" ]
    [ -n "$bouncer_build" ]
    refute grep -qF 'usr/bin/shottino' <<<"$bouncer_pkg"
    refute grep -qF 'frontends/shottino' <<<"$bouncer_build"
}

@test "#1447 the AUR client recipe carries its OWN version sentinel, plus the tag that has the source" {
    # THE property that forced a second pkgbase. pkgver comes from the client
    # carrier; _grappaver names the tag that actually exists on GitHub, since
    # one repository ships both. Sentinels, not numbers — markers that
    # ../regen.sh has not run, NOT values makepkg catches: its pkgver lint
    # accepts '@' (#1592, measured).
    grep -qx 'pkgver=@SHOTTINO_VERSION@' "$PKGBUILD_CLIENT"
    grep -qx '_grappaver=@GRAPPA_VERSION@' "$PKGBUILD_CLIENT"
    refute grep -qx 'pkgver=@GRAPPA_VERSION@' "$PKGBUILD_CLIENT"

    # The bouncer's own sentinel is untouched by all this.
    grep -qx 'pkgver=@GRAPPA_VERSION@' "$PKGBUILD"
}

@test "#1447 the AUR client recipe does not drag the bouncer's build stack onto a client-only host" {
    # The whole point of #1447: a machine that wants the terminal client must
    # not need elixir, erlang or bun to get it. Derived from the bouncer's
    # makedepends rather than re-typed, so a new entry there is checked here.
    bouncer_makedeps="$(sed -n "s/^makedepends=(\(.*\))$/\1/p" "$PKGBUILD" | tr -d "'" )"
    [ -n "$bouncer_makedeps" ]

    # Compared against the client's DECLARATIONS, never its prose — the recipe
    # says in a comment that it wants none of these, and a comment is not a
    # dependency list. Every `depends=`/`makedepends=` line, sentinel included
    # so an empty match cannot pass vacuously.
    client_decls="$(grep -E '^(make)?depends=' "$PKGBUILD_CLIENT" || true)"
    [ -n "$client_decls" ]
    for dep in $bouncer_makedeps; do
        refute grep -qF "$dep" <<<"$client_decls"
    done
}

@test "#1447 the AUR bouncer recipe points at the client through optdepends" {
    # The Arch stand-in for Recommends: pacman has no weak dep that installs by
    # default, so the pointer is advisory BY CONSTRUCTION — but a user who
    # upgrades and finds the client gone must be told where it went.
    optdeps="$(awk '/^optdepends=\(/ { f = 1 } f { print } f && /\)$/ { exit }' "$PKGBUILD")"
    [ -n "$optdeps" ]
    grep -qF 'shottino' <<<"$optdeps"
}

@test "#1447 regen.sh derives BOTH recipes, or the second one publishes a sentinel" {
    # regen.sh is the ONE path that fills the sentinels. A second recipe it
    # does not know about would reach makepkg with `pkgver=@SHOTTINO_VERSION@`
    # — caught by makepkg's lint, but at release time, in CI, on a tag.
    grep -qF 'version.sh" shottino' "$REGEN"
    grep -qF 'shottino' "$REGEN"
    grep -qF '_grappaver=' "$REGEN"
}

@test "#1447 the client .SRCINFO is committed and agrees with its recipe on the sentinels" {
    # Coherence NOT proven here beyond the version carriers: .SRCINFO is
    # regenerated by `makepkg --printsrcinfo`, which does not run on this host.
    # What IS checkable without makepkg is that the committed copy carries the
    # same sentinels — the one thing a hand-edit gets wrong first.
    [ -f "$SRCINFO_CLIENT" ]
    grep -qE '^\s*pkgver = @SHOTTINO_VERSION@$' "$SRCINFO_CLIENT"
    grep -qE '^\s*source = .*v@GRAPPA_VERSION@\.tar\.gz$' "$SRCINFO_CLIENT"
    grep -qx 'pkgname = shottino' "$SRCINFO_CLIENT"
}

@test "#2574 the AUR client recipe builds no debug package, so none reaches the release" {
    # makepkg splits a <pkgname>-debug package unless options carries !debug,
    # and the release's 'shottino-*.pkg.tar.zst' glob then publishes it as a
    # second "client" package nobody decided to ship. The bouncer's recipe
    # already opts out; the client's must too, in the recipe AND the
    # committed .SRCINFO.
    grep -qE "^options=\(.*'!debug'.*\)$" "$PKGBUILD"
    grep -qE "^options=\(.*'!debug'.*\)$" "$PKGBUILD_CLIENT"
    grep -qE '^\s*options = !debug$' "$SRCINFO_CLIENT"
}

# ── Its own version line, derived from the header ──────────────────────────

@test "#1447 version.sh with no argument still prints the repo VERSION" {
    # The FreeBSD jail build calls this bare (infra/freebsd/jail_cic_build.sh).
    # Making the new mode the default would break it silently.
    run "$VERSION_SH"
    [ "$status" -eq 0 ]
    [ "$output" = "$(head -1 "$REPO_ROOT/VERSION" | tr -d '\r')" ]
}

@test "#1447 version.sh shottino prints the version line from version.h" {
    # DERIVED from the header, never re-typed here: a suite that hard-coded
    # 0.3.0 would need editing on every client release and would pin nothing.
    from_header="$(sed -n 's/^#define SHOTTINO_VERSION "\(.*\)"$/\1/p' "$VERSION_H")"
    [ -n "$from_header" ]

    run "$VERSION_SH" shottino
    [ "$status" -eq 0 ]
    [ "$output" = "$from_header" ]
}

@test "#1447 the client package does not take the bouncer's version" {
    # Two artifacts, two cadences (vjt, 2026-08-16). The config must reach for
    # the shottino line, not GRAPPA_VERSION.
    grep -q '^version: \${SHOTTINO_VERSION}$' "$NFPM_CLIENT"
    refute grep -q '^version: \${GRAPPA_VERSION}$' "$NFPM_CLIENT"
}

# ── A client package, not a second bouncer ─────────────────────────────────

@test "#1447 the client package is named shottino, not grappa" {
    grep -q '^name: shottino$' "$NFPM_CLIENT"
}

@test "#1447 the client package ships exactly one file, the client binary" {
    run installed_paths "$NFPM_CLIENT"
    [ "$status" -eq 0 ]
    [ "$output" = "/usr/bin/shottino" ]
}

@test "#1447 the client package runs no maintainer scripts" {
    # The server package's postinstall creates a system user, generates
    # secrets and enables a unit. A terminal client must do none of that —
    # installing it must not enable a service the user did not ask for.
    grep -q '^scripts:' "$NFPM_SERVER"
    refute grep -q '^scripts:' "$NFPM_CLIENT"
}

@test "#1447 the client package carries none of the bouncer-only dependencies" {
    # Derived from the server config, not re-typed: these are the entries that
    # exist for ERTS or for the maintainer scripts. If the client config grows
    # one, it has stopped being a client package.
    server_only=(libncurses6 libstdc++6 libgcc-s1 passwd shadow-utils util-linux)
    for dep in "${server_only[@]}"; do
        grep -qF -- "- $dep" "$NFPM_SERVER"
        refute grep -qF -- "- $dep" "$NFPM_CLIENT"
    done
}

@test "#1447 the client package depends on the wide ncurses and on OpenSSL" {
    # configure probes exactly these two (`check_pkg ncursesw`,
    # `check_pkg openssl`), and shottino.c calls
    # SSL_CTX_set_default_verify_paths + SSL_VERIFY_PEER, so the system CA
    # store is a runtime dependency and not a copied one.
    grep -qF -- '- libncursesw6' "$NFPM_CLIENT"
    grep -qF -- '- ca-certificates' "$NFPM_CLIENT"
    grep -qE '^\s+- libssl3t64 \| libssl3$' "$NFPM_CLIENT"
    grep -qF -- '- ncurses-libs' "$NFPM_CLIENT"
    grep -qF -- '- openssl-libs' "$NFPM_CLIENT"
}

# ── The path takeover, written literally ───────────────────────────────────

@test "#1447 the takeover names grappa 1.3.0 in each format's own relation syntax" {
    # vjt's ruling, 2026-08-17: the boundary is the first release that stops
    # shipping the file. A historical constant, written as a constant.
    #
    # Deb and RPM SPELL a relation differently and `replaces` reaches both, so
    # it is written per-format. The Debian spelling is what deb.breaks and
    # overrides.deb.replaces carry; overrides.rpm.replaces carries the rpm one.
    #
    # The trailing `~` is #1594's — see the case below for what it buys. The
    # rpm row is anchored on the end of line because `- grappa < 1.3.0` is a
    # PREFIX of `- grappa < 1.3.0~`: an unanchored fixed-string count cannot
    # tell the pre-#1594 spelling from the cured one and would pass either way.
    [ "$(grep -cF -- '- grappa (<< 1.3.0~)' "$NFPM_CLIENT")" -eq 2 ]
    [ "$(grep -cE -- '^[[:space:]]+- grappa < 1\.3\.0~$' "$NFPM_CLIENT")" -eq 1 ]
    grep -q '^  breaks:$' "$NFPM_CLIENT"
}

@test "#1594 the boundary carries the pre-release epsilon, or it captures its own rc" {
    # `~` sorts BELOW the empty string in dpkg AND in rpm version ordering, so
    # a bare `1.3.0` boundary is strictly greater than `1.3.0~rc1` — which is
    # exactly what nfpm stamps for a `1.3.0-rc1` VERSION file. Cutting
    # v1.3.0-rc1 therefore made the two packages mutually uninstallable: apt
    # exit 100, dnf exit 1, both at the *Install BOTH packages* step.
    #
    # `1.3.0~` is the boundary that means "everything before 1.3.0, its own
    # pre-releases NOT included". Measured through the resolvers, not derived
    # from the ordering rule: with the bare boundary a 1.3.0~rc1 pair REFUSES
    # and with this one it INSTALLS, while 1.2.0 and 1.2.9 keep REFUSING on
    # both — the guard is moved, not disarmed. See DESIGN_NOTES #1594.
    #
    # This case is deliberately separate from the syntax case above: that one
    # is about each format's spelling, this one is about the boundary VALUE.
    refute grep -qE -- '- grappa \(<< 1\.3\.0\)[[:space:]]*$' "$NFPM_CLIENT"
    refute grep -qE -- '- grappa < 1\.3\.0[[:space:]]*$' "$NFPM_CLIENT"
    # Every relation naming grappa ends at the epsilon — no third spelling
    # crept in under one of the three keys.
    [ "$(grep -cE -- '^[[:space:]]+- grappa ?[(<].*1\.3\.0~\)?$' "$NFPM_CLIENT")" -eq 3 ]
}

@test "#1447 no Debian-spelled relation is offered to the rpm renderer" {
    # This is the one that would have shipped silently. nfpm maps `replaces` to
    # RPM's Obsoletes: (rpm/rpm.go:289) through rpmpack, whose parser is
    # `([^=<>\s]*)\s*((?:=|>|<)*)\s*(.*)?` (rpmpack/sense.go:24). Given
    # `grappa (<< 1.3.0)` the operator group matches EMPTY — `(` is not an
    # operator — so it yields name `grappa`, version `(<< 1.3.0)`, sense `""`;
    # and `""` is a legal key for SenseAny, so NOTHING errors. Green build,
    # garbage metadata. Hence: no parenthesised relation under overrides.rpm.
    rpm_block="$(awk '/^  rpm:/ { f = 1; next } f && /^  [a-z]/ { exit } f' "$NFPM_CLIENT")"
    [ -n "$rpm_block" ]
    grep -q 'grappa' <<<"$rpm_block"
    refute grep -q '((<<|>>))' <<<"$rpm_block"
    refute grep -qF '(<<' <<<"$rpm_block"
}

@test "#1447 the takeover relations are literal, never interpolated" {
    # Not a restatement of the constants above — its own failure mode. nfpm
    # v2.43.0 expands ${VARS} in depends/replaces/recommends/provides/suggests/
    # conflicts (nfpm.go:214-227) and NOT in deb.breaks (the Deb struct,
    # nfpm.go:438), so an interpolation there is written into the control file
    # verbatim. Every relation naming grappa holds no `$`, ever.
    takeover="$(grep -E '^[[:space:]]*- grappa[ (]' "$NFPM_CLIENT")"
    [ -n "$takeover" ]
    [ "$(printf '%s\n' "$takeover" | wc -l)" -eq 3 ]
    refute grep -q '\$' <<<"$takeover"
}
