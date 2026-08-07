#!/usr/bin/env bash
# Build cicchetto's static SPA into runtime/cicchetto-dist, as the
# grappa user.
#
# Port of infra/freebsd/jail_cic_build.sh — but FreeBSD pkg has no bun
# port, so that script falls back to npm (regenerating package-lock.json
# from the bun-canonical bun.lock). Linux has native bun packages, so
# this uses bun directly — closer to dev tooling (scripts/bun.sh), no
# lockfile-regeneration workaround needed.
#
# Usage: infra/linux/cic_build.sh [repo_root]
# Idempotent — safe to re-run; `bun install` is a no-op when the
# lockfile is already satisfied.

set -euo pipefail

REPO_ROOT="${1:-/home/grappa/grappa}"
CIC_DIR="${REPO_ROOT}/cicchetto"
OUT_DIR="${REPO_ROOT}/runtime/cicchetto-dist"
GRAPPA_USER="${GRAPPA_USER:-grappa}"

# #1020 — OUT_DIR is what the running BEAM serves, per request. Vite must not
# write into it: it builds into a staging sibling and the shared lib renames
# that into place afterwards. Sourced from the SCRIPT's own dir, not from
# REPO_ROOT — the lib ships with this script, and the arg only names the
# checkout the bundle is built FROM.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CIC_DIST_LIB="${SCRIPT_DIR}/../lib/cic_dist.sh"
# shellcheck source=infra/lib/cic_dist.sh
. "${CIC_DIST_LIB}"
STAGE_DIR="$(cic_dist_staging "${OUT_DIR}")"

# #538/#652 — vite bakes GRAPPA_VERSION into <meta cicchetto-version>. Derive it
# from the repo-root VERSION file (the single source of truth) via version.sh; `sudo -u`
# scrubs the env, so it is injected into the run_as_grappa command string below.
GRAPPA_VERSION="$("${REPO_ROOT}/infra/packaging/version.sh")"

# PATH must include ~grappa/.local/bin (bun lives there, installed by
# install_toolchain.sh) — `sudo -u ... bash -c` otherwise falls back to
# the system default PATH, which doesn't have it (found live on
# a native-Linux install, 2026-07-22: "bun: command not found" despite bun being
# installed and working fine when install_toolchain.sh itself checked it).
run_as_grappa() {
	sudo -u "${GRAPPA_USER}" -H bash -c "export PATH=\"\$HOME/.local/bin:\$HOME/.asdf/shims:\$PATH\"; $1"
}

echo "[cic_build] bun install && bun run build (outDir=${STAGE_DIR} → ${OUT_DIR})"
# Buffer output and only show it on failure — a clean build is noisy
# (vite + tsc output) and the interesting signal is the exit code;
# same pipefail-avoidance lesson as jail_cic_build.sh's header.
log="$(mktemp)"
trap 'rm -f "${log}"' EXIT
if ! run_as_grappa "export GRAPPA_VERSION='${GRAPPA_VERSION}'; cd '${CIC_DIR}' && bun install && bun run build -- --outDir '${STAGE_DIR}' --emptyOutDir" >"${log}" 2>&1; then
	echo "[cic_build] ERROR: build failed — output:" >&2
	cat "${log}" >&2
	exit 1
fi
# Swap as grappa, like every other step here: the renames need write on
# runtime/, and doing them as root would plant a root-owned .gitkeep inside a
# grappa-owned tree. The tracked placeholder is planted by the promote itself
# now, so the post-build `touch` this replaces is gone — it only ever existed
# to undo the in-place wipe.
run_as_grappa ". '${CIC_DIST_LIB}'; cic_dist_promote '${OUT_DIR}' '${STAGE_DIR}'"

echo "[cic_build] done — ${OUT_DIR}"
