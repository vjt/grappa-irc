# shellcheck shell=bash
# infra/lib/deploy_docker.sh — the Docker substrate's hook set, once (#1384).
#
# `infra/lib/deploy_common.sh` is the substrate-INDEPENDENT deploy algorithm:
# pull, classify, build, then hot-reload or recreate. Each substrate supplies
# the `substrate_*` hooks it calls. The jail and the systemd host have one
# hook set each; the Docker source substrate had TWO, one per entry point —
# `scripts/deploy.sh` (operator, on a checkout, with the host's personal
# compose override and the worktree/branch guard) and `infra/docker/deploy.sh
# update` (standalone box: secrets, install/stop verbs, ownership guard).
#
# Two hook sets for one substrate means the operator's outcome depends on
# which door they walked through, and a fix applied to one silently leaves
# the other wrong. #1377 is the worked example rather than the hypothesis: it
# established the environment floor on both PATHS of the operator door and
# structurally could not reach the twin, which to this day would seed a
# hand-installed box's DEV database on every update.
#
# So the ENTRY POINTS stay two — they serve different audiences and guard
# different things — and the hooks become one. What is genuinely per-consumer
# stays per-consumer: `substrate_done_banner` (different wording for
# different operators, one of them pinned by bats) and
# `DEPLOY_SEED_RETRY_HINT` (the retry command must name the door the operator
# actually invoked).
#
# NOT a consumer: the release-image mode further down `infra/docker/deploy.sh`.
# It declares a third `substrate_*` set, of which nine members are `{ :; }` —
# no pull, no build, no reload, no cic bundle, because a checkout-less host
# running a published image has no source to do any of it with. That is a
# DIFFERENT substrate wearing the same interface, and folding it in here
# would be one data model with a type flag rather than shared behaviour.
#
# ## Contract — set these BEFORE sourcing
#
#   DOCKER_COMPOSE   array: the full compose invocation, e.g.
#                    `(docker compose -f compose.yaml)` or, for a consumer
#                    that honours the host's personal override,
#                    `(docker compose "${COMPOSE_ARGS[@]}")`.
#   REPO_ROOT        absolute path to the checkout (used to source cic_dist).
#   NO_PULL          optional, 0/1 — 1 deploys the working tree as-is.
#   die              a function that prints to stderr and exits non-zero.
#
# Sourcing has no side effect: the preconditions run from `substrate_pull`,
# for the reason given there. Source it before `deploy_common.sh`.

: "${NO_PULL:=0}"

# The healthcheck loops. Docker's hot loop is fast/short; the cold loop is
# long because a bind-mounted first boot recompiles `mix phx.server` (2-3
# min). Shared, so two doors onto one substrate cannot wait for it with
# different patience.
HOT_HEALTHCHECK_RETRIES="${HOT_HEALTHCHECK_RETRIES:-30}"
HOT_HEALTHCHECK_SLEEP="${HOT_HEALTHCHECK_SLEEP:-1}"
COLD_HEALTHCHECK_RETRIES="${COLD_HEALTHCHECK_RETRIES:-120}"
COLD_HEALTHCHECK_SLEEP="${COLD_HEALTHCHECK_SLEEP:-2}"

# The build-beside-then-swap helpers substrate_cic uses (#1020).
# shellcheck source=infra/lib/cic_dist.sh
. "$REPO_ROOT/infra/lib/cic_dist.sh"

# ---- preconditions ---------------------------------------------------
# Verbatim from #1377, which established them for the operator door: they
# apply to EVERY compose invocation on BOTH paths.
#
# `.env` carries the prod secrets runtime.exs refuses to boot without, and
# MIX_ENV picks the database every oneshot opens — compose.yaml derives both
# `MIX_ENV: ${MIX_ENV:-dev}` and `DATABASE_PATH:
# /app/runtime/grappa_${MIX_ENV:-dev}.db` from it. Neither is a property of
# the image build, which is where the pair used to live, behind a
# `[ "$MODE" = cold ] || return 0` that kept them off the hot path entirely.
#
# The twin reached the same precondition by a different mechanism —
# `set_env MIX_ENV prod` writes it into `.env` at install time — so a box
# installed that way was covered and a hand-installed one was not. One
# mechanism now, for both doors.
establish_deploy_env() {
	# GRAPPA_CACHE_ID (#1263) is honourable by `compose run` and by nothing
	# else: `run` is the only compose verb that takes `-v`, and `up` — which
	# is how the long-running container is created — takes none. Threading
	# the per-id binds through this substrate's oneshots would therefore
	# migrate the database inside `.caches/<id>` and then boot the box from
	# the shared `_build`/`deps`, which is not isolation but a deploy split
	# across two caches with nothing in the output to say so. Refuse instead:
	# an operator who set the variable asked for isolation, and silently
	# giving them half of it is the failure mode, not the fix.
	#
	# First in the function, ahead of the .env check: this one is about the
	# operator's environment being incompatible with the substrate at all,
	# and it holds whether or not the box is installed. Still inside the
	# hook (not at source time), for the reason the file header gives — the
	# flag parse must run first, so `--bogus` stays a usage error.
	if [ -n "${GRAPPA_CACHE_ID:-}" ]; then
		die "GRAPPA_CACHE_ID is set ('$GRAPPA_CACHE_ID') and the Docker deploy substrate cannot honour it: only 'compose run' accepts -v, so the oneshots would use the per-id caches while 'compose up' boots the container from the shared ones. Unset GRAPPA_CACHE_ID to deploy."
	fi

	if [ ! -f .env ]; then
		die "no .env file. Copy .env.example and fill in SECRET_KEY_BASE + SECRET_SIGNING_SALT + GRAPPA_ENCRYPTION_KEY."
	fi

	MIX_ENV=${MIX_ENV:-prod}
	export MIX_ENV
}

