#!/usr/bin/env bats
#
# The PACKAGED install doors and the built-in theme gallery (#1167).
#
# #435 taught the orchestrated deploy paths to seed the curated built-in
# themes; the packaged doors were never wired. A `.deb`/`.rpm` or AUR install
# ran the migrator and stopped, so the operator got a working bouncer with an
# EMPTY theme gallery — the palettes ship compiled into the release, but the
# gallery reads the DB and nothing ever turned the compiled data into rows.
# The wallpapers were never the missing part: the package simply did not
# finish installing itself.
#
# Scope: the three packaged doors' DECISION — that each one reaches the
# seeder, in the only order that helps (schema before data), and what it does
# when the seed fails. The release is a recorder stub that logs every
# invocation, so the assertions read what the RELEASE would actually have
# seen, not what the source text looks like.
#
# The scriptlets address the host by ABSOLUTE path (/usr/bin/grappa,
# /etc/grappa, /var/lib/grappa), so each is copied into a sandbox with those
# prefixes re-rooted. `assert_rerooted` then proves the rewrite was TOTAL: a
# leaked absolute path would either abort the run as non-root or, worse, touch
# the real host — and a harness that half-runs the script would let every
# assertion below hold for the wrong reason.
#
# The fatal/non-fatal split is the property that most wants pinning:
#   * a failed MIGRATE aborts the package transaction (a half-applied schema
#     is a correctness defect);
#   * a failed SEED is LOUD but non-fatal, carrying its retry command — the
#     posture deploy_common has held for every substrate since #440
#     (docs/OPERATIONS.md: "A seed failure WARNS and continues"). Inverting
#     it would let a cosmetic gallery failure fail an install.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    PKG_SRC="$REPO_SRC/infra/packaging"

    ROOT="$BATS_TEST_TMPDIR/root"
    mkdir -p "$ROOT/usr/bin" "$ROOT/usr/share/grappa" "$ROOT/usr/lib/grappa/bin" \
        "$ROOT/usr/lib/sysusers.d" "$ROOT/usr/lib/tmpfiles.d" "$ROOT/etc"

    CALL_LOG="$BATS_TEST_TMPDIR/calls.log"
    export CALL_LOG
    : > "$CALL_LOG"

    # Failure injection, per verb: the two must be independently faultable or
    # the fatal/non-fatal split cannot be observed at all.
    export MIGRATE_RC=0
    export SEED_RC=0

    # /usr/bin/grappa — the packaged operator CLI, recorded.
    cat > "$ROOT/usr/bin/grappa" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALL_LOG"
case "${1:-}" in
    migrate)
        if [ "${MIGRATE_RC:-0}" -ne 0 ]; then
            echo "** (Exqlite.Error) some migration blew up" >&2
            exit "$MIGRATE_RC"
        fi
        ;;
    seed-themes)
        if [ "${SEED_RC:-0}" -ne 0 ]; then
            echo "** (Ecto.ConstraintError) seeding blew up" >&2
            exit "$SEED_RC"
        fi
        ;;
esac
EOF
    chmod 0755 "$ROOT/usr/bin/grappa"

    # /usr/lib/grappa/bin/grappa — the mix-release boot script the wrapper
    # execs, recorded with the same log so ORDER stays observable.
    cat > "$ROOT/usr/lib/grappa/bin/grappa" <<'EOF'
#!/usr/bin/env bash
printf 'release: %s\n' "$*" >> "$CALL_LOG"
EOF
    chmod 0755 "$ROOT/usr/lib/grappa/bin/grappa"

    printf '#!/bin/sh\nprintf "gen-secrets\\n" >> "$CALL_LOG"\n' \
        > "$ROOT/usr/share/grappa/gen-secrets.sh"
    chmod 0755 "$ROOT/usr/share/grappa/gen-secrets.sh"
    cp "$PKG_SRC/grappa.env.example" "$ROOT/usr/share/grappa/grappa.env.example"

    # ---- PATH stubs: the host mutations the suite must not perform --------
    # chown needs root and the suite has none; systemctl/systemd-* would talk
    # to the developer's own init. chmod is deliberately NOT stubbed.
    STUB="$BATS_TEST_TMPDIR/stub"
    mkdir -p "$STUB"
    for noop in chown systemd-sysusers systemd-tmpfiles; do
        printf '#!/bin/sh\nexit 0\n' > "$STUB/$noop"
        chmod 0755 "$STUB/$noop"
    done
    # The service is NOT running: these doors are the ones that seed it
    # themselves. Over a running service the scriptlets hand the upgrade to
    # apply-upgrade.sh instead (issue 1112), which seeds after applying —
    # packaging_postinstall_live_unit_test.bats and
    # packaging_apply_upgrade_test.bats cover that side.
    printf '#!/bin/sh\n[ "$1" = is-active ] && exit 3\nexit 0\n' > "$STUB/systemctl"
    chmod 0755 "$STUB/systemctl"

    # `install -o root -g grappa` fails for an unprivileged user, and the
    # ownership is not what this suite is about — drop the owner flags and
    # perform the real copy/mkdir so the file-existence assertions stay real.
    cat > "$STUB/install" <<'EOF'
