#!/bin/sh
# Cic-only deploy on the bastille jail — vite bundle rebuild + live
# hash broadcast, no BEAM restart.
#
# Run inside the jail as ROOT (jail_cic_build.sh drops to grappa via
# su -l; the curl runs as root against loopback):
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_deploy_cic.sh
#
# What it does (mirrors scripts/deploy-cic.sh for Docker):
#   1. git pull --ff-only (so the working tree matches what we're about
#      to build — operator can skip the separate jail_git_pull.sh step)
#   2. npm ci + vite build into cicchetto/dist/ (jail_cic_build.sh)
#   3. POST /admin/cic-bundle-changed so the live BEAM re-reads the
#      new index.html and broadcasts the bundle hash on every
#      user-topic. cic clients compare against the hash baked into
#      their currently-loaded page and surface the refresh banner on
#      mismatch.
#
# What it does NOT do: touch the BEAM. No mix compile, no mix release,
# no service restart. Use for cic-only changes (cicchetto/src/,
# cicchetto/index.html, vite.config.ts manifest tweaks) where rebooting
# the bouncer is unacceptable. Server-side changes still go through
# deploy.sh (which auto-classifies hot vs cold).
#
# Exit codes: 0 ok, non-zero on any failure (set -e).

set -eu

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
RELOAD_URL="${RELOAD_URL:-http://127.0.0.1:4000/admin/cic-bundle-changed}"

echo "[deploy-cic] git pull --ff-only"
su -l grappa -c "
	set -eu
	cd '${REPO_ROOT}'
	git pull --ff-only
	git log --oneline -3
"

echo "[deploy-cic] vite build (cicchetto bundle)"
"${REPO_ROOT}/infra/freebsd/jail_cic_build.sh"

echo "[deploy-cic] POST ${RELOAD_URL}"
if hash=$(curl -fsS -X POST "${RELOAD_URL}"); then
	if [ -z "${hash}" ]; then
		echo "[deploy-cic] ✓ cic dist built; server returned 204 (no bundle on disk?)"
	else
		echo "[deploy-cic] ✓ cic dist built + broadcast hash=${hash} to all live user-topics"
	fi
else
	echo "[deploy-cic] ERROR: POST /admin/cic-bundle-changed failed — is grappa up?"
	exit 1
fi
