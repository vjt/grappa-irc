#!/usr/bin/env bash
# grappa — update deploy for a native Linux (systemd) host. Run as
# root. Cold-only by design: no hot/cold Grappa.Deploy.Preflight
# classification, unlike infra/freebsd/deploy.sh — LINUX.md's v1 scope
# deliberately skips that machinery until the base install is proven.
# Every deploy does a full stop -> rebuild -> migrate -> start cycle
# (sessions reset, ~seconds of downtime bounded by TimeoutStopSec).
#
# Usage: infra/linux/deploy.sh
#
# Env (same defaults as install.sh): REPO_ROOT, ENV_FILE, GRAPPA_USER, PORT

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
ENV_FILE="${ENV_FILE:-/etc/grappa/grappa.env}"
GRAPPA_USER="${GRAPPA_USER:-grappa}"
PORT="${PORT:-4000}"
HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-30}"
HEALTHCHECK_SLEEP="${HEALTHCHECK_SLEEP:-2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export REPO_ROOT ENV_FILE GRAPPA_USER

run_as_grappa() {
	sudo -u "${GRAPPA_USER}" -H bash -c "
		export PATH=\"\$HOME/.local/bin:\$HOME/.asdf/shims:\$PATH\"
		cd '${REPO_ROOT}'
		$1
	"
}

echo "[deploy] git pull --ff-only"
prev_sha=$(run_as_grappa 'git rev-parse HEAD' | tail -1)
run_as_grappa 'git pull --ff-only && git log --oneline -3'
new_sha=$(run_as_grappa 'git rev-parse HEAD' | tail -1)

# Self-modifying-deploy-script trap, ported from infra/freebsd/deploy.sh
# (this is POSIX/git filesystem semantics, not FreeBSD-specific): git
# pull replaces files by rename, so the running interpreter keeps
# executing PRE-PULL bytes from the old inode — a fix to this script
# would silently no-op on the first deploy that ships it. Re-exec so
# the new bytes run for everything downstream of the pull.
if [ -z "${DEPLOY_REEXECED:-}" ] \
	&& run_as_grappa "git diff --name-only '${prev_sha}..${new_sha}'" | grep -qx 'infra/linux/deploy.sh'; then
	echo "[deploy] deploy.sh changed in ${prev_sha}..${new_sha} — re-exec to load new bytes"
	export DEPLOY_REEXECED=1
	exec "${REPO_ROOT}/infra/linux/deploy.sh" "$@"
fi

if [ "${prev_sha}" = "${new_sha}" ]; then
	echo "[deploy] HEAD unchanged (${new_sha}) — proceeding anyway (cold-only, no nothing-to-do fast path in v1 scope)"
fi

echo "[deploy] mix deps.get --only prod / compile / release --overwrite"
# MIX_ENV=prod required — see install.sh's matching comment: without
# it mix defaults to :dev and compile fails on missing dev-only deps
# that --only prod deliberately never fetched.
run_as_grappa '
	export MIX_ENV=prod
	mix deps.get --only prod
	mix compile --warnings-as-errors
	mix release --overwrite
'

echo "[deploy] cic_build.sh"
"${SCRIPT_DIR}/cic_build.sh" "${REPO_ROOT}"

echo "[deploy] migrate"
# Plain `mix ecto.migrate`, not release.sh eval — see install.sh's
# matching comment: the packaged release's eval/remote/rpc boot path
# crashes the BEAM on this substrate (isolated to start_clean boot,
# not `bin/grappa start` — systemd's own path is unaffected).
run_as_grappa "
	set -a; . '${ENV_FILE}'; set +a
	export MIX_ENV=prod
	mix ecto.migrate
"

echo "[deploy] refresh systemd unit + grappa_beam_wait.sh (safe before stop — daemon-reload doesn't touch the already-running unit)"
"${SCRIPT_DIR}/install_systemd.sh"

echo "[deploy] systemctl stop grappa (blocks natively under Type=exec — no wait-loop needed)"
systemctl stop grappa

echo "[deploy] systemctl start grappa"
systemctl start grappa

echo "[deploy] healthcheck loop"
i=0
while [ "${i}" -lt "${HEALTHCHECK_RETRIES}" ]; do
	if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz"; then
		# Kept for forward-compat with a future hot/cold port (not
		# currently read back by anything on this substrate — the
		# infra/freebsd equivalent uses it for Preflight's base-of-diff;
		# this cold-only script always does a full cycle regardless).
		run_as_grappa "printf '%s\n' '${new_sha}' > runtime/last-deployed-sha"
		echo "[deploy] done (${new_sha})"
		exit 0
	fi
	i=$((i + 1))
	sleep "${HEALTHCHECK_SLEEP}"
done

echo "[deploy] ERROR: healthcheck never returned 200 after $((HEALTHCHECK_RETRIES * HEALTHCHECK_SLEEP))s — see: journalctl -u grappa -n 200" >&2
exit 1
