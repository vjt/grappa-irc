#!/usr/bin/env bash
# Operator Docker deploy — auto-detects hot-vs-cold via the shared
# Grappa.Deploy.Preflight classifier, then dispatches.
#
# Thin consumer of the shared deploy algorithm in
# infra/lib/deploy_common.sh — the same lib that drives
# infra/freebsd/deploy.sh (jail) and infra/linux/deploy.sh (systemd). This
# script sets config, flips this substrate's feature toggles, and defines
# the Docker-specific hooks.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#503).
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

# Assert main-checkout + main-branch BEFORE any side effect — the git pull
# below mutates REPO_ROOT (#364).
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
DEPLOY_SEED_RETRY_HINT="scripts/mix.sh grappa.seed_themes"
# Docker's hot healthcheck loop is fast/short; the cold loop is long
# because a bind-mounted first boot recompiles `mix phx.server` (2-3 min).
HOT_HEALTHCHECK_RETRIES="${HOT_HEALTHCHECK_RETRIES:-30}"
HOT_HEALTHCHECK_SLEEP="${HOT_HEALTHCHECK_SLEEP:-1}"
COLD_HEALTHCHECK_RETRIES="${COLD_HEALTHCHECK_RETRIES:-120}"
COLD_HEALTHCHECK_SLEEP="${COLD_HEALTHCHECK_SLEEP:-2}"

# ---- substrate hooks ------------------------------------------------

# Preconditions for EVERY compose invocation this script makes, on BOTH
# paths. They used to live inside substrate_build, behind its
# `[ "$MODE" = cold ] || return 0`: a HOT deploy therefore reached
# substrate_seed with no `.env` check and no MIX_ENV in the shell, compose
# fell back to `.env` for the interpolation, and `.env.example` ships
# `MIX_ENV=dev` — so compose.yaml resolved DATABASE_PATH to
# `grappa_dev.db`. COLD seeded prod, HOT seeded the DEV database on the
# same box, silently, and hot is the documented normal case (#1377 D-S3).
#
# `.env` carries the prod secrets runtime.exs refuses to boot without, and
# MIX_ENV picks the database every oneshot opens — neither is a property of
# the image build.
establish_deploy_env() {
	if [ ! -f .env ]; then
		die "no .env file. Copy .env.example and fill in SECRET_KEY_BASE + SECRET_SIGNING_SALT + GRAPPA_ENCRYPTION_KEY."
	fi

	MIX_ENV=${MIX_ENV:-prod}
	export MIX_ENV
}

substrate_pull() {
	# The earliest hook the lib calls, so the preconditions land here: AFTER
	# the flag parse inside deploy_main (an unknown flag must still read as a
	# usage error, not as a missing .env) and BEFORE the first side effect.
	establish_deploy_env

	# Pull first so the preflight diffs against what we are ABOUT to deploy.
	# Both endpoints are RESOLVED shas — NEW_SHA goes into the marker.
	PREV_SHA="$(git rev-parse HEAD)"
	echo "Pulling latest main..."
	git pull --ff-only
	NEW_SHA="$(git rev-parse HEAD)"
}

# Marker hooks — cwd is REPO_ROOT and the operator has git + fs access
# here, so plain git/cat rather than the jail/linux run_as delegate.
substrate_read_marker() {
	cat runtime/last-deployed-sha 2>/dev/null || true
}

substrate_write_marker() {
	# mkdir -p: the marker owns its dir. Do NOT assume a git checkout — a
	# checkout-less install reuses this same write.
	mkdir -p runtime
	printf '%s\n' "$NEW_SHA" > runtime/last-deployed-sha
}

substrate_commit_exists() {
	# Boolean predicate evaluated inside the lib's `base=$(...)` — suppress
	# stdout too, for parity with the jail/linux hooks.
	git cat-file -e "$1^{commit}" >/dev/null 2>&1
}

substrate_changed_files() {
	git diff --name-only "$1..$2"
}

