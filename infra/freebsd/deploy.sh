#!/bin/sh
# Grappa native FreeBSD deploy — git pull + mix release + rc.d restart.
#
# Run inside the jail as the grappa user:
#   /home/grappa/grappa/infra/freebsd/deploy.sh
#
# Counterpart of `scripts/deploy.sh` for the Docker-based deploy: same
# end-to-end "pull → build → restart → healthcheck" arc, different
# substrate. NO hot-reload — release rebuilds always swap the BEAM
# wholesale. Sessions reset on every deploy.
#
# Exit codes: 0 ok, non-zero on any failure (set -e).

set -eu

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
RELEASE_PATH="${REPO_ROOT}/_build/prod/rel/grappa"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4000/healthz}"
HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-30}"
HEALTHCHECK_SLEEP="${HEALTHCHECK_SLEEP:-2}"

# Mix's hard-link-based compile lock fails inside bastille jails
# when /tmp is on a different ZFS dataset from the grappa user's
# home (cross-uid hard link returns "not owner"). The lock is only
# a safety net against concurrent mix invocations on the same tree
# — the deploy runs serially, so disabling it is safe.
export MIX_OS_CONCURRENCY_LOCK=0

cd "${REPO_ROOT}"

echo "[deploy] git pull --ff-only"
git pull --ff-only

echo "[deploy] mix deps.get --only prod"
MIX_ENV=prod mix deps.get --only prod

echo "[deploy] mix compile --warnings-as-errors"
MIX_ENV=prod mix compile --warnings-as-errors

# Migrations BEFORE rc.d restart — same reasoning as the Docker
# cold-path in scripts/deploy.sh: the release would 500 on first
# query against an outdated schema. `Grappa.Release.migrate/0`
# runs Ecto.Migrator without needing Mix on disk.
echo "[deploy] mix release --overwrite"
MIX_ENV=prod mix release --overwrite

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
(
	cd "${REPO_ROOT}/cicchetto"
	if [ -f package-lock.json ]; then
		npm ci 2>&1 | tail -10
	else
		npm install 2>&1 | tail -10
	fi
	npm run build 2>&1 | tail -10
)

echo "[deploy] Grappa.Release.migrate()"
"${RELEASE_PATH}/bin/grappa" eval 'Grappa.Release.migrate()'

# rc.d restart needs root. The deploy runs as the grappa user; sudo or
# doas is required for the service swap. If neither is available, this
# script will fail loudly here — that's the right behavior.
if command -v sudo >/dev/null 2>&1; then
	SU="sudo"
elif command -v doas >/dev/null 2>&1; then
	SU="doas"
else
	echo "[deploy] ERROR: neither sudo nor doas available — cannot restart service"
	exit 1
fi

echo "[deploy] service grappa restart"
${SU} service grappa restart

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
