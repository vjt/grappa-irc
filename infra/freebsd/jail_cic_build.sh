#!/bin/sh
# Build the cicchetto PWA bundle inside the jail.
# Runs as the grappa user; uses npm (jail has node24, not bun — FreeBSD
# pkg has no bun port).
#
# Usage:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_cic_build.sh
#
# Output: /home/grappa/grappa/runtime/cicchetto-dist/ (vite bundle).
# The BEAM self-serves it via Plug.Static since #485 — there is no
# /usr/local/www/cic symlink, and no nginx in the jail at all: the m42
# HOST vhost proxies straight to the BEAM.
#
# `runtime/cicchetto-dist` aligns the jail with the Docker substrate
# (`compose.yaml` bind-mounts it into the build oneshot so the same final
# path holds the bundle on host). The shared path is what
# `Grappa.Cic.Bundle.@bundle_path` reads unconditionally — both
# substrates, one server-side anchor.
#
# #1020: vite does NOT write there directly. The BEAM serves that
# directory per REQUEST, and `--emptyOutDir` wiped it at the START of the
# build, so the SPA was unloadable for the whole build and stayed broken
# if the build failed. The build now targets a staging sibling and
# infra/lib/cic_dist.sh renames it into place — see that file for the
# swap's failure window.

set -eu

# shellcheck disable=SC2016  # the single quotes are the point: this body
# is a script for the CHILD shell, where $PATH / $@ / $line resolve.
exec su -l grappa -c '
set -eu
cd /home/grappa/grappa/cicchetto
# #1020 — build-beside-then-swap. Sourced (not executed) so the promote
# runs in THIS shell, as grappa, with the same relative cwd the build uses.
. ../infra/lib/cic_dist.sh
served=../runtime/cicchetto-dist
staged="$(cic_dist_staging "$served")"
# #538/#652 — vite bakes GRAPPA_VERSION into <meta cicchetto-version>. Derive it
# from the repo-root VERSION file via the POSIX version.sh (this jail runs
# /bin/sh + npm, no bash/bun port). Single source of truth; same env channel every cic build
# uses. su -l scrubs the env, so set it INSIDE this login shell.
GRAPPA_VERSION="$(../infra/packaging/version.sh)"
export GRAPPA_VERSION
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
npm run build -- --outDir "$staged" --emptyOutDir >"$log" 2>&1 || { tail -30 "$log"; exit 1; }
tail -8 "$log"
cic_dist_promote "$served" "$staged"
echo "--- runtime/cicchetto-dist contents ---"
ls -la "$served"/
'
