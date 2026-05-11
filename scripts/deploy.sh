#!/usr/bin/env bash
# Build the grappa image + cicchetto SPA, then (re)start the prod stack.
#
# Refuses to run on a non-main branch. CP23 cluster `cluster/code-reload`
# collapsed dev+prod compose into one file with profiles — this script
# now drives `--profile prod` (adds nginx + cicchetto-build oneshot).
#
# This is the COLD-deploy path — it recreates the grappa container,
# killing live IRC sessions. The future hot-deploy path
# (`scripts/hot-deploy.sh`, B6) git-pulls + reload-POSTs the running
# container without restart. Use deploy.sh for mix.lock / supervision-
# tree / struct-shape changes that aren't safe to live-reload.
#
# Usage:
#   scripts/deploy.sh
#   MIX_ENV=prod scripts/deploy.sh        # default; explicit form

MIX_ENV=${MIX_ENV:-prod}
export MIX_ENV
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ] && [ "${ALLOW_DEPLOY_FROM_BRANCH:-}" != "1" ]; then
    die "deploy.sh refuses to run on branch '$branch'. Set ALLOW_DEPLOY_FROM_BRANCH=1 to override."
fi

if [ ! -f .env ]; then
    die "no .env file. Copy .env.example and fill in SECRET_KEY_BASE + SECRET_SIGNING_SALT + GRAPPA_ENCRYPTION_KEY."
fi

# 1. Build grappa image (single-stage; no separate dev/prod tag now).
docker compose "${COMPOSE_ARGS[@]}" --profile prod build grappa

# 2. Refresh cicchetto SPA dist into ./runtime/cicchetto-dist.
#    Always run on every deploy — bun install cache + Vite incremental
#    build keep this fast (~few seconds after the first cold run).
#    Host bind-mount instead of a named volume so the container (UID
#    1000) can write into a directory that already exists with the
#    right ownership; a fresh named volume is root:root and fails
#    Vite's prepare-out-dir step. mkdir -p inherits the operator's UID
#    — on the canonical deployment that's UID 1000 = vjt = container
#    user.
mkdir -p runtime/cicchetto-dist
echo "Building cicchetto dist..."
docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm cicchetto-build

# 3. Apply pending migrations BEFORE bringing the long-running container up.
#    Pre-S3 the order was reversed (up -d first, then exec migrate in a
#    retry loop). That worked as long as Bootstrap's queries only touched
#    columns the running schema already had — but the moment a deploy
#    introduces a new column Bootstrap reads (S1's `connection_state`,
#    landed 2026-05-04), Bootstrap's first DB hit races the migration
#    eval and crash-loops the supervision tree before the eval lands.
#    Fix: one-shot `docker compose run` against the same image, same
#    bind-mounted prod DB, runs to completion + exits BEFORE step 4's
#    `up -d` starts Bootstrap.
#
#    Post-CP23: `mix ecto.migrate` replaces `bin/grappa eval` (no
#    release binary). The image always has `mix`.
echo "Running migrations..."
docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm --no-deps grappa mix ecto.migrate

# 4. Bring up grappa + nginx. --no-deps avoids re-running cicchetto-build
#    (we just ran it above; compose's depends_on graph would otherwise try
#    again because `run --rm` removes the container).
docker compose "${COMPOSE_ARGS[@]}" --profile prod up -d --force-recreate --no-deps grappa nginx

# 5. Wait for /healthz via nginx, probed from INSIDE the nginx container
#    so the check is independent of host port binding.
echo "Waiting for /healthz via nginx..."
for i in $(seq 1 30); do
    if docker compose "${COMPOSE_ARGS[@]}" exec -T nginx wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1; then
        echo "✓ grappa is up (nginx → grappa:4000 healthy)"
        exit 0
    fi
    sleep 2
done

die "grappa did not become healthy within 60s. Check: scripts/monitor.sh"