# ---- substrate hooks -------------------------------------------------

substrate_pull() {
	# The earliest hook the lib calls, so the preconditions land here: AFTER
	# the flag parse inside deploy_main (an unknown flag must still read as a
	# usage error, not as a missing .env) and BEFORE the first side effect.
	establish_deploy_env

	# Pull first so the preflight diffs against what we are ABOUT to deploy.
	# Both endpoints are RESOLVED shas — NEW_SHA goes into the marker.
	PREV_SHA="$(git rev-parse HEAD)"
	if [ "$NO_PULL" = 1 ]; then
		NEW_SHA="$PREV_SHA"
		return 0
	fi
	local branch
	branch="$(git rev-parse --abbrev-ref HEAD)"
	echo "Pulling ${branch} (fast-forward only)"
	# A bare `git pull --ff-only` failure under `set -e` aborts with no
	# explanation, and a diverged branch is not something an operator can
	# read out of an exit code.
	git pull --ff-only || die "pull is not a fast-forward — the branch diverged. Resolve it by hand."
	NEW_SHA="$(git rev-parse HEAD)"
}

# Marker hooks — cwd is the checkout and the operator has git + fs access
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
	#
	# `-e MIX_ENV=dev` is explicit and outranks the floor on purpose: the
	# classifier is `mix run --no-start`, it starts no Repo and opens no
	# database, and pinning it to dev lets a box with no prod build still be
	# classified.
	"${DOCKER_COMPOSE[@]}" run --rm --no-deps \
		-e MIX_ENV=dev grappa \
		mix run --no-start -e "Grappa.Deploy.Preflight.cli([\"$1\", \"$2\", \"docker\"])"
}

substrate_build() {
	# BOTH paths must leave fresh .beam in the code path the app boots from
	# — the same requirement infra/freebsd/deploy.sh and
	# infra/linux/deploy.sh state for their releases: the build "writes the
	# fresh .beam into the daemon's code path that the hot reload POST then
	# loads". POST /admin/reload only LOADS: Grappa.HotReload.reload_modified/0
	# md5-walks the app's ebin and compiles nothing.
	#
	# Nothing on THIS substrate's hot path used to write that ebin, so the
	# reload honestly answered `reloaded: []` over the PREVIOUS commit's
	# modules while the banner, the exit code and the completed-deploy marker
	# all reported success, and the box converged one commit late (#1601).
	# "The pulled commit is already in the bind-mounted source tree" — the
	# claim that used to sit here behind a `[ "$MODE" = cold ] || return 0` —
	# is true of the SOURCES and says nothing about the BEAMS.
	if [ "$MODE" = cold ]; then
		# The image is toolchain-only; the beams come from the recreated
		# container's own `mix phx.server` boot compile, which is why the
		# cold healthcheck loop is the patient one.
		echo "Building grappa image..."
		"${DOCKER_COMPOSE[@]}" --profile prod build grappa
		return 0
	fi

	# Hot: a oneshot compiles into the same bind-mounted
	# `_build/$MIX_ENV/lib/grappa/ebin` the live container booted from, which
	# is exactly the ebin the reload then walks. Not a new mechanism — `mix
	# grappa.seed_themes` was already compiling that ebin as a side effect,
	# one step too LATE (deploy_common.sh `_deploy_hot`: reload, THEN seed).
	# Doing it here puts it before `substrate_reload`, which deploy_common.sh
	# guarantees by calling substrate_build ahead of the mode branch.
	#
	# No deps.get beside it: `mix.lock`/`mix.exs` are COLD triggers
	# (Grappa.Deploy.Preflight `mix_deps?/1`), so a hot deploy cannot bring
	# deps the box has not already fetched. --warnings-as-errors matches both
	# release substrates, and under the consumers' `set -euo pipefail` a
	# failed compile aborts BEFORE the reload — which is the point of the
	# step: reloading over a tree that would not compile is the same defect
	# with extra steps.
	echo "Compiling the pulled commit (the reload only LOADS beams)..."
	"${DOCKER_COMPOSE[@]}" --profile prod run --rm --no-deps grappa \
		mix compile --warnings-as-errors
}

