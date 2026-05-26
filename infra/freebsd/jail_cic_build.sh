#!/bin/sh
# Build the cicchetto PWA bundle inside the jail.
# Runs as the grappa user; uses npm (jail has node24, not bun — FreeBSD
# pkg has no bun port).
#
# Usage:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_cic_build.sh
#
# Output: /home/grappa/grappa/cicchetto/dist/ (vite bundle, what
# nginx will serve).

set -eu

exec su -l grappa -c '
set -eu
cd /home/grappa/grappa/cicchetto
# Idempotent — npm ci re-syncs node_modules from package-lock; npm
# install is fine on first run. Prefer ci for reproducible builds.
if [ -f package-lock.json ]; then
	npm ci 2>&1 | tail -10
else
	npm install 2>&1 | tail -10
fi
npm run build 2>&1 | tail -20
echo "--- dist contents ---"
ls -la dist/
'
