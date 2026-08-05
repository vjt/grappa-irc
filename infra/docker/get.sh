#!/bin/sh
# get.sh — one-line bootstrap for the checkout-less grappa Docker box
# (#503 unit D). The `curl … | bash` entry point for operators who want the
# pre-built ghcr image instead of compiling from a checkout:
#
#   install:  curl -fsSL https://raw.githubusercontent.com/vjt/grappa-irc/main/infra/docker/get.sh | bash
#   update:   curl -fsSL https://raw.githubusercontent.com/vjt/grappa-irc/main/infra/docker/get.sh | bash -s -- update
#
# What it does: mirror the two shell files the release-image deploy path
# needs — infra/docker/deploy.sh + the infra/lib/deploy_common.sh it SOURCES
# (`$SELF_DIR/../lib/deploy_common.sh`, so the mirror must reproduce that
# relative layout) — into $GRAPPA_HOME, then hand off to deploy.sh in RELEASE
# mode with the requested verb (default: the bare "make it so" verb — install
# a fresh box, else update). Everything else — secret generation, the
# PHX_HOST prompt, the data volume, COLD-only updates — is deploy.sh's job;
# this script only lays down the files and execs it. Re-running re-downloads
# both files (so a box always updates against the latest deploy machinery)
# before handing off.
#
# Updates on this path are ALWAYS cold: the release image ships no
# CodeReloader (hot-on-image is #503 unit E), so a recreate is the only safe
# verdict — deploy.sh's done-banner states which it performed.
#
# POSIX sh, dash-clean: it runs under whatever `| bash` / `| sh` the operator
# pipes it to, and it is linted `shellcheck -s sh` + `dash -n` in CI next to
# deploy_common.sh — no `local`, no arrays, no `[[ ]]`.

set -eu

RAW_BASE="${GRAPPA_RAW_BASE:-https://raw.githubusercontent.com/vjt/grappa-irc/main}"
# Mirror the SAME default deploy.sh's release branch uses, so the files this
# lays down and the env file deploy.sh looks for share one home.
GRAPPA_HOME="${GRAPPA_HOME:-$HOME/.grappa}"
export GRAPPA_HOME

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# curl is what fetched THIS script, so it is definitionally present in the
# piped one-liner — but a hand-run get.sh may not have it. Check first, before
# any file is touched, so the failure is one honest line, not a cryptic
# half-written mirror.
command -v curl >/dev/null 2>&1 || die "curl not found — install it (it is what fetched this script)."

DOCKER_DIR="$GRAPPA_HOME/infra/docker"
LIB_DIR="$GRAPPA_HOME/infra/lib"
PKG_DIR="$GRAPPA_HOME/infra/packaging"
DEPLOY="$DOCKER_DIR/deploy.sh"

# POSIX sh has no brace expansion — explicit mkdir -p per directory.
mkdir -p "$DOCKER_DIR" "$LIB_DIR" "$PKG_DIR"

# fetch URL DEST — download to a temp then move into place, so a failed
# download never leaves a half-written (yet executable) deploy.sh behind.
fetch() {
	say "Fetching $1"
	curl -fsSL "$1" -o "$2.tmp" || die "download failed: $1"
	mv "$2.tmp" "$2"
}

fetch "$RAW_BASE/infra/lib/deploy_common.sh"      "$LIB_DIR/deploy_common.sh"
# The ONE secret generator (#862). deploy.sh resolves it at ../packaging/
# relative to itself, mirroring the repo layout, and refuses to write an env
# file without it — so it is fetched here, not lazily.
fetch "$RAW_BASE/infra/packaging/gen-secrets.sh" "$PKG_DIR/gen-secrets.sh"
fetch "$RAW_BASE/infra/docker/deploy.sh"         "$DEPLOY"
chmod +x "$DEPLOY"

# Hand off. RELEASE mode is forced: a curl'd copy in $GRAPPA_HOME has no
# compose.yaml two levels up, so deploy.sh's auto-detect would land here
# anyway — force it so an odd layout can never flip us to source. PHX_HOST /
# GRAPPA_IMAGE / GRAPPA_PUBLISH ride through the exec via the environment; the
# PHX_HOST prompt reads /dev/tty, not the piped stdin, so `| bash` still asks.
say "Handing off to deploy.sh (release image)"
export GRAPPA_DEPLOY_MODE=release
exec "$DEPLOY" "$@"
