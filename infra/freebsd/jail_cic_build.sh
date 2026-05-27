#!/bin/sh
# Build the cicchetto PWA bundle inside the jail.
# Runs as the grappa user; uses npm (jail has node24, not bun — FreeBSD
# pkg has no bun port).
#
# Usage:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_cic_build.sh
#
# Output: /home/grappa/grappa/runtime/cicchetto-dist/ (vite bundle,
# what nginx serves via /usr/local/www/cic symlink — installed by
# jail_install_nginx.sh).
#
# `--outDir ../runtime/cicchetto-dist` aligns the jail with the Docker
# substrate (`compose.yaml` bind-mounts `./runtime/cicchetto-dist:
# /app/dist` so the same final path holds the bundle on host). The
# shared path is what `Grappa.Cic.Bundle.@bundle_path` reads
# unconditionally — both substrates, one server-side anchor.

set -eu

exec su -l grappa -c '
set -eu
cd /home/grappa/grappa/cicchetto
mkdir -p ../runtime/cicchetto-dist
# Idempotent — npm ci re-syncs node_modules from package-lock; npm
# install is fine on first run. Prefer ci for reproducible builds.
if [ -f package-lock.json ]; then
	npm ci 2>&1 | tail -10
else
	npm install 2>&1 | tail -10
fi
npm run build -- --outDir ../runtime/cicchetto-dist --emptyOutDir 2>&1 | tail -20
echo "--- runtime/cicchetto-dist contents ---"
ls -la ../runtime/cicchetto-dist/
'
