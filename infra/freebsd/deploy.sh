#!/bin/sh
# Grappa native FreeBSD deploy — preflight-driven hot-vs-cold dispatcher.
#
# Run inside the jail as ROOT (the rc.d restart on the cold path needs it):
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh --force-hot
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh --force-cold
#
# A thin consumer of the shared deploy algorithm in
# `infra/lib/deploy_common.sh`: this file sets config, flips the feature
# toggles the jail wants ON (all of them) and defines the substrate
# hooks; the lib owns the hot-vs-cold DECISION logic.
# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)" (#503).
#
# Hot path (default when preflight returns HOT):
#   git pull → mix compile → mix release --overwrite → POST /admin/reload
#   Sessions preserved (Erlang's 2-version code loading). NO service
#   restart.
#
# Cold path (preflight returns COLD or --force-cold):
#   git pull → mix release --overwrite → vite build → migrate →
#   service grappa restart → healthcheck loop. Sessions reset.
#
# Both paths reconcile the out-of-repo artifacts (the source-alias
# privilege wrapper + its DB-rendered prefix scope) after the build and
# before the reload/restart — see substrate_reconcile.
#
# Cic bundle is rebuilt on COLD only; cic-only deploys go through
# jail_deploy_cic.sh.
#
# The script runs as root but delegates every build step to
# `su -l grappa -c '...'` so artifacts stay owned by the grappa user.
#
# Exit codes: 0 ok, 64 usage, non-zero on any failure (set -e).

set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

# The jail's NAME. This script runs INSIDE the jail and never invokes
# bastille — but the hints below quote the HOST-side incantation, and those
# are what an operator pastes while production is down. They must name the
# same jail `scripts/deploy-m42.sh` addresses, so both read it from here.
# Why a constant and not a derivation: infra/lib/bastille_jail.sh (#2022).
# shellcheck source=infra/lib/bastille_jail.sh
. "${SCRIPT_DIR}/../lib/bastille_jail.sh"

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
ENV_FILE="${ENV_FILE:-/usr/local/etc/grappa/grappa.env}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4000/healthz}"
HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-30}"
HEALTHCHECK_SLEEP="${HEALTHCHECK_SLEEP:-2}"
RELOAD_URL="${RELOAD_URL:-http://127.0.0.1:4000/admin/reload}"

# ---- lib config + feature toggles -----------------------------------
DEPLOY_SELF_REL="infra/freebsd/deploy.sh"
DEPLOY_USAGE="[--force-hot|--force-cold] [--defer-restart]"
DEPLOY_FEATURE_FORCE_FLAGS=1
DEPLOY_FEATURE_DEFER=1
DEPLOY_FEATURE_NOTHING_TO_DO=1
DEPLOY_FEATURE_REEXEC=1
DEPLOY_FEATURE_MARKER=1
DEPLOY_FEATURE_PREV_SHA_CARRY=1
DEPLOY_FEATURE_RECONCILE=1
DEPLOY_SEED_RETRY_HINT="sudo bastille cmd ${BASTILLE_JAIL} ${REPO_ROOT}/infra/freebsd/jail_release.sh eval 'Grappa.Release.seed_themes()'"
# Host-side spelling, like the seed hint above: what the operator types, not
# what this script (already inside the jail) would run. `service grappa` is
# the rc.d SERVICE name and stays as it is — only the jail moves.
DEPLOY_RESTART_HINT="sudo bastille cmd ${BASTILLE_JAIL} service grappa start"

# Run one build step as the grappa user. `su -l` strips the environment,
# so PATH/MIX_ENV/MIX_OS_CONCURRENCY_LOCK are re-set inside every
# invocation; the Erlang bin dir is pinned so `mix` never depends on the
# user's .profile.
run_as_grappa() {
	su -l grappa -c "
		set -eu
		export PATH=/usr/local/lib/erlang28/bin:\$PATH
		export MIX_OS_CONCURRENCY_LOCK=0
		export MIX_ENV=prod
		cd '${REPO_ROOT}'
		$1
	"
}

# ---- substrate hooks ------------------------------------------------

# Read as the grappa user, never as root.
# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)".
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
	# mkdir -p: the marker owns its dir.
	run_as_grappa "mkdir -p runtime && printf '%s\n' '${NEW_SHA}' > runtime/last-deployed-sha"
}

substrate_commit_exists() {
	# Boolean predicate: suppress stdout as well as stderr.
	# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)".
	run_as_grappa "git cat-file -e '$1^{commit}'" >/dev/null 2>&1
}

substrate_changed_files() {
	run_as_grappa "git diff --name-only '$1..$2'"
}

substrate_preflight() {
	# `mix run --no-start` boots the BEAM without starting the app, under
	# MIX_ENV=prod with the env file sourced (set -a exports every
	# assignment). Refuse to run without it rather than decide a mode blind.
	if [ ! -r "${ENV_FILE}" ]; then
		deploy_error "env file ${ENV_FILE} not readable — cannot run preflight"
		exit 1
	fi
	# deps.get runs BEFORE the oneshot, `&&`-chained.
	# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)" (#541).
	run_as_grappa "set -a; . '${ENV_FILE}'; set +a; mix deps.get --only prod && mix run --no-start -e 'Grappa.Deploy.Preflight.cli([\"$1\", \"$2\", \"jail\"])'"
}

