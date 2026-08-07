#!/usr/bin/env bash
# Operator Docker deploy — auto-detects hot-vs-cold via the shared
# Grappa.Deploy.Preflight classifier, then dispatches.
#
# Thin consumer of the shared deploy algorithm in
# infra/lib/deploy_common.sh (#503) — the same lib that drives
# infra/freebsd/deploy.sh (jail) and infra/linux/deploy.sh (systemd), so
# the hot-vs-cold DECISION logic can no longer drift between substrates.
# This script sets config, flips the toggles this substrate has today
# (--force-* flags only; NO marker / re-exec / nothing-to-do yet — those
# arrive with #503's enrich step), and defines the Docker-specific hooks.
#
# CP23's `cluster/code-reload` shipped Phoenix.CodeReloader for the
# running grappa container, so most deploys are hot: `git pull` + `POST
# /admin/reload` swaps modules in the live BEAM without restart. Some
# module-shape changes can't be hot-swapped (mix.lock/mix.exs,
# application.ex supervision tree, long-lived GenServer state shape) —
# Phoenix.CodeReloader accepts the reload but the new code crashes at the
# first message that exposes the shape change. The preflight
# (lib/grappa/deploy/preflight.ex, the single source of truth shared by
# all three substrates) diffs for those unsafe markers and refuses hot.
#
# Cic deploys are orthogonal — scripts/deploy-cic.sh handles the Vite
# bundle + cic-bundle-changed broadcast independently.
#
# Usage:
#   scripts/deploy.sh                # auto-detect
#   scripts/deploy.sh --force-hot
#   scripts/deploy.sh --force-cold

set -euo pipefail

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"
# shellcheck source=infra/lib/cic_dist.sh
. "$(dirname "$0")/../infra/lib/cic_dist.sh"

# #364 docker S10: assert main-checkout + main-branch BEFORE any side
# effect (the git pull below mutates REPO_ROOT). in_container's own
# worktree guard fires too late — the pull already happened.
require_main_checkout "deploy.sh"

cd "$REPO_ROOT"

# ---- lib config + feature toggles -----------------------------------
DEPLOY_SELF_REL="scripts/deploy.sh"
DEPLOY_USAGE="[--force-hot|--force-cold]"
DEPLOY_FEATURE_FORCE_FLAGS=1
DEPLOY_FEATURE_DEFER=0
DEPLOY_FEATURE_NOTHING_TO_DO=0
DEPLOY_FEATURE_REEXEC=1
DEPLOY_FEATURE_MARKER=1
DEPLOY_FEATURE_PREV_SHA_CARRY=1
# Docker's hot healthcheck loop is fast/short; the cold loop is long
# because a bind-mounted first boot recompiles `mix phx.server` (2-3 min).
HOT_HEALTHCHECK_RETRIES="${HOT_HEALTHCHECK_RETRIES:-30}"
HOT_HEALTHCHECK_SLEEP="${HOT_HEALTHCHECK_SLEEP:-1}"
COLD_HEALTHCHECK_RETRIES="${COLD_HEALTHCHECK_RETRIES:-120}"
COLD_HEALTHCHECK_SLEEP="${COLD_HEALTHCHECK_SLEEP:-2}"

# ---- substrate hooks ------------------------------------------------

substrate_pull() {
	# Pull first so the preflight diffs against what we're ABOUT to deploy.
	# Both endpoints are RESOLVED shas so NEW_SHA can be written to the
	# completed-deploy marker (parity with jail + linux).
	PREV_SHA="$(git rev-parse HEAD)"
	echo "Pulling latest main..."
	git pull --ff-only
	NEW_SHA="$(git rev-parse HEAD)"
}

# Marker hooks — the operator runs this script directly with git + fs
# access to REPO_ROOT (cwd is REPO_ROOT), so plain git/cat, not a run_as
# delegate like the jail/linux substrates.
substrate_read_marker() {
	cat runtime/last-deployed-sha 2>/dev/null || true
}

substrate_write_marker() {
	# mkdir -p: the marker owns its dir. A git checkout already has runtime/
	# (tracked .gitkeep + the DB), but don't ASSUME a checkout — a
	# checkout-less install (release image / curl|bash on a fresh host)
	# reuses this same write.
	mkdir -p runtime
	printf '%s\n' "$NEW_SHA" > runtime/last-deployed-sha
}

substrate_commit_exists() {
	# Boolean predicate evaluated inside the lib's `base=$(...)` — suppress
	# stdout too, for parity with the jail/linux hooks (git cat-file -e is
	# silent, but keep the discipline identical across substrates).
	git cat-file -e "$1^{commit}" >/dev/null 2>&1
}

substrate_changed_files() {
	git diff --name-only "$1..$2"
}

