#!/usr/bin/env bats
#
# Bats suite for infra/docker/get.sh — the curl|bash one-liner bootstrap for
# the checkout-less release-image Docker box (#503 unit D).
#
# get.sh mirrors the two shell files the release deploy path needs
# (infra/docker/deploy.sh + the infra/lib/deploy_common.sh it sources) into
# $GRAPPA_HOME, then execs deploy.sh in RELEASE mode with the requested verb
# (default: the bare "make it so" verb).
#
# Scope: the mirrored layout it lays down + the hand-off to deploy.sh. `curl`
# is stubbed on PATH to copy the REAL local shell files instead of hitting
# raw.githubusercontent.com; `docker` is stubbed like the release-image suite
# so the exec'd deploy.sh touches no daemon. The REAL deploy.sh is exec'd, so
# this doubles as an integration check that the layout get.sh lays down is the
# one deploy.sh resolves deploy_common.sh through.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    GETSH="$REPO_SRC/infra/docker/get.sh"

    export GRAPPA_HOME="$BATS_TEST_TMPDIR/home"
    export ENV_FILE="$GRAPPA_HOME/grappa.env"
    export GRAPPA_IMAGE="ghcr.io/vjt/grappa:latest"

    # The "network": the real repo copies the stub curl serves back.
    export SRC_DEPLOY="$REPO_SRC/infra/docker/deploy.sh"
    export SRC_LIB="$REPO_SRC/infra/lib/deploy_common.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    export ARGV_LOG
    : > "$ARGV_LOG"

    # Fake `curl`: records the call, and (unless FAIL_CURL is set) copies the
    # matching local shell file to the -o destination instead of downloading.
    cat > "$FAKE_DIR/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$ARGV_LOG"
[ -n "${FAIL_CURL:-}" ] && exit 22
url=''; dest=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    -*) shift ;;
    *)  url="$1"; shift ;;
  esac
done
case "$url" in
  */infra/lib/deploy_common.sh) cp "$SRC_LIB" "$dest" ;;
  */infra/docker/deploy.sh)     cp "$SRC_DEPLOY" "$dest" ;;
  *) printf 'fake curl: unexpected url: %s\n' "$url" >&2; exit 1 ;;
esac
EOF
    chmod +x "$FAKE_DIR/curl"

    # Fake `docker`: same shape as the release-image suite — records calls,
    # inspect reports the container only when FAKE_CONTAINER_EXISTS is set,
    # `run … generate_key` prints the VAPID keypair the install parses.
    cat > "$FAKE_DIR/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$ARGV_LOG"
case "$1" in
  inspect)
    [ -n "${FAKE_CONTAINER_EXISTS:-}" ] || exit 1
    exit 0 ;;
  run)
    case "$*" in
      *generate_key*)
        printf 'VAPID_PUBLIC_KEY=FAKEPUBLICKEY\n'
        printf 'VAPID_PRIVATE_KEY=FAKEPRIVATEKEY\n' ;;
    esac
    exit 0 ;;
esac
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"
}

# ─────────────────────── mirror layout + hand-off ────────────────────────

@test "lays down the mirrored infra/{docker,lib} layout" {
    run "$GETSH" stop
    [ "$status" -eq 0 ]
    [ -x "$GRAPPA_HOME/infra/docker/deploy.sh" ]
    [ -f "$GRAPPA_HOME/infra/lib/deploy_common.sh" ]
}

@test "fetches both shell files from raw.githubusercontent.com/vjt/grappa-irc" {
    run "$GETSH" stop
    [ "$status" -eq 0 ]
    grep -q "raw.githubusercontent.com/vjt/grappa-irc/main/infra/docker/deploy.sh" "$ARGV_LOG"
    grep -q "raw.githubusercontent.com/vjt/grappa-irc/main/infra/lib/deploy_common.sh" "$ARGV_LOG"
}

@test "execs deploy.sh in RELEASE mode (release-only wording proves it)" {
    run "$GETSH" stop
    [ "$status" -eq 0 ]
    [[ "$output" == *"nothing to stop"* ]]
}

@test "passes the requested verb through to deploy.sh" {
    # `update` on a never-installed box is the release-mode 'never installed' die.
    run "$GETSH" update
    [ "$status" -ne 0 ]
    [[ "$output" == *"never installed"* ]]
}

@test "default (no verb) runs the bare verb → installs a fresh box" {
    PHX_HOST=x.example.org run "$GETSH"
    [ "$status" -eq 0 ]
    [ -f "$ENV_FILE" ]
    grep -qE "run -d .*--name grappa" "$ARGV_LOG"
}

@test "GRAPPA_RAW_BASE overrides the download origin (fork/branch)" {
    GRAPPA_RAW_BASE=https://example.test/gr run "$GETSH" stop
    [ "$status" -eq 0 ]
    grep -q "https://example.test/gr/infra/docker/deploy.sh" "$ARGV_LOG"
    grep -q "https://example.test/gr/infra/lib/deploy_common.sh" "$ARGV_LOG"
}

@test "a failed download aborts before laying down deploy.sh or exec'ing it" {
    FAIL_CURL=1 run "$GETSH" stop
    [ "$status" -ne 0 ]
    [[ "$output" == *"download failed"* ]]
    [ ! -f "$GRAPPA_HOME/infra/docker/deploy.sh" ]
    refute grep -q "inspect" "$ARGV_LOG"   # deploy.sh never ran
}

@test "missing curl fails loud" {
    # curl is the very first check, before any external tool: an empty PATH
    # makes `command -v curl` fail via shell builtins alone.
    PATH=/nonexistent run "$GETSH" stop
    [ "$status" -ne 0 ]
    [[ "$output" == *"curl not found"* ]]
}
