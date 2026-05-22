#!/usr/bin/env bash
# Unified deploy entry point — auto-detects hot-vs-cold via git-diff
# preflight, then dispatches.
#
# CP23 cluster `cluster/code-reload` shipped Phoenix.CodeReloader for
# the running grappa container, so most deploys are now hot: `git pull
# --ff-only` + `POST /admin/reload` swaps modules in the live BEAM
# without restart, sessions preserved.
#
# Some module-shape changes can't be hot-swapped — `Phoenix.CodeReloader`
# accepts the reload but the new code crashes (or silently no-ops)
# at the first message that exposes the shape change. Concrete
# examples:
#   - mix.lock changed → new dep version never loaded; first call to
#     the new API crashes runtime.
#   - mix.exs changed → :application callback or :version stale.
#   - lib/grappa/application.ex changed → supervision tree re-read
#     only at boot; new children never started, old strategy
#     unchanged.
#   - state-shape change in a long-lived GenServer (defstruct,
#     `@type t :: %{...}`, or `init/1` map literal) → next callback
#     pattern-matches new shape against OLD state in the running
#     process; crash deferred to that moment (could be hours later).
#     Authoritative module list lives in
#     `lib/grappa/hot_reload/long_lived_modules.ex` — that file IS
#     the SoT for both this script and CLAUDE.md "Hot vs cold deploy".
#
# Phoenix.CodeReloader cannot detect any of these — only compile
# errors. So the preflight has to be in this script: diff
# `HEAD@{1}..HEAD` for the unsafe markers and refuse hot-deploy if
# any matches. Conservative bias: in doubt, COLD.
#
# Override flags:
#   --force-hot   bypass preflight, hot-deploy regardless (use when
#                 you know better than the heuristic)
#   --force-cold  skip preflight, cold-deploy unconditionally
#
# Cic deploys are orthogonal — `scripts/deploy-cic.sh` (B8) handles
# the Vite bundle + cic-bundle-changed broadcast independently.
#
# Usage:
#   scripts/deploy.sh                # auto-detect
#   scripts/deploy.sh --force-hot
#   scripts/deploy.sh --force-cold

set -euo pipefail

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

mode="${1:-auto}"
case "$mode" in
    --force-hot)   mode=hot ;;
    --force-cold)  mode=cold ;;
    auto|"")       mode=auto ;;
    *) die "usage: scripts/deploy.sh [--force-hot|--force-cold]" ;;
esac

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ] && [ "${ALLOW_DEPLOY_FROM_BRANCH:-}" != "1" ]; then
    die "deploy.sh refuses to run on branch '$branch'. Set ALLOW_DEPLOY_FROM_BRANCH=1 to override."
fi

# Pull first so the preflight diffs against what we're ABOUT to deploy,
# not against the previous HEAD. `--ff-only` keeps us out of the merge
# resolution business — if main diverged, fail loud.
prev_sha="$(git rev-parse HEAD)"
echo "Pulling latest main..."
git pull --ff-only

# ---- Preflight: classify diff as hot-safe or cold-required ----
#
# Source of truth: `lib/grappa/deploy/preflight.ex`. The Elixir module
# owns ALL path classification rules + long-lived-module state-shape
# diffing. This shell function is a thin invoker — every rule lives
# in Elixir so the script + docs + Dialyzer cannot drift (CLAUDE.md
# "Implement once, reuse everywhere").
#
# Pre-REV-C this script carried duplicate bash regex rules + a brittle
# `grep -E '^\s+Grappa\.X' …` parse of the LongLivedModules SoT (CP28
# regression class, review C4) + an awk helper for state-block
# extraction. All three deleted; the SoT is consulted directly via
# `Grappa.HotReload.LongLivedModules.all/0`.
preflight() {
    local from="$1" to="$2"

    # Same SHA = nothing to deploy. Treat as hot-safe (the reload is
    # idempotent — `:code.modified_modules/0` returns []).
    if [ "$from" = "$to" ]; then
        echo "  no commits since last HEAD ($from)"
        return 0
    fi

    local changed
    changed="$(git diff --name-only "$from..$to")"

    if [ -z "$changed" ]; then
        return 0
    fi

    echo "Changed files since $from:"
    echo "$changed" | sed 's/^/  /'

    # Delegate the entire classification to Grappa.Deploy.Preflight via
    # a oneshot mix run. The module's `cli/1` prints "→ <kind>: <files>"
    # lines for each cold class triggered (or "→ no unsafe markers →
    # HOT" if all green), then halts with exit 0 (HOT) or 1 (COLD).
    #
    # ~2-3s mix-boot cost is invisible — the cold path already does a
    # multi-minute container-rebuild + cicchetto-build oneshot.
    if docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps \
        -e MIX_ENV=dev grappa \
        mix run --no-start -e "Grappa.Deploy.Preflight.cli([\"$from\", \"$to\"])"; then
        return 0
    else
        return 1
    fi
}

