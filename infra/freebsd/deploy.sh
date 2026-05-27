#!/bin/sh
# Grappa native FreeBSD deploy — git pull + mix release + rc.d restart.
#
# Run inside the jail as ROOT (the rc.d restart at the end needs it):
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh
#
# Counterpart of `scripts/deploy.sh` for the Docker-based deploy: same
# end-to-end "pull → build → restart → healthcheck" arc, different
# substrate. NO hot-reload — release rebuilds always swap the BEAM
# wholesale. Sessions reset on every deploy.
#
# The script runs as root but delegates every build step to
# `su -l grappa -c '...'` so the build artifacts (deps cache, _build,
# node_modules, cicchetto/dist) stay owned by the grappa user. Only
# the rc.d `service grappa restart` at the end runs as root directly.
#
# Exit codes: 0 ok, non-zero on any failure (set -e).

set -eu

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4000/healthz}"
HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-30}"
HEALTHCHECK_SLEEP="${HEALTHCHECK_SLEEP:-2}"

# All build steps run as the grappa user. `su -l grappa -c` strips
# the environment (login shell), so MIX_OS_CONCURRENCY_LOCK and PATH
# must be re-set inside each invocation. PATH includes the Erlang
# bin dir explicitly so `mix` is found without depending on the
# grappa user's .profile.
run_as_grappa() {
	cmd="$1"
	su -l grappa -c "
		set -eu
		export PATH=/usr/local/lib/erlang28/bin:\$PATH
		export MIX_OS_CONCURRENCY_LOCK=0
		export MIX_ENV=prod
		cd '${REPO_ROOT}'
		${cmd}
	"
}

echo "[deploy] git pull --ff-only"
run_as_grappa 'git pull --ff-only && git log --oneline -3'

echo "[deploy] mix deps.get --only prod"
run_as_grappa 'mix deps.get --only prod'

echo "[deploy] mix compile --warnings-as-errors"
run_as_grappa 'mix compile --warnings-as-errors'

# Migrations BEFORE rc.d restart — same reasoning as the Docker
# cold-path in scripts/deploy.sh: the release would 500 on first
# query against an outdated schema. `Grappa.Release.migrate/0`
# runs Ecto.Migrator without needing Mix on disk.
echo "[deploy] mix release --overwrite"
run_as_grappa 'mix release --overwrite'

# cicchetto bundle — vite build via npm. Required after a fresh
# `git clone` (cicchetto/dist/ is gitignored), and on every deploy
# that touched cicchetto/src/. The nginx symlink
# /usr/local/www/cic → cicchetto/dist/ is set up once by
# jail_install_nginx.sh; an empty dist/ here makes nginx loop on
# `try_files $uri /index.html` because neither resolves on disk
# (the "rewrite or internal redirection cycle" 500). Belt-and-
# braces: even when nothing in cicchetto/src/ changed, `npm run
# build` is fast (~40ms incremental), so we don't try to skip.
echo "[deploy] npm ci + vite build (cicchetto bundle)"
run_as_grappa '
	cd "'"${REPO_ROOT}"'/cicchetto"
	if [ -f package-lock.json ]; then
		npm ci 2>&1 | tail -10
	else
		npm install 2>&1 | tail -10
	fi
	npm run build 2>&1 | tail -10
'

echo "[deploy] Grappa.Release.migrate()"
# Delegate to jail_release.sh which has the canonical
# source-env-then-exec-bin/grappa flow (used by all other operator
# verbs against the live BEAM). One code path for the release entry
# point; deploy.sh does NOT re-implement env sourcing inline.
"${REPO_ROOT}/infra/freebsd/jail_release.sh" eval 'Grappa.Release.migrate()'

echo "[deploy] service grappa restart"
# epmd is started by the old BEAM but NOT killed on rc.d stop —
# next start sees `name grappa@grappa already in use` and refuses.
# Hard-kill epmd between stop and start to force a clean re-register.
service grappa stop || true
pkill epmd 2>/dev/null || true
sleep 1
service grappa start

echo "[deploy] healthcheck loop (${HEALTHCHECK_URL})"
i=0
while [ "${i}" -lt "${HEALTHCHECK_RETRIES}" ]; do
	if curl -fsS -o /dev/null "${HEALTHCHECK_URL}"; then
		echo "[deploy] healthy after ${i} retries"
		exit 0
	fi
	i=$((i + 1))
	sleep "${HEALTHCHECK_SLEEP}"
done

echo "[deploy] ERROR: healthcheck never returned 200 after $((HEALTHCHECK_RETRIES * HEALTHCHECK_SLEEP))s"
exit 1
