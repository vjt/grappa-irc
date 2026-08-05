#!/usr/bin/env bats
#
# infra/linux/install.sh — the first-install orchestrator for the native
# systemd substrate. #441: this file had NO automated gate of any kind. It is
# also the file whose defects filed the issue, and its own comments record
# three that reached a live host:
#
#   * 2026-07-22 — PHX_HOST stayed at the template's `grappa.example.org`
#     forever, because the seed-if-blank writer saw the example value as
#     "already set". Fixed by splitting force_set_env out; nothing pinned it.
#   * 2026-07-24 — `mix grappa.gen_vapid` prints FOUR lines, and routing it
#     through the single-line `gen` helper's `tail -n1` kept the last COMMENT
#     and discarded both keys. The app then booted "fine" with Web Push
#     silently dead, because an env var set to "" is not nil.
#   * the tmp+mv rewrite in both env writers births a fresh inode under
#     root's umask (0644 root:root), dropping the 0640 root:grappa the
#     secrets need. Re-locked in both writers — twice, because the first fix
#     missed force_set_env, which runs LAST.
#
# So the subject here is the ENV FILE, and every assertion is about its
# CONTENTS or its MODE — the outcome an operator gets — never about which
# helper was called in what order.
#
# Scope: the pure shell-side logic. Everything that needs a real host is
# stubbed on PATH (sudo, mix, openssl, systemctl, curl) or replaced with a
# recorder (the five sibling scripts install.sh delegates to by absolute
# SCRIPT_DIR path), mirroring test/infra/deploy_linux_test.bats. `chown` is a
# no-op because the suite does not run as root; `chmod` is deliberately NOT
# stubbed, so the final mode assertion is a real stat of a real file.

load ../bats_helpers

setup() {
    SRC_DIR="$BATS_TEST_DIRNAME/../../infra/linux"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"

    # Empty HOME: install.sh's run_as_grappa body prepends
    # $HOME/.local/bin:$HOME/.asdf/shims to PATH, and a real asdf on the dev
    # host would shadow the `mix` stub with a real toolchain.
    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"

    # ---- a checkout that already exists, so the clone branch is skipped ---
    export REPO_ROOT="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$REPO_ROOT/.git" "$REPO_ROOT/infra/linux"
    cp "$SRC_DIR/grappa.env.example" "$REPO_ROOT/infra/linux/grappa.env.example"

    # ---- install.sh + recorders for the five delegates -------------------
    INSTALL_DIR="$BATS_TEST_TMPDIR/installer"
    mkdir -p "$INSTALL_DIR"
    cp "$SRC_DIR/install.sh" "$INSTALL_DIR/install.sh"
    chmod +x "$INSTALL_DIR/install.sh"
    for stub in install_prereqs.sh install_toolchain.sh cic_build.sh \
        install_systemd.sh install_nginx.sh; do
        printf '#!/bin/sh\nexit 0\n' > "$INSTALL_DIR/$stub"
        chmod +x "$INSTALL_DIR/$stub"
    done

    export ENV_FILE="$BATS_TEST_TMPDIR/grappa.env"
    export GRAPPA_USER=grappa
    export PHX_HOST=irc.test.example
    export PORT=4444

    # `mix` failure injection for the fail-loud case.
    export MIX_GEN_RC=0
    export MIX_GEN_RC_FILE="$BATS_TEST_TMPDIR/mix-gen-rc"

    # ---- PATH stubs ------------------------------------------------------
    # sudo -u grappa -H bash -c '<cmd>' → run <cmd> in-process, dropping the
    # privilege flags. The stubs the body reaches read only ambient env.
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

    # mix: deterministic generators, in the REAL output shapes. gen_vapid
    # prints four lines (two keys, two comments) — the 2026-07-24 shape that
    # a tail -n1 silently reduced to a comment. A leading `warning:` line
    # exercises the filter gen_raw applies.
    cat > "$FAKE_DIR/mix" <<'EOF'
#!/bin/sh
# Failure injection is scoped to the GENERATORS. Failing every mix verb
# would abort back at the build step and prove nothing about the
# secrets bootstrap, which is what this models.
case "$*" in
    phx.gen.secret*|grappa.gen_*)
        if [ -f "$MIX_GEN_RC_FILE" ]; then
            echo "mix: the generator blew up" >&2
            exit 1
        fi
        ;;