substrate_build() {
	# `mix release --overwrite` is REQUIRED in BOTH paths — it writes the
	# fresh .beam into the daemon's code path (lib/grappa-X.Y/ebin) that
	# the hot reload POST then loads.
	deploy_log "mix deps.get --only prod"
	run_as_grappa 'mix deps.get --only prod'
	deploy_log "mix compile --warnings-as-errors"
	run_as_grappa 'mix compile --warnings-as-errors'
	deploy_log "mix release --overwrite"
	run_as_grappa 'mix release --overwrite'
}

substrate_reconcile() {
	# Reconcile the out-of-repo mode-2 artifacts (wrapper in
	# /usr/local/sbin + DB-rendered scope config) on EVERY deploy, hot
	# included. Runs as root, like every non-build step here.
	# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)" (#646).
	deploy_log "install source-alias wrapper + prefix scope (jail_install_source_alias.sh)"
	"${REPO_ROOT}/infra/freebsd/jail_install_source_alias.sh"
}

substrate_reload() {
	# The lib captures this hook's stdout as the reload response body, so
	# pre-reload chatter goes to stderr.
	deploy_log "POST ${RELOAD_URL}" >&2
	curl -fsS -X POST "${RELOAD_URL}"
}

substrate_cic() {
	# Delegated to jail_cic_build.sh — one code path for the vite build +
	# outDir. Required after a fresh clone (dist is gitkeep-only) and
	# whenever cicchetto/src changed; cheap otherwise (~40ms incremental).
	deploy_log "vite build (cicchetto bundle)"
	"${REPO_ROOT}/infra/freebsd/jail_cic_build.sh"
}

substrate_migrate() {
	# Delegated to jail_release.sh — the canonical source-env-then-exec
	# flow. deploy.sh does NOT re-implement env sourcing inline.
	deploy_log "Grappa.Release.migrate()"
	"${REPO_ROOT}/infra/freebsd/jail_release.sh" eval 'Grappa.Release.migrate()'
}

substrate_seed() {
	# Same jail_release.sh door as substrate_migrate. The release has no
	# Mix, so this is a Grappa.Release entry point, not the mix task the
	# systemd substrate drives.
	# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)".
	deploy_log "Grappa.Release.seed_themes()"
	"${REPO_ROOT}/infra/freebsd/jail_release.sh" eval 'Grappa.Release.seed_themes()'
}

substrate_restart() {
	# Re-assert the BEAM-exit + name-release conditions after the stop,
	# even though the current rc.d wrapper's stop is synchronous.
	# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)".
	deploy_log "service grappa stop"
	service grappa stop || true
	"${REPO_ROOT}/infra/freebsd/jail_beam_wait.sh" wait-stopped grappa 20

	# Refresh the rc.d wrappers from the repo BETWEEN stop and start, so
	# the old daemon stopped through the wrapper that started it and the
	# new one boots through the new wrapper. Runs as root.
	deploy_log "refresh rc.d wrappers (jail_install_rcd.sh)"
	"${REPO_ROOT}/infra/freebsd/jail_install_rcd.sh"

	# --defer-restart: BEAM stopped and the new release + rc.d wrappers
	# staged, but deliberately no start, no healthcheck and no marker —
	# the host's single `bastille restart grappa` completes the deploy.
	# Why: docs/OPERATIONS.md § "The FreeBSD jail rails (infra/freebsd/)".
	if [ "${DEFER}" -eq 1 ]; then
		deploy_log "--defer-restart: BEAM stopped, new release+rc.d wrappers staged; host must bastille-restart ${BASTILLE_JAIL} to boot it (marker NOT written)"
		exit 0
	fi

	deploy_log "service grappa start"
	service grappa start
}

substrate_healthcheck() {
	# `-f` is what turns a non-2xx into a non-zero exit — and it is also what
	# throws the BODY away. /healthz answers 503 with a body naming the failing
	# check (`ready` / `repo` / `ets`) and its reason, so on a red probe ask
	# again WITHOUT `-f` and hand that answer up. Two requests happen only on
	# a probe that already failed; a healthy deploy still makes exactly one.
	# Why: the #1656 cold deploy discarded that answer 30 times.
	curl -fsS -o /dev/null "${HEALTHCHECK_URL}" && return 0
	curl -sS "${HEALTHCHECK_URL}" 2>&1
	return 1
}

substrate_service_alive() {
	# rc.subr's status_cmd → `bin/grappa pid` RPC against the live node. Same
	# probe grappa_start polls, so "alive" means the same thing to both.
	service grappa status >/dev/null 2>&1
}

substrate_done_banner() {
	if [ "$MODE" = hot ]; then
		deploy_log "✓ hot deploy complete (sessions preserved, daemon pid unchanged) after $1 retries"
	else
		deploy_log "✓ cold deploy complete (sessions reset, daemon respawned) after $1 retries"
	fi
}

# ---- run ------------------------------------------------------------
# SCRIPT_DIR is set at the top of the file — the jail-name lib is sourced
# before the hints that quote it, and one definition is enough for both.
# shellcheck source=infra/lib/deploy_common.sh
. "${SCRIPT_DIR}/../lib/deploy_common.sh"

deploy_main "$@"
