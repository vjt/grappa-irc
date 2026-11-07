#!/usr/bin/env bash
# grappa — update deploy for a native Linux (systemd) host. Run as root.
# Preflight-driven hot-vs-cold dispatcher.
#
# Thin consumer of the shared deploy algorithm in
# infra/lib/deploy_common.sh (#503) — the same lib that drives
# infra/freebsd/deploy.sh (jail) and scripts/deploy.sh (Docker). This
# script only sets config, flips the feature toggles below, and defines
# the systemd-specific hooks.
#
# Hot path (preflight returns HOT):
#   git pull -> mix release --overwrite -> POST /admin/reload
#   Sessions preserved (Erlang's 2-version code-loading guarantee).
#   No systemctl call at all.
#
# Cold path (preflight returns COLD):
#   git pull -> mix release --overwrite -> cic build -> migration check
#   -> refresh systemd unit -> systemctl stop -> migrate -> seed ->
#   systemctl start -> healthcheck loop. Sessions reset; the downtime is
#   the stop (bounded by TimeoutStopSec), the migrate and seed tasks, and
#   the boot.
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

# ---- lib config + feature toggles -----------------------------------
DEPLOY_SELF_REL="infra/linux/deploy.sh"
DEPLOY_USAGE="[--force-hot|--force-cold]"
DEPLOY_FEATURE_FORCE_FLAGS=1
DEPLOY_FEATURE_DEFER=0
DEPLOY_FEATURE_NOTHING_TO_DO=1
DEPLOY_FEATURE_REEXEC=1
DEPLOY_FEATURE_MARKER=1
DEPLOY_FEATURE_PREV_SHA_CARRY=1
DEPLOY_SEED_RETRY_HINT="sudo -u ${GRAPPA_USER} -H bash -c \"cd ${REPO_ROOT} && set -a; . ${ENV_FILE}; set +a; MIX_ENV=prod mix grappa.seed_themes\""
DEPLOY_RESTART_HINT="sudo systemctl start grappa"

run_as_grappa() {
	sudo -u "${GRAPPA_USER}" -H bash -c "
		export PATH=\"\$HOME/.local/bin:\$HOME/.asdf/shims:\$PATH\"
		cd '${REPO_ROOT}'
		$1
	"
}

# ---- substrate hooks ------------------------------------------------

substrate_pull() {
	PREV_SHA=$(run_as_grappa 'git rev-parse HEAD' | tail -1)
	# --recurse-submodules=on-demand completes the pull: without it a gitlink
	# bump leaves this checkout dirty forever and every release reports
	# X.Y.Z-<sha>. Why + why not the bare flag: infra/lib/deploy_common.sh,
	# above the substrate_pull call (#1851).
	run_as_grappa 'git pull --ff-only --recurse-submodules=on-demand && git log --oneline -3'
	NEW_SHA=$(run_as_grappa 'git rev-parse HEAD' | tail -1)
}

substrate_read_marker() {
	run_as_grappa "cat runtime/last-deployed-sha 2>/dev/null || true" | tail -1
}

substrate_write_marker() {
	# mkdir -p: the marker owns its dir, runtime/ may not exist yet.
	run_as_grappa "mkdir -p runtime && printf '%s\n' '${NEW_SHA}' > runtime/last-deployed-sha"
}

substrate_commit_exists() {
	# Boolean predicate. The lib evaluates it inside `base=$(...)`, so
	# suppress stdout too — not just stderr.
	run_as_grappa "git cat-file -e '$1^{commit}'" >/dev/null 2>&1
}

substrate_changed_files() {
	run_as_grappa "git diff --name-only '$1..$2'"
}

substrate_preflight() {
	# `mix run --no-start` boots the BEAM without starting the app. The env
	# file is sourced first: config/runtime.exs raises on missing
	# DATABASE_PATH & co, and `sudo -u ... bash -c` does not inherit the
	# systemd unit's EnvironmentFile.
	#
	# deps.get runs BEFORE the oneshot, `&&`-chained (#541): a pull that
	# moved mix.exs/mix.lock leaves deps stale and `mix run` aborts, so
	# preflight would exit 1 — a crash, not a 0/3 verdict — and strand the
	# deploy. A deps.get failure must surface as that abort, never as a
	# misclassified deploy.
	# Why: docs/OPERATIONS.md § "Native Linux and the cloud one-click box (infra/linux/, infra/cloud/)".
	run_as_grappa "
		set -a; . '${ENV_FILE}'; set +a
		export MIX_ENV=prod
		mix deps.get --only prod &&
		mix run --no-start -e 'Grappa.Deploy.Preflight.cli([\"$1\", \"$2\", \"linux\"])'
	"
}