esac
case "$*" in
    "phx.gen.secret 32")
        echo "warning: the VM is running with native name encoding"
        echo "SALT-thirty-two-chars-deterministic"
        ;;
    "phx.gen.secret")
        echo "BASE-secret-key-deterministic"
        ;;
    "grappa.gen_encryption_key")
        echo "CLOAK-key-deterministic"
        ;;
    "grappa.gen_vapid")
        echo "VAPID_PUBLIC_KEY=PUB-deterministic"
        echo "VAPID_PRIVATE_KEY=PRIV-deterministic"
        echo "# paste both into your env file"
        echo "# back the private key up"
        ;;
esac
exit 0
EOF

    printf '#!/bin/sh\necho COOKIE-deterministic\n' > "$FAKE_DIR/openssl"

    # chown: the suite is not root. chmod is NOT stubbed — the mode is the
    # property under test.
    printf '#!/bin/sh\nexit 0\n' > "$FAKE_DIR/chown"

    # install(1): the -o/-g ownership needs root, the -m mode does not. Keep
    # the mode, drop the ownership, so the created file's mode is real.
    cat > "$FAKE_DIR/install" <<'EOF'
#!/bin/sh
mode=""
dirmode=0
while [ $# -gt 0 ]; do
    case "$1" in
        -d) dirmode=1; shift ;;
        -m) mode="$2"; shift 2 ;;
        -o|-g) shift 2 ;;
        --) shift; break ;;
        -*) shift ;;
        *) break ;;
    esac
done
if [ "$dirmode" -eq 1 ]; then
    mkdir -p "$@"
    [ -n "$mode" ] && chmod "$mode" "$@"
    exit 0
