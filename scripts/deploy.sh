#!/usr/bin/env bash
# Build the prod release + cicchetto SPA, then (re)start the prod stack.
#
# Refuses to run on a non-main branch. Builds compose.prod.yaml's grappa
# image, runs the cicchetto-build oneshot to refresh the SPA dist into
# ./runtime/cicchetto-dist, then brings up grappa + nginx. Verifies
# /healthz from inside the nginx container (independent of host port
# binding — works whether nginx is on the wildcard :3000 default or a
# personal-override LAN IP).
#
# Usage:
#   scripts/deploy.sh

GRAPPA_PROD=1 . "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ] && [ "${ALLOW_DEPLOY_FROM_BRANCH:-}" != "1" ]; then
    die "deploy.sh refuses to run on branch '$branch'. Set ALLOW_DEPLOY_FROM_BRANCH=1 to override."
fi

if [ ! -f .env ]; then
    die "no .env file. Copy .env.example and fill in SECRET_KEY_BASE + RELEASE_COOKIE + GRAPPA_ENCRYPTION_KEY."
fi

# 1. Build grappa prod image
docker compose "${COMPOSE_ARGS[@]}" build grappa

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
docker compose "${COMPOSE_ARGS[@]}" run --rm cicchetto-build

# 3. Apply pending migrations BEFORE bringing the long-running container up.
#    Pre-S3 the order was reversed (up -d first, then exec migrate in a
#    retry loop). That worked as long as Bootstrap's queries only touched
#    columns the running schema already had — but the moment a deploy
#    introduces a new column Bootstrap reads (S1's `connection_state`,
#    landed 2026-05-04), Bootstrap's first DB hit races the migration
#    eval and crash-loops the supervision tree before the eval lands.
#    The retry loop didn't help: the container was already restart-cycling
#    by the time `exec` could attach. Fix: one-shot `docker compose run`
#    against the same image, same bind-mounted prod DB, runs to completion
#    + exits BEFORE step 4's `up -d` starts Bootstrap. The long-running
#    container always boots against an up-to-date schema.
echo "Running migrations..."
docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps grappa bin/grappa eval 'Grappa.Release.migrate()'

# 4. Bring up grappa + nginx. --no-deps avoids re-running cicchetto-build
#    (we just ran it above; compose's depends_on graph would otherwise try
#    again because `run --rm` removes the container).
docker compose "${COMPOSE_ARGS[@]}" up -d --force-recreate --no-deps grappa nginx

# 5. Wait for /healthz via nginx, probed from INSIDE the nginx container
#    so the check is independent of host port binding (default wildcard
#    :3000 vs personal-override LAN-IP:80).
echo "Waiting for /healthz via nginx..."
for i in $(seq 1 30); do
    if docker compose "${COMPOSE_ARGS[@]}" exec -T nginx wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1; then
        echo "✓ grappa is up (nginx → grappa:4000 healthy)"
        exit 0
    fi
    sleep 2
done

die "grappa did not become healthy within 60s. Check: scripts/monitor.sh"
