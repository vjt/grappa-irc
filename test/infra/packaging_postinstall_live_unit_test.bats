#!/usr/bin/env bats
#
# The install scriptlets on an UPGRADE OF A RUNNING SERVICE (issue 1112).
#
# Before 1112 every configure migrated the live database from the
# maintainer script and then told the operator to restart — so the running
# node served the old code against a schema the new code had moved, until
# somebody read the message. Now the decision is the unit's state:
#
#   * running  → the scriptlet migrates NOTHING and hands the upgrade to
#                apply-upgrade.sh, which migrates in-process on a hot reload
#                or in ExecStartPre on a restart, after the code it serves;
#   * stopped  → today's body: migrate, seed, enable, the first-install
#                banner — and no start (R5: a stopped unit stays stopped).
#
# On Arch the scriptlet does not call the script at all: the alpm hook does,
# at the end of the transaction, and calling it from both would apply twice.
#
# Same harness as packaging_seed_themes_test.bats: the scriptlets are copied
# into a sandbox with every host path re-rooted, and the release, systemd and
# apply-upgrade.sh are recorder stubs writing into one log.

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

    export UNIT_ACTIVE=1 APPLY_RC=0

    cat > "$ROOT/usr/bin/grappa" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALL_LOG"
EOF
    printf '#!/bin/sh\nprintf "gen-secrets\\n" >> "$CALL_LOG"\n' \
        > "$ROOT/usr/share/grappa/gen-secrets.sh"
    cat > "$ROOT/usr/share/grappa/apply-upgrade.sh" <<'EOF'
#!/bin/sh
printf 'apply-upgrade\n' >> "$CALL_LOG"
if [ "$APPLY_RC" -ne 0 ]; then
    echo "grappa: the upgrade was NOT applied: systemctl restart grappa.service failed." >&2
fi
exit "$APPLY_RC"
EOF
    chmod 0755 "$ROOT/usr/bin/grappa" "$ROOT/usr/share/grappa/gen-secrets.sh" \
        "$ROOT/usr/share/grappa/apply-upgrade.sh"
    cp "$PKG_SRC/grappa.env.example" "$ROOT/usr/share/grappa/grappa.env.example"

    STUB="$BATS_TEST_TMPDIR/stub"
    mkdir -p "$STUB"
    cat > "$STUB/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$CALL_LOG"
if [ "$1" = is-active ]; then
    [ "$UNIT_ACTIVE" = 1 ] && exit 0
    exit 3
fi
exit 0
EOF
    for noop in chown systemd-sysusers systemd-tmpfiles; do
        printf '#!/bin/sh\nexit 0\n' > "$STUB/$noop"
    done
    # `install -o/-g` needs root; drop the owner flags, keep the real copy.
    cat > "$STUB/install" <<'EOF'
#!/bin/sh
mode='' dir=0 operands=''
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
    chmod 0755 "$STUB"/*
    PATH="$STUB:$PATH"
}

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
    local leaked
    leaked="$(grep -nE '(^|[^/[:alnum:]_.-])/(usr|etc|var)/[[:alnum:]/._-]*grappa' "$2")" || return 0
    printf 'absolute host paths survived the re-root:\n%s\n' "$leaked" >&2
    return 1
}

postinstall() {
    reroot "$PKG_SRC/scripts/postinstall.sh" "$BATS_TEST_TMPDIR/postinstall.sh"
    sh "$BATS_TEST_TMPDIR/postinstall.sh" "$@"
}

arch_hook() {
    reroot "$PKG_SRC/aur/grappa.install" "$BATS_TEST_TMPDIR/grappa.install"
    bash -c ". '$BATS_TEST_TMPDIR/grappa.install'; $1"
}

first() {
    grep -nE "$1" "$CALL_LOG" | head -n1 | cut -d: -f1
}

# ── deb / rpm ────────────────────────────────────────────────────────────────

@test "a dpkg configure over a RUNNING service migrates nothing and applies the upgrade" {
    run postinstall configure 1.6.2

    [ "$status" -eq 0 ]
    grep -qx 'apply-upgrade' "$CALL_LOG"
    refute grep -qx 'migrate' "$CALL_LOG"
    refute grep -qx 'seed-themes' "$CALL_LOG"
    # The first-install banner tells the operator to start a service that is
    # already running.
    refute grep -q 'Start it' <<<"$output"
}

@test "secrets a new version introduces are filled BEFORE the upgrade is applied" {
    run postinstall configure 1.6.2

    [ "$status" -eq 0 ]
    [ "$(first '^gen-secrets$')" -lt "$(first '^apply-upgrade$')" ]
}

@test "an rpm upgrade (\$1 = 2) over a running service applies, not migrates" {
    run postinstall 2

    [ "$status" -eq 0 ]
    grep -qx 'apply-upgrade' "$CALL_LOG"
    refute grep -qx 'migrate' "$CALL_LOG"
}

@test "the running unit decides, not the \$1 spelling — rpm \$1 = 1 included" {
    run postinstall 1

    [ "$status" -eq 0 ]
    grep -qx 'apply-upgrade' "$CALL_LOG"
    refute grep -qx 'migrate' "$CALL_LOG"
}

@test "a STOPPED service gets today's body: migrate, seed, banner, and no start" {
    export UNIT_ACTIVE=0
    run postinstall configure 1.6.2

    [ "$status" -eq 0 ]
    refute grep -qx 'apply-upgrade' "$CALL_LOG"
    grep -qx 'migrate' "$CALL_LOG"
    grep -qx 'seed-themes' "$CALL_LOG"
    grep -q 'Start it' <<<"$output"
    refute grep -qE '^systemctl (start|restart)' "$CALL_LOG"
}

@test "a dpkg rollback touches nothing, running service or not" {
    run postinstall abort-upgrade 1.7.0

    [ "$status" -eq 0 ]
    refute grep -qx 'apply-upgrade' "$CALL_LOG"
    refute grep -qx 'migrate' "$CALL_LOG"
}

@test "an upgrade that could not be applied fails the package configuration (R4)" {
    export APPLY_RC=1
    run postinstall configure 1.6.2

    [ "$status" -ne 0 ]
    grep -qx 'apply-upgrade' "$CALL_LOG"
    [[ "$output" == *"NOT applied"* ]]
}

# ── Arch ─────────────────────────────────────────────────────────────────────

@test "Arch post_upgrade over a running service migrates nothing and leaves the apply to the hook" {
    run arch_hook post_upgrade

    [ "$status" -eq 0 ]
    grep -qx 'gen-secrets' "$CALL_LOG"
    refute grep -qx 'migrate' "$CALL_LOG"
    refute grep -qx 'seed-themes' "$CALL_LOG"
    # The hook applies at the end of the transaction; applying here too would
    # apply twice, the second time against a node the first just restarted.
    refute grep -qx 'apply-upgrade' "$CALL_LOG"
    refute grep -q 'Restart to run' <<<"$output"
}

@test "Arch post_upgrade over a STOPPED service migrates and seeds, as before" {
    export UNIT_ACTIVE=0
    run arch_hook post_upgrade

    [ "$status" -eq 0 ]
    grep -qx 'migrate' "$CALL_LOG"
    grep -qx 'seed-themes' "$CALL_LOG"
    refute grep -qE '^systemctl (start|restart)' "$CALL_LOG"
}