substrate_reload() {
	# Hot-deploy: POST /admin/reload purges + reloads modified beams in the
	# live BEAM. Sessions (Session.Server, IRC.Client) keep their state.
	#
	# The lib captures this hook's stdout as the reload response body, so
	# pre-reload chatter MUST go to stderr or it pollutes the JSON the lib
	# inspects.
	# No is-it-running probe here, deliberately. The operator door used to
	# reach this through `_lib.sh`'s `in_container`, which dies with "grappa
	# container is not running"; the standalone door detects a down box in
	# `assert_box_ownership` and FORCES COLD instead — bringing the box up
	# rather than refusing. Unifying on the probe would have encoded the
	# weaker of the two answers into both doors, so the probe goes and a hot
	# deploy against a down box surfaces as compose's own non-zero error.
	echo "Reloading modules in live BEAM..." >&2
	"${DOCKER_COMPOSE[@]}" exec -T grappa curl -fsS -X POST http://localhost:4000/admin/reload
}

substrate_cic() {
	# Refresh the cicchetto SPA dist into ./runtime/cicchetto-dist. Host
	# bind-mount (not a named volume) so the container UID can write into a
	# dir that already exists with the right ownership.
	#
	# The build lands in a STAGING sibling and is renamed into the served dir
	# only on success — never build in place (#1020).
	local cic_served="runtime/cicchetto-dist"
	local cic_build_out
	cic_build_out="$(cic_dist_docker_stage "$cic_served")"
	# The cicchetto-build container mounts only ./cicchetto and cannot read
	# the repo root, so the version goes through the env (#538). Derived
	# HERE, after substrate_pull, so the bundle carries the version the box
	# is moving TO — the pull may have bumped VERSION (#652). vite refuses to
	# build on an empty value, so an unreadable VERSION must not reach it as
	# a silent blank.
	GRAPPA_VERSION="$("$REPO_ROOT/infra/packaging/version.sh")" \
		|| die "could not derive the version from $REPO_ROOT/VERSION — is this a complete checkout?"
	export GRAPPA_VERSION
	echo "Building cicchetto dist..."
	CIC_BUILD_OUT="$cic_build_out" "${DOCKER_COMPOSE[@]}" --profile prod run --rm cicchetto-build
	# The promote plants the tracked .gitkeep into the tree that lands.
	cic_dist_promote "$cic_served" "$cic_build_out"
}

substrate_migrate() {
	# Sync host deps/ to mix.lock. The image is toolchain-only and the
	# bind-mount puts deps/ + HEX_HOME on the host; a fresh checkout has
	# neither. Idempotent + cheap when already in sync.
	echo "Syncing hex + deps to mix.lock..."
	# shellcheck disable=SC1010  # `mix do` is a mix subcommand, not shell `do`
	"${DOCKER_COMPOSE[@]}" --profile prod run --rm --no-deps grappa \
		mix do local.hex --force, local.rebar --force, deps.get

	# Apply pending migrations BEFORE bringing the long-running container up:
	# a one-shot `run` exits before Bootstrap's first DB hit can race an
	# unapplied migration.
	#
	# `grappa.migrate`, not `ecto.migrate`: same migrator, same footprint
	# (the task starts the Repo and nothing else), preceded by the #1348
	# duplicate-version audit. `ecto.migrate` cannot carry that audit — a
	# version claimed by two files and already applied leaves the pending set
	# empty, so the migrator reports success having run neither file, for
	# good.
	echo "Running migrations..."
	"${DOCKER_COMPOSE[@]}" --profile prod run --rm --no-deps grappa mix grappa.migrate
}

substrate_seed() {
	# Mirrors substrate_migrate's door. The task suppresses Bootstrap and the
	# Endpoint, so it neither dials upstream IRC nor fights the running
	# container for port 4000. Runs on BOTH paths — which is why the
	# preconditions must too.
	echo "Seeding the built-in theme gallery..."
	"${DOCKER_COMPOSE[@]}" --profile prod run --rm --no-deps grappa mix grappa.seed_themes
}

substrate_restart() {
	# --no-deps avoids re-running cicchetto-build; --remove-orphans sweeps a
	# stale grappa-nginx left by a pre-#485 two-container stack.
	"${DOCKER_COMPOSE[@]}" --profile prod up -d --force-recreate --no-deps --remove-orphans grappa
}

substrate_healthcheck() {
	# Probe /healthz from INSIDE the container so the check is independent of
	# host port binding.
	"${DOCKER_COMPOSE[@]}" exec -T grappa curl -fsS -o /dev/null http://localhost:4000/healthz
}