if [ "$mode" = "auto" ]; then
    if preflight "$prev_sha" "HEAD"; then
        mode=hot
    else
        mode=cold
    fi
elif [ "$mode" = "hot" ]; then
    echo "--force-hot: skipping preflight"
elif [ "$mode" = "cold" ]; then
    echo "--force-cold: skipping preflight"
fi

echo
echo "==> deploy mode: $mode"
echo

if [ "$mode" = "hot" ]; then
    # Hot-deploy: pulled commit is already in the bind-mounted source
    # tree (compose.yaml mounts ./:/app). POST /admin/reload triggers
    # Phoenix.CodeReloader.reload/1 which walks
    # `:code.modified_modules/0` and purges + reloads modified beams in
    # place. Sessions (Session.Server, IRC.Client, etc.) keep state.
    echo "Reloading modules in live BEAM..."
    docker exec grappa curl -fsS -X POST http://localhost:4000/admin/reload
    echo
    echo "✓ hot-deploy complete (sessions preserved, container ID unchanged)"
    exit 0
fi

# ---- Cold deploy ----

if [ ! -f .env ]; then
    die "no .env file. Copy .env.example and fill in SECRET_KEY_BASE + SECRET_SIGNING_SALT + GRAPPA_ENCRYPTION_KEY."
fi

MIX_ENV=${MIX_ENV:-prod}
export MIX_ENV

echo "Building grappa image..."
docker compose "${COMPOSE_ARGS[@]}" --profile prod build grappa

# Refresh cicchetto SPA dist into ./runtime/cicchetto-dist. Always run
# on every cold deploy — bun install cache + Vite incremental build
# keep this fast (~few seconds after the first cold run). Host
# bind-mount instead of a named volume so the container (UID 1000) can
# write into a directory that already exists with the right ownership;
# a fresh named volume is root:root and fails Vite's prepare-out-dir
# step. mkdir -p inherits the operator's UID — on the canonical
# deployment that's UID 1000 = vjt = container user.
mkdir -p runtime/cicchetto-dist
echo "Building cicchetto dist..."
docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm cicchetto-build
# Vite's `emptyOutDir` wipes .gitkeep on every build (the tracked
# placeholder is bait for fresh-clone Docker auto-mkdir-as-root —
# see .gitignore L44-46). Restore it so `git status` stays clean.
touch runtime/cicchetto-dist/.gitkeep

# Sync host deps/ to mix.lock. The bind-mount `./:/app` shadows the
# image-baked deps with whatever's on the host; previous deploys
# against a different mix.lock leave host deps/ out of sync.
# `mix deps.get` is idempotent + cheap when already in sync.
echo "Syncing deps to mix.lock..."
docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm --no-deps grappa mix deps.get

# Apply pending migrations BEFORE bringing the long-running container
# up. Pre-S3 the order was reversed (up -d first, then exec migrate in
# a retry loop). That worked as long as Bootstrap's queries only
# touched columns the running schema already had — but the moment a
# deploy introduces a new column Bootstrap reads (S1's
# `connection_state`, landed 2026-05-04), Bootstrap's first DB hit
# races the migration eval and crash-loops the supervision tree before
# the eval lands. Fix: one-shot `docker compose run` against the same
# image, same bind-mounted prod DB, runs to completion + exits BEFORE
# the up -d starts Bootstrap.
echo "Running migrations..."
docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm --no-deps grappa mix ecto.migrate

# Bring up grappa + nginx. --no-deps avoids re-running cicchetto-build
# (we just ran it above; compose's depends_on graph would otherwise try
# again because `run --rm` removes the container).
docker compose "${COMPOSE_ARGS[@]}" --profile prod up -d --force-recreate --no-deps grappa nginx

# Wait for /healthz via nginx, probed from INSIDE the nginx container
# so the check is independent of host port binding. Cold-boot loop is
# long because `mix phx.server` recompiles when bind-mounted source
# has no `_build/${MIX_ENV}/` cached on host disk yet — first deploy
# can take 2-3 minutes, subsequent deploys finish in 10-15s.
echo "Waiting for /healthz via nginx..."
for i in $(seq 1 120); do
    if docker compose "${COMPOSE_ARGS[@]}" exec -T nginx wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1; then
        echo "✓ cold-deploy complete (sessions reset, new container)"
        exit 0
    fi
    sleep 2
done

die "grappa did not become healthy within 240s. Check: scripts/monitor.sh"
