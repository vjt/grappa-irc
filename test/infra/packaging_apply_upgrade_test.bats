#!/usr/bin/env bats
#
# infra/packaging/apply-upgrade.sh — a package upgrade applies itself to the
# RUNNING service (issue 1112): hot when the release allows it, by restart
# otherwise, never "the operator restarts".
#
# Scope: the script's DECISIONS, read off what the host would have seen. Every
# outside party — systemd, the release CLI, the HTTP endpoints — is a recorder
# stub writing one line per call into one log, so ORDER is observable and the
# assertions read what was asked of the host, not what the source text says.
#
# The property that most wants pinning is the ERTS mine (measured in issue
# 1112's phase 1: a node left running from a deleted ERTS directory halts the
# first time it relaunches inet_gethost). When the ERTS moved, the script must
# restart BEFORE it talks to the node at all — no `grappa rpc`, no POST — so
# the cases below assert the absence of every contact, not only the restart.
#
# The second is the R4 ruling: the ONLY non-zero exit is "a restart was needed
# and did not take". Hot refusals of every kind fall through to the restart,
# a stopped unit stays stopped, and a failed theme seed stays non-fatal.
#
# The script addresses the host by ABSOLUTE path (/usr/bin/grappa,
# /usr/lib/grappa, /etc/grappa, /var/lib/grappa, /proc), so it is copied into
# a sandbox with those prefixes re-rooted, and `assert_rerooted` proves the
# rewrite was total: a leaked path would read the developer's own /proc or
# touch the real host, and every assertion below could then hold for the
# wrong reason.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    PKG_SRC="$REPO_SRC/infra/packaging"

    ROOT="$BATS_TEST_TMPDIR/root"
    mkdir -p "$ROOT/usr/bin" "$ROOT/usr/lib/grappa/releases" "$ROOT/etc/grappa" \
        "$ROOT/var/lib/grappa" "$ROOT/proc/4242" "$ROOT/run"

    CALL_LOG="$BATS_TEST_TMPDIR/calls.log"
    export CALL_LOG
    : > "$CALL_LOG"

    # ---- the host's state -------------------------------------------------
    # The release on disk declares ERTS 16.4; the running node (MainPID 4242)
    # runs it too, unless a case says otherwise.
    printf '16.4 0.0.0\n' > "$ROOT/usr/lib/grappa/releases/start_erl.data"
    running_erts '/usr/lib/grappa/erts-16.4/bin/beam.smp'
    printf 'PHX_HOST=example.org\nPORT=4123\n' > "$ROOT/etc/grappa/grappa.env"

    # ---- the knobs a case turns ------------------------------------------
    export UNIT_ACTIVE=1 MAIN_PID=4242 RESTART_RC=0 START_LIMIT_HIT=0
    export RPC_RC=0 RPC_OUT='g2gDZAAQZ3JhcHBhX21hbmlmZXN0' EVAL_RC=0 EVAL_OUT='  → no unsafe markers → HOT'
    export RELOAD_CONNECT_RC=0 RELOAD_CODE=200
    export RELOAD_BODY='{"failed":[],"migrated":[],"reloaded":["Elixir.Grappa.Version"]}'
    export HEALTH_RC=0 HEALTH_OK_AFTER_RESTART=0 CIC_RC=0 SEED_RC=0

    STUB="$BATS_TEST_TMPDIR/stub"
    mkdir -p "$STUB"

    # systemctl — recorded. `is-active` answers from UNIT_ACTIVE; `restart`
    # refuses while START_LIMIT_HIT is set and no reset-failed came first,
    # which is what systemd does to a unit past its StartLimitBurst.
    cat > "$STUB/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$CALL_LOG"