substrate_preflight() {
	# Delegate the whole classification to Grappa.Deploy.Preflight via a
	# oneshot mix run: halts 0 (HOT) / 3 (COLD); anything else is NOT a
	# verdict (1=mix crash, 2=usage) and the lib aborts on it.
	docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps \
		-e MIX_ENV=dev grappa \
		mix run --no-start -e "Grappa.Deploy.Preflight.cli([\"$1\", \"$2\", \"docker\"])"
}

substrate_build() {
	# Hot path needs no build — the pulled commit is already in the
	# bind-mounted source tree (compose.yaml mounts ./:/app). Cold path
	# rebuilds the toolchain image.
	[ "$MODE" = cold ] || return 0

	echo "Building grappa image..."
	docker compose "${COMPOSE_ARGS[@]}" --profile prod build grappa
}

substrate_reload() {
	# Hot-deploy: POST /admin/reload purges + reloads modified beams in the
	# live BEAM. Sessions (Session.Server, IRC.Client) keep their state.
	echo "Reloading modules in live BEAM..." >&2
	in_container curl -fsS -X POST http://localhost:4000/admin/reload
}

substrate_cic() {
	# Refresh cicchetto SPA dist into ./runtime/cicchetto-dist. Host
	# bind-mount (not a named volume) so the container UID can write into a
	# dir that already exists with the right ownership.
	#
	# The build lands in a STAGING sibling and is renamed into the served dir
	# only on success — never build in place.
	# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#1020).
	local cic_served="runtime/cicchetto-dist"
	local cic_build_out
	cic_build_out="$(cic_dist_docker_stage "$cic_served")"
	# The cicchetto-build container mounts only ./cicchetto and cannot read
	# the repo root, so pass the version through the env (#538).
	GRAPPA_VERSION="$("$REPO_ROOT/infra/packaging/version.sh")"
	export GRAPPA_VERSION
	echo "Building cicchetto dist..."
	CIC_BUILD_OUT="$cic_build_out" docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm cicchetto-build
	# The promote plants the tracked .gitkeep into the tree that lands.
	cic_dist_promote "$cic_served" "$cic_build_out"
}

substrate_migrate() {
	# Sync host deps/ to mix.lock. The image is toolchain-only and the
	# bind-mount puts deps/ + HEX_HOME on the host; a fresh checkout has
	# neither. Idempotent + cheap when already in sync.
	echo "Syncing hex + deps to mix.lock..."
	# shellcheck disable=SC1010  # `mix do` is a mix subcommand, not shell `do`
	docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm --no-deps grappa \
		mix do local.hex --force, local.rebar --force, deps.get

	# Apply pending migrations BEFORE bringing the long-running container up:
	# a one-shot `run` exits before Bootstrap's first DB hit can race an
	# unapplied migration.
	# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
	# `grappa.migrate`, not `ecto.migrate`: same migrator, same footprint
	# (the task starts the Repo and nothing else), preceded by the #1348
	# duplicate-version audit. `ecto.migrate` cannot carry that audit —
	# a version claimed by two files and already applied leaves the
	# pending set empty, so the migrator reports success having run
	# neither file, forever.
	echo "Running migrations..."
	docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm --no-deps grappa mix grappa.migrate
}

substrate_seed() {
	# Mirrors substrate_migrate's door. The task suppresses Bootstrap and the
	# Endpoint, so it neither dials upstream IRC nor fights the running
	# container for port 4000.
	echo "Seeding the built-in theme gallery..."
	docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm --no-deps grappa mix grappa.seed_themes
}

substrate_restart() {
	# --no-deps avoids re-running cicchetto-build; --remove-orphans sweeps a
	# stale grappa-nginx left by a pre-#485 two-container stack.
	docker compose "${COMPOSE_ARGS[@]}" --profile prod up -d --force-recreate --no-deps --remove-orphans grappa
}

substrate_healthcheck() {
	# Probe /healthz from INSIDE the container so the check is independent
	# of host port binding.
	in_container curl -fsS -o /dev/null http://localhost:4000/healthz
}

substrate_done_banner() {
	# Docker success wording, no [deploy] prefix — PINNED by
	# deploy_reload_verify_test.bats. $1 = retries taken (unused here).
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