#!/bin/sh
mode=''
dir=0
set -- "$@"
operands=''
while [ $# -gt 0 ]; do
    case "$1" in
        -d) dir=1; shift ;;
        -o|-g) shift 2 ;;
        -m) mode="$2"; shift 2 ;;
        *) operands="$operands $1"; shift ;;
    esac
done
# shellcheck disable=SC2086
set -- $operands
if [ "$dir" = 1 ]; then
    mkdir -p "$@"
    if [ -n "$mode" ]; then chmod "$mode" "$@"; fi
else
    cp "$1" "$2"
    if [ -n "$mode" ]; then chmod "$mode" "$2"; fi
fi
EOF
    chmod 0755 "$STUB/install"
    PATH="$STUB:$PATH"
}

# Copy a packaging script into the sandbox with every host-absolute grappa
# path re-rooted under $ROOT.
reroot() {
    sed -e "s#/usr/bin/grappa#$ROOT/usr/bin/grappa#g" \
        -e "s#/usr/lib/grappa#$ROOT/usr/lib/grappa#g" \
        -e "s#/usr/lib/sysusers.d#$ROOT/usr/lib/sysusers.d#g" \
        -e "s#/usr/lib/tmpfiles.d#$ROOT/usr/lib/tmpfiles.d#g" \
        -e "s#/usr/share/grappa#$ROOT/usr/share/grappa#g" \
        -e "s#/usr/share/doc/grappa#$ROOT/usr/share/doc/grappa#g" \
        -e "s#/etc/grappa#$ROOT/etc/grappa#g" \
        -e "s#/var/lib/grappa#$ROOT/var/lib/grappa#g" \
        "$1" > "$2"
    assert_rerooted "$2"
}

# Every re-rooted path reads `<tmpdir>/root/usr/...`, so the character before
# the prefix is alphanumeric; a LEAKED one is preceded by whitespace, a quote
# or the start of a line. Anything found here means the sandbox is porous and
# the run below would not be measuring the script we shipped.
assert_rerooted() {
    local leaked
    leaked="$(grep -nE '(^|[^/[:alnum:]_.-])/(usr|etc|var)/[[:alnum:]/._-]*grappa' "$1")" || return 0
    printf 'absolute host paths survived the re-root:\n%s\n' "$leaked" >&2
    return 1
}

postinstall() {
    reroot "$PKG_SRC/scripts/postinstall.sh" "$BATS_TEST_TMPDIR/postinstall.sh"
    sh "$BATS_TEST_TMPDIR/postinstall.sh" "$@"
}

# pacman sources the scriptlet and calls one hook; there is no shebang.
arch_hook() {
    reroot "$PKG_SRC/aur/grappa.install" "$BATS_TEST_TMPDIR/grappa.install"
    bash -c ". '$BATS_TEST_TMPDIR/grappa.install'; $1"
}

wrapper() {
    reroot "$PKG_SRC/grappa-wrapper.sh" "$BATS_TEST_TMPDIR/grappa"
    chmod 0755 "$BATS_TEST_TMPDIR/grappa"
    mkdir -p "$ROOT/etc/grappa"
    printf 'DATABASE_PATH=%s/db\n' "$ROOT" > "$ROOT/etc/grappa/grappa.env"
    "$BATS_TEST_TMPDIR/grappa" "$@"
}

calls() {
    cat "$CALL_LOG"
}

# ── The deb/rpm door ────────────────────────────────────────────────────────