case "$1" in
    is-active)
        if [ "$UNIT_ACTIVE" = 1 ]; then state=active; rc=0; else state=failed; rc=3; fi
        [ "$2" = "--quiet" ] || echo "$state"
        exit "$rc"
        ;;
    show) echo "$MAIN_PID" ;;
    restart)
        if [ "$START_LIMIT_HIT" = 1 ] && ! grep -qx 'systemctl reset-failed grappa.service' "$CALL_LOG"; then
            echo "Job for grappa.service failed: start request repeated too quickly." >&2
            exit 1
        fi
        exit "$RESTART_RC"
        ;;
esac
exit 0
EOF

    # curl — recorded by method and URL. /admin/reload hands back the body and
    # the code the case set, the way `-o FILE -w '%{http_code}'` would.
    cat > "$STUB/curl" <<'EOF'
#!/usr/bin/env bash
out='' wfmt='' method=GET url=''
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out="$2"; shift 2 ;;
        -w) wfmt="$2"; shift 2 ;;
        -X) method="$2"; shift 2 ;;
        -*) shift ;;
        *) url="$1"; shift ;;
    esac
done
printf 'curl %s %s\n' "$method" "$url" >> "$CALL_LOG"
case "$url" in
    */admin/reload)
        if [ "$RELOAD_CONNECT_RC" -ne 0 ]; then
            echo "curl: (7) Failed to connect to 127.0.0.1 port 4123: Connection refused" >&2
            exit "$RELOAD_CONNECT_RC"
        fi
        if [ -n "$out" ]; then printf '%s' "$RELOAD_BODY" > "$out"; else printf '%s' "$RELOAD_BODY"; fi
        if [ -n "$wfmt" ]; then printf '%s' "$RELOAD_CODE"; fi
        exit 0
        ;;
    */healthz)
        if [ "$HEALTH_OK_AFTER_RESTART" = 1 ] && grep -qx 'systemctl restart grappa.service' "$CALL_LOG"; then
            exit 0
        fi
        exit "$HEALTH_RC"
        ;;
    */admin/cic-bundle-changed) exit "$CIC_RC" ;;