substrate_build() {
	# MIX_ENV=prod required — without it mix defaults to :dev and compile
	# fails on the dev-only deps `--only prod` never fetched. The release
	# is rebuilt on BOTH paths: it writes fresh .beam into the daemon's
	# code path, which the hot reload POST then loads.
	deploy_log "mix deps.get --only prod / compile / release --overwrite"
	run_as_grappa '
		export MIX_ENV=prod
		mix deps.get --only prod
		mix compile --warnings-as-errors
		mix release --overwrite
	'
}

substrate_reload() {
	# Hot path: tell the live BEAM to md5-walk the release's ebin and
	# reload changed modules (Grappa.HotReload). No systemctl, no cic
	# rebuild — preflight only returns HOT when neither changed. It DOES
	# migrate (#41): pending EXPAND migrations are applied on the live
	# pool before the reload, and a pending contract one 409s. The lib
	# captures this hook's stdout as the reload response body, so the
	# pre-reload log must go to stderr.
	deploy_log "POST ${RELOAD_URL}" >&2
	curl -fsS -X POST "${RELOAD_URL}"
}

substrate_cic() {
	deploy_log "cic_build.sh"
	"${SCRIPT_DIR}/cic_build.sh" "${REPO_ROOT}"
}

substrate_check_migrations() {
	# The same door as substrate_migrate, auditing only — it runs while the
	# old daemon still serves, so a refusal stops nothing (issue 1112).
	deploy_log "check migrations"
	run_as_grappa "
		set -a; . '${ENV_FILE}'; set +a
		export MIX_ENV=prod
		mix grappa.check_migrations
	"
}

substrate_migrate() {
	# A mix task, not release eval — the packaged release's eval boot path
	# crashes the BEAM on this substrate (see install.sh). `grappa.migrate`
	# rather than `ecto.migrate` since #1348: it runs the same migrator with
	# the same footprint (Repo started, nothing else — no Endpoint, no
	# Bootstrap) and adds the duplicate-version audit that `ecto.migrate`
	# structurally cannot carry. The daemon is stopped by now (issue 1112).
	deploy_log "migrate"
	run_as_grappa "
		set -a; . '${ENV_FILE}'; set +a
		export MIX_ENV=prod
		mix grappa.migrate
	"
}

substrate_seed() {
	# A mix task, not a Grappa.Release entry point, for the same reason as
	# substrate_migrate. Mix.Tasks.Grappa.Boot suppresses Bootstrap AND the
	# Endpoint, so it opens no upstream IRC connection and does not fight
	# the running daemon for port 4000 — safe against a live host, which is
	# the whole point of seeding on a hot deploy.
	run_as_grappa "
		set -a; . '${ENV_FILE}'; set +a
		export MIX_ENV=prod
		mix grappa.seed_themes
	"
}

substrate_stop() {
	deploy_log "refresh systemd unit + grappa_beam_wait.sh (safe before stop — daemon-reload doesn't touch the already-running unit)"
	"${SCRIPT_DIR}/install_systemd.sh"

	deploy_log "systemctl stop grappa (blocks natively under Type=exec — no wait-loop needed)"
	systemctl stop grappa
}

substrate_start() {
	deploy_log "systemctl start grappa"
	systemctl start grappa
}

substrate_healthcheck() {
	# On a red probe re-ask WITHOUT `-f` so the 503 body (which names the
	# failing check) reaches the loop instead of /dev/null — see #1656 and the
	# hook contract in infra/lib/deploy_common.sh.
	curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz" && return 0
	curl -sS "http://127.0.0.1:${PORT}/healthz" 2>&1
	return 1
}

substrate_service_alive() {
	systemctl is-active --quiet grappa
}

substrate_done_banner() {
	deploy_log "✓ ${MODE} deploy complete (${NEW_SHA}) after $1 retries"
}

# ---- run ------------------------------------------------------------
# shellcheck source=infra/lib/deploy_common.sh
. "${SCRIPT_DIR}/../lib/deploy_common.sh"

deploy_main "$@"
