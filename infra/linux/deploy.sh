#!/usr/bin/env bash
# grappa — update deploy for a native Linux (systemd) host. Run as
# root. Preflight-driven hot-vs-cold dispatcher, sharing the
# Grappa.Deploy.Preflight classifier with scripts/deploy.sh (Docker)
# and infra/freebsd/deploy.sh (jail) — see lib/grappa/deploy/preflight.ex.
#
# Hot path (preflight returns HOT):
#   git pull -> mix release --overwrite -> POST /admin/reload
#   Sessions preserved (Erlang's 2-version code-loading guarantee).
#   No systemctl call at all.
#
# Cold path (preflight returns COLD):
#   git pull -> mix release --overwrite -> cic build -> migrate ->
#   refresh systemd unit -> systemctl stop/start -> healthcheck loop.
#   Sessions reset, ~seconds of downtime bounded by TimeoutStopSec.
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
RELOAD_URL="${RELOAD_URL:-http://127.0.0.1:${PORT}/admin/reload}"

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
	echo "[deploy] HEAD unchanged (${new_sha}) — proceeding anyway (no nothing-to-do fast path: this substrate has no separate cic-only deploy path, so a no-op pull cannot hide a pending change)"
fi

# ---- Preflight ----
#
# Source of truth: lib/grappa/deploy/preflight.ex (shared with
# scripts/deploy.sh and infra/freebsd/deploy.sh). `mix run --no-start`
# boots the BEAM without starting the application, so the check never
# touches the live DB or steps on the running release. The env file is
# sourced first: config/runtime.exs raises on missing DATABASE_PATH &
# co, and `sudo -u ... bash -c` does not inherit the systemd unit's
# EnvironmentFile.
#
# Preflight base is runtime/last-deployed-sha, NOT prev_sha (this run's
# pre-pull HEAD) — a prior run that pulled fresh commits but then died
# before finishing (release build failure, reload POST timeout, ssh
# drop) leaves the repo HEAD already past those commits, so THIS run's
# prev_sha==new_sha would classify an empty range as HOT and silently
# skip the migrate/cic/systemd-refresh that the dead run never actually
# applied. The marker is written as the last step of both paths below,
# so it always lags behind by exactly the work not yet proven applied.
last_deployed=$(run_as_grappa "cat runtime/last-deployed-sha 2>/dev/null || true" | tail -1)
preflight_base="${prev_sha}"
if [ -n "${last_deployed}" ]; then
	# Shape-check first (full 40-hex sha) so a garbage/truncated marker
	# never reaches a `bash -c` command line unvalidated, and confirm it
	# names a real commit — a rewritten history or a hand-edited file
	# must abort loudly here with a fix-it hint rather than crash the
	# mix oneshot with an opaque exit 1 that the case-statement below
	# would then have to guess the meaning of.
	marker_ok=no
	if [ "${#last_deployed}" -eq 40 ]; then
		case "${last_deployed}" in
			*[!0-9a-f]*) ;;
			*)
				if run_as_grappa "git cat-file -e '${last_deployed}^{commit}'" 2>/dev/null; then
					marker_ok=yes
				fi
				;;
		esac
	fi
	if [ "${marker_ok}" = "yes" ]; then
		preflight_base="${last_deployed}"
	else
		echo "[deploy] ERROR: runtime/last-deployed-sha contains '${last_deployed}' — not a full sha of a commit in this repo" >&2
		echo "[deploy]   fix the marker (write the last deployed sha to runtime/last-deployed-sha) before re-running" >&2
		exit 1
	fi
fi

echo "[deploy] preflight: classifying ${preflight_base}..${new_sha}"
preflight_rc=0
run_as_grappa "
	set -a; . '${ENV_FILE}'; set +a
	export MIX_ENV=prod
	mix run --no-start -e 'Grappa.Deploy.Preflight.cli([\"${preflight_base}\", \"${new_sha}\", \"linux\"])'
" || preflight_rc=$?

case "${preflight_rc}" in
	0) mode=hot ;;
	3) mode=cold ;;
	*)
		# Mix crash or usage error, not a verdict — falling through to
		# cold would silently convert a miswired call into "always
		# restart", and falling through to hot would silently convert
		# it into "never restart". Neither is a valid guess: abort loud.
		echo "[deploy] ERROR: preflight exited ${preflight_rc} (crash/usage, not a verdict) — aborting" >&2
		exit "${preflight_rc}"
		;;
esac

echo "[deploy] ==> mode: ${mode}"

echo "[deploy] mix deps.get --only prod / compile / release --overwrite"
# MIX_ENV=prod required — see install.sh's matching comment: without
# it mix defaults to :dev and compile fails on missing dev-only deps
# that --only prod deliberately never fetched.
#
# mix release --overwrite runs on BOTH paths: it writes fresh .beam
# into _build/prod/rel/grappa/lib/grappa-X.Y/ebin/, which is exactly
# the directory the live daemon's code path already includes. Without
# it the hot path's reload POST below would have nothing new to load.
run_as_grappa '
	export MIX_ENV=prod
	mix deps.get --only prod
	mix compile --warnings-as-errors
	mix release --overwrite
'

if [ "${mode}" = "hot" ]; then
	# Hot path: tell the live BEAM to walk :code.modified_modules/0 and
	# reload via :code.load_file/1. No systemctl call, no cic rebuild
	# (preflight only returns HOT when neither changed), no migration
	# (a new migration file classifies COLD on its own).
	echo "[deploy] POST ${RELOAD_URL}"
	if response=$(curl -fsS -X POST "${RELOAD_URL}"); then
		echo "[deploy] reload response: ${response}"
		# HTTP 200 is NOT success — the endpoint reports per-module
		# failures in-band (e.g. :old_code_in_use when a process still
		# runs a prior hot-reload's old code). Declaring success over a
		# failed reload would leave prod silently running stale code.
		case "${response}" in
		*'"failed":[]'*) ;;
		*)
			echo "[deploy] ERROR: reload reported per-module failures (see response above)" >&2
			echo "[deploy]   old code in use? retry once processes settle, or fix and re-run (a re-run reclassifies HOT again since nothing new changed)" >&2
			exit 1
			;;
		esac
	else
		echo "[deploy] ERROR: POST /admin/reload failed — daemon may be down or unreachable" >&2
		exit 1
	fi
else
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
fi

echo "[deploy] healthcheck loop"
i=0
while [ "${i}" -lt "${HEALTHCHECK_RETRIES}" ]; do
	if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz"; then
		run_as_grappa "printf '%s\n' '${new_sha}' > runtime/last-deployed-sha"
		echo "[deploy] ✓ ${mode} deploy complete (${new_sha}) after ${i} retries"
		exit 0
	fi
	i=$((i + 1))
	sleep "${HEALTHCHECK_SLEEP}"
done

echo "[deploy] ERROR: healthcheck never returned 200 after $((HEALTHCHECK_RETRIES * HEALTHCHECK_SLEEP))s — see: journalctl -u grappa -n 200" >&2
exit 1