esac
exit 99
EOF

    # The healthcheck loop sleeps between probes; a no-op keeps a case that
    # exhausts it instant, without a production knob to shorten the loop.
    printf '#!/bin/sh\nexit 0\n' > "$STUB/sleep"
    chmod 0755 "$STUB"/*
    PATH="$STUB:$PATH"

    # /usr/bin/grappa — the packaged operator CLI, recorded by verb. `eval`
    # copies the file it was handed, so a case can check it is what `rpc`
    # produced.
    cat > "$ROOT/usr/bin/grappa" <<EOF
#!/usr/bin/env bash
printf 'grappa %s\n' "\$1" >> "\$CALL_LOG"
case "\$1" in
    rpc)
        if [ "\$RPC_RC" -ne 0 ]; then
            echo "** (UndefinedFunctionError) function Grappa.Deploy.Manifest.encode/0 is undefined" >&2
            exit "\$RPC_RC"
        fi
        printf '%s' "\$RPC_OUT"
        ;;
    eval)
        printf '%s\n' "\$2" > "$BATS_TEST_TMPDIR/eval-expr"
        cp "\$3" "$BATS_TEST_TMPDIR/eval-saw"
        printf '%s\n' "\$3" > "$BATS_TEST_TMPDIR/eval-path"
        ls -ld "\$(dirname "\$3")" | cut -c1-10 > "$BATS_TEST_TMPDIR/eval-dir-mode"
        ls -l "\$3" | cut -c1-10 > "$BATS_TEST_TMPDIR/eval-file-mode"
        printf '%s\n' "\$EVAL_OUT"
        exit "\$EVAL_RC"
        ;;
    seed-themes)
        if [ "\$SEED_RC" -ne 0 ]; then
            echo "** (Ecto.ConstraintError) seeding blew up" >&2
            exit "\$SEED_RC"
        fi
        ;;
esac
EOF
    chmod 0755 "$ROOT/usr/bin/grappa"
}

# The running node's executable, as /proc/<MainPID>/exe reads.
running_erts() {
    rm -f "$ROOT/proc/4242/exe"
    ln -s "$1" "$ROOT/proc/4242/exe"
}

reroot() {
    sed -e "s#/usr/bin/grappa#$ROOT/usr/bin/grappa#g" \
        -e "s#/usr/lib/grappa#$ROOT/usr/lib/grappa#g" \
        -e "s#/etc/grappa#$ROOT/etc/grappa#g" \
        -e "s#/var/lib/grappa#$ROOT/var/lib/grappa#g" \
        -e "s#/proc/#$ROOT/proc/#g" \
        -e "s#/run/#$ROOT/run/#g" \
        "$1" > "$2"
    assert_rerooted "$2"
}

# Every re-rooted path reads `<tmpdir>/root/...`, so the character before the
# prefix is alphanumeric; a LEAKED one is preceded by whitespace, a quote, `=`
# or the start of a line.
assert_rerooted() {
    local leaked
    leaked="$(grep -nE '(^|[^/[:alnum:]_.-])/((usr|etc|var)/[[:alnum:]/._-]*grappa|proc/|run/)' "$1")" || return 0
    printf 'absolute host paths survived the re-root:\n%s\n' "$leaked" >&2
    return 1
}

# Under the strictest umask root may carry, so every mode the script needs is
# one it sets itself.
apply() {
    reroot "$PKG_SRC/apply-upgrade.sh" "$BATS_TEST_TMPDIR/apply-upgrade.sh"
    (umask 077 && sh "$BATS_TEST_TMPDIR/apply-upgrade.sh")
}

# The line number of the first call matching an extended regex, or nothing.
first() {
    grep -nE "$1" "$CALL_LOG" | head -n1 | cut -d: -f1
}

restarted() {
    grep -qx 'systemctl restart grappa.service' "$CALL_LOG"
}

# ── A stopped service stays stopped (R5) ──────────────────────────────────────

@test "a service that is not running is left alone, and the script says why" {
    export UNIT_ACTIVE=0
    run apply

    [ "$status" -eq 0 ]
    [[ "$output" == *"not running"* ]]
    refute restarted
    refute grep -qE '^systemctl (start|reset-failed)' "$CALL_LOG"
    refute grep -q '^grappa' "$CALL_LOG"
    refute grep -q '^curl' "$CALL_LOG"
}

# ── The ERTS mine: restart BEFORE any contact with the node ───────────────────

@test "an ERTS move restarts without one rpc or HTTP call to the node first" {
    running_erts '/usr/lib/grappa/erts-16.3/bin/beam.smp'
    run apply

    [ "$status" -eq 0 ]
    restarted
    refute grep -q '^grappa rpc' "$CALL_LOG"
    refute grep -q '^grappa eval' "$CALL_LOG"
    refute grep -q 'admin/' "$CALL_LOG"
    [[ "$output" == *"16.3"*"16.4"* ]]
    [[ "$output" == *"applied by RESTART"* ]]
}

@test "an ERTS move is read through the '(deleted)' a removed binary carries" {
    # What /proc reads once the package manager has removed the running
    # node's ERTS directory — the mine itself.
    running_erts '/usr/lib/grappa/erts-16.3/bin/beam.smp (deleted)'
    run apply

    [ "$status" -eq 0 ]
    restarted
    refute grep -q '^grappa rpc' "$CALL_LOG"
    refute grep -q 'admin/' "$CALL_LOG"
}

@test "the same ERTS behind '(deleted)' is NOT a move — dpkg replaces every file" {
    # dpkg unpacks each file of the new package over the old one, identical or
    # not, so after EVERY deb upgrade the running beam.smp reads "(deleted)".
    # Treating the suffix as a move would make every deb upgrade a restart;
    # the version is the signal, and here it did not change.
    running_erts '/usr/lib/grappa/erts-16.4/bin/beam.smp (deleted)'
    run apply

    [ "$status" -eq 0 ]
    grep -qx 'grappa rpc' "$CALL_LOG"
    refute restarted
}

@test "a MainPID systemd cannot name means the ERTS is unknown — restart" {
    export MAIN_PID=0
    run apply

    [ "$status" -eq 0 ]
    restarted
    refute grep -q '^grappa rpc' "$CALL_LOG"
}

# ── HOT ──────────────────────────────────────────────────────────────────────

@test "a hot verdict and a clean reload apply HOT: no restart, cic told, then seeded" {
    run apply

    [ "$status" -eq 0 ]
    refute restarted
    grep -qx 'curl POST http://127.0.0.1:4123/admin/reload' "$CALL_LOG"
    grep -qx 'curl POST http://127.0.0.1:4123/admin/cic-bundle-changed' "$CALL_LOG"
    [[ "$output" == *"applied HOT"* ]]

    # The seed runs against the schema the reload migrated — so after it.
    [ -n "$(first '^grappa seed-themes')" ]
    [ "$(first '/admin/reload')" -lt "$(first '^grappa seed-themes')" ]
}

@test "the verdict is computed from the manifest the RUNNING node reported" {
    run apply

    [ "$status" -eq 0 ]
    [ "$(first '^grappa rpc')" -lt "$(first '^grappa eval')" ]
    [ "$(cat "$BATS_TEST_TMPDIR/eval-saw")" = "$RPC_OUT" ]
    # It travelled in a directory of its own that the release, run as the
    # grappa user, can traverse but not list or write, in a file it can read...
    [[ "$(cat "$BATS_TEST_TMPDIR/eval-path")" == "$ROOT/run/grappa-upgrade."*/manifest ]]
    [ "$(cat "$BATS_TEST_TMPDIR/eval-dir-mode")" = 'drwx--x--x' ]
    [ "$(cat "$BATS_TEST_TMPDIR/eval-file-mode")" = '-rw-r--r--' ]
    # ...and neither outlives the run.
    [ -z "$(ls -A "$ROOT/run")" ]
    [ -z "$(ls -A "$ROOT/var/lib/grappa")" ]
}

