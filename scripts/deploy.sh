#!/bin/bash
# Build the prod release + cicchetto SPA, then (re)start the prod stack.
#
# Refuses to run on a non-main branch. Builds compose.prod.yaml's grappa
# image, runs the cicchetto-build oneshot to refresh the SPA dist into
# the cicchetto_dist named volume, then brings up grappa + nginx.
# Verifies /healthz via nginx.
#
# Usage:
#   scripts/deploy.sh

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ] && [ "${ALLOW_DEPLOY_FROM_BRANCH:-}" != "1" ]; then
    die "deploy.sh refuses to run on branch '$branch'. Set ALLOW_DEPLOY_FROM_BRANCH=1 to override."
fi

if [ ! -f .env ]; then
    die "no .env file. Copy .env.example and fill in SECRET_KEY_BASE + RELEASE_COOKIE + GRAPPA_ENCRYPTION_KEY."
fi

# 1. Build grappa prod image
docker compose -f compose.prod.yaml build grappa

# 2. Refresh cicchetto SPA dist into the cicchetto_dist named volume.
#    Always run on every deploy — bun install cache + Vite incremental
#    build keep this fast (~few seconds after the first cold run).
echo "Building cicchetto dist..."
docker compose -f compose.prod.yaml run --rm cicchetto-build

# 3. Bring up grappa + nginx. --no-deps avoids re-running cicchetto-build
#    (we just ran it above; compose's depends_on graph would otherwise try
#    again because `run --rm` removes the container).
docker compose -f compose.prod.yaml up -d --force-recreate --no-deps grappa nginx

# 4. Run pending migrations against the prod Repo. Must happen AFTER the
# container is up (the release binary needs its slim runtime present)
# but BEFORE Bootstrap-spawned sessions try to insert scrollback rows.
# Bootstrap fires asynchronously from supervision tree start, so we race
# the first PRIVMSG insert vs. this command — a tight loop with retry
# handles the case where the release boot is still completing.
echo "Running migrations..."
for i in $(seq 1 15); do
    if docker compose -f compose.prod.yaml exec -T grappa bin/grappa eval 'Grappa.Release.migrate()' >/dev/null 2>&1; then
        echo "✓ migrations applied"
        break
    fi
    sleep 2
    if [ "$i" = "15" ]; then
        die "migrations did not apply within 30s. Check: scripts/monitor.sh"
    fi
done

# 5. Wait for /healthz via nginx (grappa is no longer on vlan53 — only
#    reachable through the reverse proxy at 192.168.53.11:80).
echo "Waiting for /healthz via nginx..."
for i in $(seq 1 30); do
    if curl -fsS --max-time 2 http://192.168.53.11/healthz >/dev/null 2>&1; then
        echo "✓ grappa is up at http://192.168.53.11 (via nginx → grappa:4000)"
        exit 0
    fi
    sleep 2
done

die "grappa did not become healthy within 60s. Check: scripts/monitor.sh"
