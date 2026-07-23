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

# PATH must include ~grappa/.local/bin (bun lives there, installed by
# install_toolchain.sh) — `sudo -u ... bash -c` otherwise falls back to
# the system default PATH, which doesn't have it (found live on
# a native-Linux install, 2026-07-22: "bun: command not found" despite bun being
# installed and working fine when install_toolchain.sh itself checked it).
run_as_grappa() {
	sudo -u "${GRAPPA_USER}" -H bash -c "export PATH=\"\$HOME/.local/bin:\$HOME/.asdf/shims:\$PATH\"; $1"
}

echo "[cic_build] bun install && bun run build (outDir=${OUT_DIR})"
# Buffer output and only show it on failure — a clean build is noisy
# (vite + tsc output) and the interesting signal is the exit code;
# same pipefail-avoidance lesson as jail_cic_build.sh's header.
log="$(mktemp)"
trap 'rm -f "${log}"' EXIT
if ! run_as_grappa "cd '${CIC_DIR}' && bun install && bun run build -- --outDir '${OUT_DIR}' --emptyOutDir" >"${log}" 2>&1; then
	echo "[cic_build] ERROR: build failed — output:" >&2
	cat "${log}" >&2
	exit 1
fi

echo "[cic_build] done — ${OUT_DIR}"