# ── Every hot refusal falls through to the restart ───────────────────────────

@test "a running node that cannot report a manifest (pre-1112 release) → restart" {
    export RPC_RC=1
    run apply

    [ "$status" -eq 0 ]
    restarted
    refute grep -q '^grappa eval' "$CALL_LOG"
    refute grep -q 'admin/reload' "$CALL_LOG"
}

@test "an EMPTY manifest from the running node is no manifest → restart" {
    export RPC_OUT=''
    run apply

    [ "$status" -eq 0 ]
    restarted
    refute grep -q '^grappa eval' "$CALL_LOG"
}

@test "a cold verdict restarts and names what made it cold" {
    export EVAL_RC=3 EVAL_OUT='Cold-deploy required:
  → config: config/runtime.exs'
    run apply

    [ "$status" -eq 0 ]
    restarted
    refute grep -q 'admin/reload' "$CALL_LOG"
    [[ "$output" == *"config/runtime.exs"* ]]
}

@test "a verdict that crashed (exit 1) is not a verdict — restart, saying so" {
    export EVAL_RC=1 EVAL_OUT='** (RuntimeError) boom'
    run apply

    [ "$status" -eq 0 ]
    restarted
    refute grep -q 'admin/reload' "$CALL_LOG"
    [[ "$output" == *"verdict unavailable"* ]]
}

@test "each of the four 409 refusals of POST /admin/reload → restart" {
    local body
    for body in \
        '{"error":"contract_migrations_pending","migrations":["x.exs"]}' \
        '{"error":"duplicate_migration_versions","duplicates":[]}' \
        '{"error":"stale_code_path","booted":"0.0.0","built":"0.0.1","code_path":"/x"}' \
        '{"error":"stale_toolchain","release":"/usr/lib/grappa","moved":null}'; do
        : > "$CALL_LOG"
        export RELOAD_CODE=409 RELOAD_BODY="$body"
        run apply

        [ "$status" -eq 0 ]
        restarted
        [[ "$output" == *"409"* ]]
        [[ "$output" == *"$body"* ]]
        refute grep -q 'cic-bundle-changed' "$CALL_LOG"
    done
}

