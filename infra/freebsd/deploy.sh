#!/bin/sh
# Grappa native FreeBSD deploy — preflight-driven hot-vs-cold dispatcher.
#
# Run inside the jail as ROOT (the rc.d restart on the cold path needs it):
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh --force-hot
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh --force-cold
#
# This is a THIN consumer of the shared deploy algorithm in
# `infra/lib/deploy_common.sh` (#503): it sets config, flips the feature
# toggles the jail wants ON (all of them — the jail is the most complete
# substrate), and defines the substrate-specific hooks. The lib owns the
# hot-vs-cold DECISION logic (marker base-select, re-exec guard,
# nothing-to-do, preflight verdict→mode, reload honesty, healthcheck
# loop) — one algorithm, shared with infra/linux/deploy.sh (systemd) and
# scripts/deploy.sh (Docker), so a fix here can no longer drift from the
# others (the 2026-06-11 outage root cause).
#
# Hot path (default when preflight returns HOT):
#   git pull → mix compile → mix release --overwrite → POST /admin/reload
#   Sessions preserved (Erlang's 2-version code-loading guarantee). NO
#   service restart.
#
# Cold path (preflight returns COLD or --force-cold):
#   git pull → mix release --overwrite → vite build → migrate →
#   service grappa restart → healthcheck loop. Sessions reset.
#
# Both paths reconcile the out-of-repo artifacts (the source-alias
# privilege wrapper + its DB-rendered prefix scope) after the build and
# before the reload/restart — see substrate_reconcile and #646.
#
# Cic bundle is rebuilt on COLD only; on HOT, server-side reload doesn't
# need the new bundle (cic deploys are orthogonal — jail_deploy_cic.sh).
#
# The script runs as root but delegates every build step to
# `su -l grappa -c '...'` so artifacts stay owned by the grappa user.
#
# Exit codes: 0 ok, 64 usage, non-zero on any failure (set -e).

set -eu

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

# All build steps run as the grappa user. `su -l grappa -c` strips the
# environment (login shell), so MIX_OS_CONCURRENCY_LOCK/PATH/MIX_ENV must
# be re-set inside each invocation. PATH includes the Erlang bin dir
# explicitly so `mix` is found without depending on the user's .profile.
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

# Read as the grappa user — root can't `git rev-parse` in a grappa-owned
# dir without a host-wide safe.directory config we'd rather not require.
substrate_pull() {
	PREV_SHA=$(run_as_grappa 'git rev-parse HEAD' | tail -1)
	run_as_grappa 'git pull --ff-only && git log --oneline -3'
	NEW_SHA=$(run_as_grappa 'git rev-parse HEAD' | tail -1)
}

substrate_read_marker() {
	run_as_grappa "cat runtime/last-deployed-sha 2>/dev/null || true" | tail -1
}

substrate_write_marker() {
	# mkdir -p: the marker owns its dir (no-op on a checkout where runtime/
	# already holds the DB; required for any checkout-less reuse).
	run_as_grappa "mkdir -p runtime && printf '%s\n' '${NEW_SHA}' > runtime/last-deployed-sha"
}

substrate_commit_exists() {
	# Boolean predicate — the lib evaluates this inside `base=$(...)`, so
	# suppress stdout too (not just stderr): a `su -l grappa` login shell
	# emitting a banner would otherwise splice into the captured range base.
	run_as_grappa "git cat-file -e '$1^{commit}'" >/dev/null 2>&1
}

substrate_changed_files() {
	run_as_grappa "git diff --name-only '$1..$2'"
}

substrate_preflight() {
	# `mix run --no-start` boots the BEAM without starting the app (so the
	# check never talks to the live DB or steps on the running release).
	# MIX_ENV=prod evaluates config/runtime.exs, which raises on missing
	# DATABASE_PATH & co. — sourced from the env file (set -a exports every
	# assignment). Refuse to run blind: a crash must never decide a mode.
	if [ ! -r "${ENV_FILE}" ]; then
		deploy_error "env file ${ENV_FILE} not readable — cannot run preflight"
		exit 1
	fi
	# deps.get runs BEFORE the oneshot (#541, Co-authored-by abonforti): a
	# pull that moved mix.exs/mix.lock leaves deps stale, and `mix run`
	# aborts on that — preflight would then exit 1 (a crash, not a 0/3
	# verdict) and the deploy would strand before ever reaching the build
	# step's own deps.get. `&&` so a deps.get failure surfaces as a
	# non-verdict abort; idempotent + cheap when in sync, and build re-runs
	# it so the preflight-skipping --force-* paths still fetch before compile.
	run_as_grappa "set -a; . '${ENV_FILE}'; set +a; mix deps.get --only prod && mix run --no-start -e 'Grappa.Deploy.Preflight.cli([\"$1\", \"$2\", \"jail\"])'"
}