fi
src="$1"; dst="$2"
cp "$src" "$dst"
[ -n "$mode" ] && chmod "$mode" "$dst"
exit 0
EOF

    printf '#!/bin/sh\nexit 0\n' > "$FAKE_DIR/systemctl"
    printf '#!/bin/sh\nexit 0\n' > "$FAKE_DIR/curl"
    printf '#!/bin/sh\nexit 0\n' > "$FAKE_DIR/git"

    chmod +x "$FAKE_DIR"/*
    export PATH="$FAKE_DIR:$PATH"
}

# All lines in the env file for KEY — plural on purpose: a writer that
# appends without removing the old line leaves TWO, and the last one wins at
# systemd load time while `grep -m1` would happily report the first.
env_lines() {
    grep -c "^$1=" "$ENV_FILE" || true
}

env_value() {
    sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1
}

@test "a missing PHX_HOST aborts before anything is written (#441)" {
    unset PHX_HOST

    run "$BATS_TEST_TMPDIR/installer/install.sh"

    [ "$status" -eq 1 ]
    [[ "$output" == *"PHX_HOST is required"* ]]
    refute test -f "$ENV_FILE"
}

@test "the operator's PHX_HOST and PORT replace the template's example values (#441)" {
    # The 2026-07-22 live defect: grappa.env.example ships a NON-blank,
    # non-REPLACE_ME `PHX_HOST=grappa.example.org`, so a seed-if-blank writer
    # treats it as already configured and the host never changes.
    run "$BATS_TEST_TMPDIR/installer/install.sh"
    [ "$status" -eq 0 ]

    [ "$(env_value PHX_HOST)" = "irc.test.example" ]
    [ "$(env_value PORT)" = "4444" ]
    # And exactly once each: the rewrite must REPLACE, not append beside the
    # template line.
    [ "$(env_lines PHX_HOST)" -eq 1 ]
    [ "$(env_lines PORT)" -eq 1 ]
}

@test "every REPLACE_ME secret is filled in from its generator (#441)" {
    run "$BATS_TEST_TMPDIR/installer/install.sh"
    [ "$status" -eq 0 ]

    [ "$(env_value SECRET_KEY_BASE)" = "BASE-secret-key-deterministic" ]
    [ "$(env_value SECRET_SIGNING_SALT)" = "SALT-thirty-two-chars-deterministic" ]
    [ "$(env_value GRAPPA_ENCRYPTION_KEY)" = "CLOAK-key-deterministic" ]
    [ "$(env_value RELEASE_COOKIE)" = "COOKIE-deterministic" ]
    refute grep -q 'REPLACE_ME' "$ENV_FILE"
}

@test "the VAPID pair lands whole, from a four-line generator (#441)" {
    # The 2026-07-24 live defect: `mix grappa.gen_vapid` prints two keys and
    # two comment lines, and the single-line `gen` helper's tail -n1 kept the
    # last COMMENT. Both keys ended up empty, and `System.get_env || raise`
    # never fired because "" is not nil — Web Push was silently dead.
    run "$BATS_TEST_TMPDIR/installer/install.sh"
    [ "$status" -eq 0 ]

    [ "$(env_value VAPID_PUBLIC_KEY)" = "PUB-deterministic" ]
    [ "$(env_value VAPID_PRIVATE_KEY)" = "PRIV-deterministic" ]
    [ "$(env_lines VAPID_PUBLIC_KEY)" -eq 1 ]
    [ "$(env_lines VAPID_PRIVATE_KEY)" -eq 1 ]
    refute grep -qE '^VAPID_(PUBLIC|PRIVATE)_KEY=(#|$)' "$ENV_FILE"
}

@test "the finished env file is 0640, not the tmp+mv default (#441)" {
    # Both writers rewrite via `grep -v > tmp && mv`, which births a fresh
    # inode under root's umask and drops the mode the secrets need.
    # force_set_env runs LAST (the config values), so the re-lock has to be
    # in that one too — it was missing once.
    run "$BATS_TEST_TMPDIR/installer/install.sh"
    [ "$status" -eq 0 ]

    [ "$(file_mode "$ENV_FILE")" = "640" ]
}

@test "a re-run keeps the secrets and still re-applies the config values (#441)" {
    # Idempotency is the whole reason the two writers are separate: secrets
    # are seed-once (regenerating them invalidates every stored credential),
    # config is this-invocation-wins.
    run "$BATS_TEST_TMPDIR/installer/install.sh"
    [ "$status" -eq 0 ]
    first_secret="$(env_value SECRET_KEY_BASE)"
    first_vapid="$(env_value VAPID_PRIVATE_KEY)"

    PHX_HOST=second.test.example PORT=5555 run "$BATS_TEST_TMPDIR/installer/install.sh"
    [ "$status" -eq 0 ]

    [ "$(env_value SECRET_KEY_BASE)" = "$first_secret" ]
    [ "$(env_value VAPID_PRIVATE_KEY)" = "$first_vapid" ]
    [ "$(env_value PHX_HOST)" = "second.test.example" ]
    [ "$(env_value PORT)" = "5555" ]
    [ "$(env_lines PHX_HOST)" -eq 1 ]
}

@test "ONE failing generator is enough to abort — no exit-0 with a blank key (#441)" {
    # The severe half, measured on the pre-#441 script: with only
    # gen_encryption_key failing, the VAPID belt-and-braces check (the one
    # empty-test that sits OUTSIDE a command substitution) never fires, so
    # nothing stopped the run. It printed its loud ERROR, wrote
    # `GRAPPA_ENCRYPTION_KEY=`, started the unit, passed the healthcheck and
    # exited 0 announcing a healthy host — with the Cloak vault keyed on the
    # empty string. Loud and fail-OPEN is not fail-closed.
    cat > "$FAKE_DIR/mix" <<'EOF'
#!/bin/sh
case "$*" in
    grappa.gen_encryption_key) echo "mix: the generator blew up" >&2; exit 1 ;;
    "phx.gen.secret 32") echo "SALT-thirty-two-chars-deterministic" ;;
    "phx.gen.secret") echo "BASE-secret-key-deterministic" ;;
    grappa.gen_vapid)
        echo "VAPID_PUBLIC_KEY=PUB-deterministic"
        echo "VAPID_PRIVATE_KEY=PRIV-deterministic"
        ;;
esac
exit 0
EOF
    chmod +x "$FAKE_DIR/mix"

    run "$BATS_TEST_TMPDIR/installer/install.sh"

    [ "$status" -ne 0 ]
    refute grep -qE '^GRAPPA_ENCRYPTION_KEY=$' "$ENV_FILE"
}

@test "a failing generator aborts loudly instead of writing a blank secret (#441)" {
    # The third 2026-07-22 defect: the generator's stderr was discarded, so
    # `set -e` aborted the script SILENTLY and three secrets had already been
    # written as empty strings.
    touch "$MIX_GEN_RC_FILE"

    run "$BATS_TEST_TMPDIR/installer/install.sh"

    [ "$status" -ne 0 ]
    [[ "$output" == *"failed"* ]]
    [[ "$output" == *"the generator blew up"* ]]
    # Whatever it managed to write, it must not have left a blank secret
    # behind for the operator to boot on.
    if [ -f "$ENV_FILE" ]; then
        refute grep -qE '^(SECRET_KEY_BASE|SECRET_SIGNING_SALT|GRAPPA_ENCRYPTION_KEY|VAPID_[A-Z]+_KEY)=$' "$ENV_FILE"
    fi
}