@test "a 200 that reports per-module failures is not a hot apply → restart" {
    export RELOAD_BODY='{"failed":[{"module":"Elixir.Grappa.X","reason":":badfile"}],"migrated":[],"reloaded":[]}'
    run apply

    [ "$status" -eq 0 ]
    restarted
    [[ "$output" == *"Elixir.Grappa.X"* ]]
}

@test "a reload the node never answered → restart" {
    export RELOAD_CONNECT_RC=7
    run apply

    [ "$status" -eq 0 ]
    restarted
}

@test "a hot reload after which /healthz never answers 200 → restart" {
    # Every probe after the reload fails; the node answers again once the
    # restart has been asked for.
    export HEALTH_RC=7 HEALTH_OK_AFTER_RESTART=1
    run apply

    [ "$status" -eq 0 ]
    grep -q 'admin/reload' "$CALL_LOG"
    restarted
    [[ "$output" == *"applied by RESTART"* ]]
}

# ── The restart itself ───────────────────────────────────────────────────────

@test "the restart reloads unit files and clears a failed state first" {
    export EVAL_RC=3
    run apply

    [ "$status" -eq 0 ]
    [ "$(first '^systemctl daemon-reload')" -lt "$(first '^systemctl restart')" ]
    [ "$(first '^systemctl reset-failed grappa.service')" -lt "$(first '^systemctl restart')" ]
    # Seeded after the restart's migrate, which runs in ExecStartPre.
    [ "$(first '^systemctl restart')" -lt "$(first '^grappa seed-themes')" ]
}

@test "a unit past its start limit still restarts — reset-failed clears it" {
    export EVAL_RC=3 START_LIMIT_HIT=1
    run apply

    [ "$status" -eq 0 ]
    [[ "$output" == *"applied by RESTART"* ]]
}

# ── R4: the one failure that fails ───────────────────────────────────────────

@test "a restart systemd refuses fails the script loudly, and seeds nothing" {
    export EVAL_RC=3 RESTART_RC=1
    run apply

    [ "$status" -eq 1 ]
    refute grep -q '^grappa seed-themes' "$CALL_LOG"
    [[ "$output" == *"NOT applied"* ]]
    [[ "$output" == *"journalctl -u grappa"* ]]
    [[ "$output" == *"sudo systemctl restart grappa"* ]]
}

@test "a restart after which /healthz never answers 200 fails the same way" {
    export EVAL_RC=3 HEALTH_RC=7
    run apply

    [ "$status" -eq 1 ]
    refute grep -q '^grappa seed-themes' "$CALL_LOG"
    [[ "$output" == *"NOT applied"* ]]
}

@test "a failed seed after a restart is loud and NOT fatal (#1167)" {
    export EVAL_RC=3 SEED_RC=1
    run apply

    [ "$status" -eq 0 ]
    [[ "$output" == *"grappa seed-themes"* ]]
    [[ "$output" == *"applied by RESTART"* ]]
}

@test "a failed seed after a hot apply is loud and NOT fatal (#1167)" {
    export SEED_RC=1
    run apply

    [ "$status" -eq 0 ]
    [[ "$output" == *"grappa seed-themes"* ]]
    [[ "$output" == *"applied HOT"* ]]
}

# ── Wiring: every format reaches the script, and the restart migrates ────────
#
# Read off the shipped files. The behaviour above is worth nothing if a format
# does not install the script, or if the restart it falls back to starts the
# new code on the old schema.