substrate_build() {
	# mix release --overwrite is REQUIRED in BOTH paths: it writes fresh
	# .beam into the daemon's code path (lib/grappa-X.Y/ebin) — without it
	# the hot reload POST would have nothing new to load.
	deploy_log "mix deps.get --only prod"
	run_as_grappa 'mix deps.get --only prod'
	deploy_log "mix compile --warnings-as-errors"
	run_as_grappa 'mix compile --warnings-as-errors'
	deploy_log "mix release --overwrite"
	run_as_grappa 'mix release --overwrite'
}

substrate_reconcile() {
	# The mode-2 privilege wrapper lives in the repo and is installed into
	# /usr/local/sbin, with a scope config rendered from the DB. Nothing
	# else keeps those two in step with the checkout — and #646 measured
	# what that costs: the deploy that shipped #610 pulled the new wrapper,
	# never installed it (the installer ran on the cold path only, and a
	# wrapper-only change classifies HOT), so the new `probe` hit the old
	# wrapper, exited 64, disarmed mode 2, and 44 visitors were rejected.
	#
	# Runs as root, like every non-build step here: the script is invoked
	# `sudo bastille cmd grappa …`, and root is a property of that
	# invocation, not of the mode — the cold path's `install -o root -g
	# wheel` and `service grappa stop` already depend on it.
	deploy_log "install source-alias wrapper + prefix scope (jail_install_source_alias.sh)"
	"${REPO_ROOT}/infra/freebsd/jail_install_source_alias.sh"
}

substrate_reload() {
	# The lib captures this hook's stdout as the reload response body, so
	# the pre-reload chatter must go to stderr — else it pollutes the
	# JSON the "failed":[] honesty glob inspects.
	deploy_log "POST ${RELOAD_URL}" >&2
	curl -fsS -X POST "${RELOAD_URL}"
}

substrate_cic() {
	# Shared with jail_cic_build.sh — one code path for the vite build +
	# outDir. Required after a fresh clone (dist is gitkeep-only) and
	# whenever cicchetto/src changed; cheap otherwise (~40ms incremental).
	deploy_log "vite build (cicchetto bundle)"
	"${REPO_ROOT}/infra/freebsd/jail_cic_build.sh"
}

substrate_migrate() {
	# Delegate to jail_release.sh — the canonical source-env-then-exec
	# flow used by all other operator verbs. One code path for the release
	# entry point; deploy.sh does NOT re-implement env sourcing inline.
	deploy_log "Grappa.Release.migrate()"
	"${REPO_ROOT}/infra/freebsd/jail_release.sh" eval 'Grappa.Release.migrate()'
}

substrate_restart() {
	# The rc.d wrapper's stop is synchronous (defect #9), but re-assert
	# the BEAM-exit + name-release conditions anyway: the rc.d refresh
	# below runs BETWEEN stop and start, so a deploy that ships an rc.d
	# fix stops through the PREVIOUSLY INSTALLED wrapper — possibly one
	# that returns mid-drain — and a timed-out wait must never race start.
	deploy_log "service grappa stop"
	service grappa stop || true
	"${REPO_ROOT}/infra/freebsd/jail_beam_wait.sh" wait-stopped grappa 20

	# rc.d wrappers: refresh from the repo BETWEEN stop and start, so the
	# OLD daemon was stopped through the wrapper that started it and the
	# new daemon boots through the NEW wrapper. An rc.d/grappa diff
	# classifies COLD (Preflight class :rc_d), so this is what makes a
	# shipped wrapper change actually take effect. Runs as root.
	deploy_log "refresh rc.d wrappers (jail_install_rcd.sh)"
	"${REPO_ROOT}/infra/freebsd/jail_install_rcd.sh"

	# --defer-restart: stop here. The BEAM is stopped (through the OLD
	# wrapper) and the new release + rc.d wrappers are staged, but we
	# deliberately do NOT start, healthcheck, or write the marker — the
	# host's single `bastille restart grappa` boots the staged release in
	# one window and completes the deploy. Writing the marker here would
	# let the next auto deploy's nothing-to-do guard think this completed.
	if [ "${DEFER}" -eq 1 ]; then
		deploy_log "--defer-restart: BEAM stopped, new release+rc.d wrappers staged; host must bastille-restart grappa to boot it (marker NOT written)"
		exit 0
	fi

	deploy_log "service grappa start"
	service grappa start
}

substrate_healthcheck() {
	curl -fsS -o /dev/null "${HEALTHCHECK_URL}"
}

substrate_done_banner() {
	if [ "$MODE" = hot ]; then
		deploy_log "✓ hot deploy complete (sessions preserved, daemon pid unchanged) after $1 retries"
	else
		deploy_log "✓ cold deploy complete (sessions reset, daemon respawned) after $1 retries"
	fi
}

# ---- run ------------------------------------------------------------
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=infra/lib/deploy_common.sh
. "${SCRIPT_DIR}/../lib/deploy_common.sh"

deploy_main "$@"