substrate_preflight() {
	# Delegate the entire classification to Grappa.Deploy.Preflight via a
	# oneshot mix run. Prints "→ <kind>: <files>" per cold class (or "→ no
	# unsafe markers → HOT"), halts 0 (HOT) / 3 (COLD); anything else is
	# NOT a verdict (1=mix crash, 2=usage) and the lib aborts on it.
	docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps \
		-e MIX_ENV=dev grappa \
		mix run --no-start -e "Grappa.Deploy.Preflight.cli([\"$1\", \"$2\", \"docker\"])"
}

substrate_build() {
	# Hot path needs no build — the pulled commit is already in the
	# bind-mounted source tree (compose.yaml mounts ./:/app). Cold path
	# rebuilds the toolchain image.
	[ "$MODE" = cold ] || return 0

	if [ ! -f .env ]; then
		die "no .env file. Copy .env.example and fill in SECRET_KEY_BASE + SECRET_SIGNING_SALT + GRAPPA_ENCRYPTION_KEY."
	fi

	MIX_ENV=${MIX_ENV:-prod}
	export MIX_ENV

	echo "Building grappa image..."
	docker compose "${COMPOSE_ARGS[@]}" --profile prod build grappa
}

substrate_reload() {
	# Hot-deploy: POST /admin/reload triggers Phoenix.CodeReloader.reload/1
	# which walks :code.modified_modules/0 and purges + reloads modified
	# beams in place. Sessions (Session.Server, IRC.Client) keep state.
	echo "Reloading modules in live BEAM..." >&2
	in_container curl -fsS -X POST http://localhost:4000/admin/reload
}

substrate_cic() {
	# Refresh cicchetto SPA dist into ./runtime/cicchetto-dist. Host
	# bind-mount (not a named volume) so the container UID can write into a
	# dir that already exists with the right ownership.
	#
	# #1020 — the build lands in a staging sibling and is RENAMED into the
	# served dir on success: vite empties its outDir first, and the BEAM
	# serves runtime/cicchetto-dist per request, so building in place served
	# an empty SPA for the whole build (and forever, if the build failed).
	local cic_served="runtime/cicchetto-dist"
	local cic_build_out
	cic_build_out="$(cic_dist_docker_stage "$cic_served")"
	# #538 — derive the single-source version for the cic build. The
	# cicchetto-build container mounts only ./cicchetto, so it can't read the
	# repo root; pass GRAPPA_VERSION (from the VERSION file, #652) through the env.
	GRAPPA_VERSION="$("$REPO_ROOT/infra/packaging/version.sh")"
	export GRAPPA_VERSION
	echo "Building cicchetto dist..."
	CIC_BUILD_OUT="$cic_build_out" docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm cicchetto-build
	# The promote plants the tracked .gitkeep in the tree that lands, so the
	# post-build `touch` that used to undo vite's wipe is gone.
	cic_dist_promote "$cic_served" "$cic_build_out"
}

substrate_migrate() {
	# Sync host deps/ to mix.lock. The image is toolchain-only (no baked
	# hex/deps) and the bind-mount means deps/ + HEX_HOME live on the host;
	# a fresh checkout has neither. Idempotent + cheap when already in sync.
	echo "Syncing hex + deps to mix.lock..."
	# shellcheck disable=SC1010  # `mix do` is a mix subcommand, not shell `do`
	docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm --no-deps grappa \
		mix do local.hex --force, local.rebar --force, deps.get

	# Apply pending migrations BEFORE bringing the long-running container
	# up — a one-shot `run` against the same image + bind-mounted prod DB
	# runs to completion + exits before Bootstrap's first DB hit could race
	# an unapplied migration (S3 crash-loop fix).
	echo "Running migrations..."
	docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm --no-deps grappa mix ecto.migrate
}

substrate_restart() {
	# --no-deps avoids re-running cicchetto-build; --remove-orphans sweeps
	# a stale grappa-nginx left by a pre-#485 (two-container) stack.
	docker compose "${COMPOSE_ARGS[@]}" --profile prod up -d --force-recreate --no-deps --remove-orphans grappa
}

substrate_healthcheck() {
	# Probe /healthz from INSIDE the container so the check is independent
	# of host port binding (#485 dropped the nginx container).
	in_container curl -fsS -o /dev/null http://localhost:4000/healthz
}

substrate_done_banner() {
	# Docker success wording (no [deploy] prefix — matches the original +
	# deploy_reload_verify_test.bats). $1 = retries taken (unused here).
	if [ "$MODE" = hot ]; then
		echo "✓ hot-deploy complete (sessions preserved, container ID unchanged)"
	else
		echo "✓ cold-deploy complete (sessions reset, new container)"
	fi
}

# ---- run ------------------------------------------------------------
# shellcheck source=infra/lib/deploy_common.sh
. "$REPO_ROOT/infra/lib/deploy_common.sh"

deploy_main "$@"