@test "the package unit migrates in ExecStartPre, before the release starts" {
    local unit="$PKG_SRC/grappa.service"
    grep -qx "ExecStartPre=/usr/lib/grappa/bin/grappa eval 'Grappa.Release.migrate()'" "$unit"
    [ "$(grep -n '^ExecStartPre=' "$unit" | cut -d: -f1)" -lt "$(grep -n '^ExecStart=' "$unit" | cut -d: -f1)" ]
}

@test "the package unit gives the start, migrate included, 300 s (R7)" {
    # TimeoutStartSec bounds ExecStartPre too; the 30 s it had before would
    # kill a long migration halfway and fail the restart.
    grep -qx 'TimeoutStartSec=300' "$PKG_SRC/grappa.service"
}

@test "the deb and rpm install the script, executable, where the postinst calls it" {
    grep -A4 -- '- src: ./apply-upgrade.sh' "$PKG_SRC/nfpm.yaml" | grep -q 'dst: /usr/share/grappa/apply-upgrade.sh'
    grep -A4 -- '- src: ./apply-upgrade.sh' "$PKG_SRC/nfpm.yaml" | grep -q 'mode: 0755'
    grep -q '/usr/share/grappa/apply-upgrade.sh' "$PKG_SRC/scripts/postinstall.sh"
}

@test "the alpm hook fires after an upgrade that touched the release, and runs the script" {
    local hook="$PKG_SRC/aur/grappa-apply.hook"
    grep -qx 'Operation = Upgrade' "$hook"
    grep -qx 'Type = Path' "$hook"
    grep -qx 'Target = usr/lib/grappa/\*' "$hook"
    grep -qx 'When = PostTransaction' "$hook"
    grep -qx 'Exec = /usr/share/grappa/apply-upgrade.sh' "$hook"
}

@test "the PKGBUILD installs hook and script under usr/ — what a repackaging keeps" {
    # A repackaging of our .pkg.tar.zst that extracts usr/ and drops .INSTALL
    # (the community grappa-bin does) still gets both, and with them the apply.
    grep -q 'infra/packaging/aur/grappa-apply.hook' "$PKG_SRC/aur/PKGBUILD"
    grep -q '"${pkgdir}/usr/share/libalpm/hooks/grappa-apply.hook"' "$PKG_SRC/aur/PKGBUILD"
    grep -q 'install -Dm755 infra/packaging/apply-upgrade.sh' "$PKG_SRC/aur/PKGBUILD"
    grep -q '"${pkgdir}/usr/share/grappa/apply-upgrade.sh"' "$PKG_SRC/aur/PKGBUILD"
}

# The list items under overrides.<format>.depends in nfpm.yaml, comments out.
nfpm_depends() {
    awk -v fmt="$1" '
        /^  [a-z]+:$/ { in_fmt = ($0 == "  " fmt ":"); in_dep = 0; next }
        in_fmt && /^    [a-z]+:$/ { in_dep = ($0 == "    depends:"); next }
        in_fmt && in_dep && /^      - / { sub(/^      - /, ""); print }
    ' "$PKG_SRC/nfpm.yaml"
}

@test "every format depends on curl — the script's HTTP calls are all curl" {
    # Without curl the hot reload reads as "no answer" and no /healthz probe
    # after the restart ever succeeds: a healthy restart would fail the
    # upgrade. A minimal Debian ships no curl. Fedora's base ships
    # curl-minimal, hence a FILE dependency on the rpm side.
    grep -q '^[^#]*curl -' "$PKG_SRC/apply-upgrade.sh"
    run nfpm_depends deb
    [[ "$output" == *openssl* ]] # the extractor read the deb list at all
    grep -qx 'curl' <<<"$output"
    run nfpm_depends rpm
    [[ "$output" == *util-linux* ]] # ... and the rpm one
    grep -qx '/usr/bin/curl' <<<"$output"
    grep -qE "^depends=\(.*'curl'.*\)$" "$PKG_SRC/aur/PKGBUILD"
}