@test "the deb/rpm postinstall seeds the gallery, after applying the schema" {
    run postinstall configure
    [ "$status" -eq 0 ]

    # The migrate call is the harness's own sanity token: without it, an
    # absent seed would be indistinguishable from a scriptlet that never ran.
    grep -qx 'migrate' "$CALL_LOG"
    grep -qx 'seed-themes' "$CALL_LOG"

    # Schema before data. A seed against an unmigrated DB has no themes table.
    local order
    order="$(grep -nxE 'migrate|seed-themes' "$CALL_LOG" | cut -d: -f2 | tr '\n' ' ')"
    [ "$order" = "migrate seed-themes " ]
}

@test "an rpm's numeric \$1 seeds too — the door is not dpkg-only" {
    # rpm passes 1/2, never "configure"; a seed gated on the dpkg spelling
    # would leave every RHEL-family install with an empty gallery.
    run postinstall 1
    [ "$status" -eq 0 ]
    grep -qx 'seed-themes' "$CALL_LOG"
}

@test "a dpkg rollback neither migrates nor seeds" {
    run postinstall abort-upgrade
    [ "$status" -eq 0 ]
    refute grep -qx 'seed-themes' "$CALL_LOG"
    refute grep -qx 'migrate' "$CALL_LOG"
}

@test "a failed seed does NOT fail the package — but says so, with the retry" {
    # The #440 posture: the gallery is cosmetic and the upsert converges, so
    # aborting a package transaction over it costs the operator a working
    # install for a missing colour scheme. Loud, not fatal, and never silent.
    export SEED_RC=1
    run postinstall configure

    [ "$status" -eq 0 ]
    grep -qx 'seed-themes' "$CALL_LOG"
    [[ "$output" == *"grappa seed-themes"* ]]
}

@test "a failed migrate still aborts, and never reaches the seed" {
    # The other half of the split. Seeding data into a half-applied schema is
    # not a recovery, and the transaction must still fail.
    export MIGRATE_RC=1
    run postinstall configure

    [ "$status" -ne 0 ]
    refute grep -qx 'seed-themes' "$CALL_LOG"
    [[ "$output" == *"migration FAILED"* ]]
}

# ── The AUR door ────────────────────────────────────────────────────────────

@test "the Arch scriptlet seeds on first install, after the schema" {
    run arch_hook post_install
    [ "$status" -eq 0 ]

    grep -qx 'migrate' "$CALL_LOG"
    grep -qx 'seed-themes' "$CALL_LOG"

    local order
    order="$(grep -nxE 'migrate|seed-themes' "$CALL_LOG" | cut -d: -f2 | tr '\n' ' ')"
    [ "$order" = "migrate seed-themes " ]
}

@test "the Arch scriptlet re-seeds on upgrade — new built-ins reach old boxes" {
    # The seed set is versioned CODE: a gallery materialised once at install
    # would never gain a theme added in a later release. That is the whole
    # reason #440 made the deploy hook run on every deploy.
    run arch_hook post_upgrade
    [ "$status" -eq 0 ]
    grep -qx 'seed-themes' "$CALL_LOG"
}

@test "a failed Arch seed leaves the transaction green, loudly" {
    export SEED_RC=1
    run arch_hook post_install

    [ "$status" -eq 0 ]
    grep -qx 'seed-themes' "$CALL_LOG"
    [[ "$output" == *"grappa seed-themes"* ]]
}

@test "a failed Arch migrate aborts the transaction before the seed" {
    export MIGRATE_RC=1
    run arch_hook post_install

    [ "$status" -ne 0 ]
    refute grep -qx 'seed-themes' "$CALL_LOG"
}

# ── The operator CLI ────────────────────────────────────────────────────────

@test "grappa seed-themes reaches Grappa.Release.seed_themes()" {
    # The verb the two scriptlets above call, and the documented manual
    # recovery path. Without it they invoke nothing at all.
    run wrapper seed-themes
    [ "$status" -eq 0 ]
    [ "$(calls)" = "release: eval Grappa.Release.seed_themes()" ]
}

@test "grappa migrate still reaches Grappa.Release.migrate()" {
    # The sibling verb, pinned in the same file: the seed verb is added by
    # extending the same dispatch, and a botched extension would eat it.
    run wrapper migrate
    [ "$status" -eq 0 ]
    [ "$(calls)" = "release: eval Grappa.Release.migrate()" ]
}
