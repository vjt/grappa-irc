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
# 2026-06-10 uploads-2 deploy lesson: `cmd | tail` makes the pipeline
# exit status tail-s (plain sh has no pipefail), so set -e never fired
# on npm failures and the deploy reported success over a STALE bundle.
# Buffer to a log instead; print the tail only on failure (full log
# stays on disk for diagnosis), and let set -e do its job.
#
# npm ci needs package-lock.json in sync with package.json; the lock
# is generated in-jail (bun owns the canonical lock in-repo, FreeBSD
# has no bun port) so a dep added via bun makes ci fail — fall back
# to npm install, which regenerates the lock.
log=../runtime/cic-build.log
if [ -f package-lock.json ]; then
	npm ci >"$log" 2>&1 || npm install >"$log" 2>&1 || { tail -20 "$log"; exit 1; }
else
	npm install >"$log" 2>&1 || { tail -20 "$log"; exit 1; }
fi
tail -3 "$log"
npm run build -- --outDir ../runtime/cicchetto-dist --emptyOutDir >"$log" 2>&1 || { tail -30 "$log"; exit 1; }
tail -8 "$log"
echo "--- runtime/cicchetto-dist contents ---"
ls -la ../runtime/cicchetto-dist/
'
