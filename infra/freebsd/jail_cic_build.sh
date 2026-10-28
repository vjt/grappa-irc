#!/bin/sh
# Build the cicchetto PWA bundle inside the jail.
# Runs as the grappa user; uses npm (jail has node24, not bun — FreeBSD
# pkg has no bun port).
#
# Usage:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_cic_build.sh
#
# Output: /home/grappa/grappa/runtime/cicchetto-dist/ (vite bundle),
# served by the BEAM via Plug.Static — no nginx in the jail. The path is
# shared with the Docker substrate and is what
# `Grappa.Cic.Bundle.@bundle_path` reads unconditionally.
# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)" (#485).
#
# vite does NOT write to the served directory: it builds into a staging
# sibling and infra/lib/cic_dist.sh renames it into place (see that file
# for the swap's failure window).
# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)" (#1020).

set -eu

# shellcheck disable=SC2016  # the single quotes are the point: this body
# is a script for the CHILD shell, where $PATH / $@ / $line resolve.
exec su -l grappa -c '
set -eu
cd /home/grappa/grappa/cicchetto
# Sourced, not executed, so the promote runs in THIS shell, as grappa,
# with the same relative cwd the build uses.
. ../infra/lib/cic_dist.sh
served=../runtime/cicchetto-dist
staged="$(cic_dist_staging "$served")"
# vite bakes GRAPPA_VERSION into <meta cicchetto-version>; derive it from
# the repo-root VERSION file via the POSIX version.sh. su -l scrubs the
# env, so it must be set INSIDE this login shell.
# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)" (#538/#652).
GRAPPA_VERSION="$(../infra/packaging/version.sh)"
export GRAPPA_VERSION
# #1773 — the git facts behind the credit roll, on the same channel and inside
# the same login shell, for the same env-scrubbing reason. Derived HERE rather
# than spliced in from the parent: this whole body is one single-quoted string
# in the outer script, and a contributor name carrying an apostrophe would end
# that quote and hand the rest of the payload to the shell as code.
GRAPPA_CREDITS="$(../infra/packaging/credits.sh)"
export GRAPPA_CREDITS
# Never pipe npm into tail: buffer to a log and print the tail only on
# failure, so set -e still sees the npm exit status.
# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)".
#
# npm ci needs package-lock.json in sync with package.json; the in-jail
# lock can lag the canonical bun lock, so fall back to npm install, which
# regenerates it.
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
