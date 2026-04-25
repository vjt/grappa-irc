#!/bin/bash
# Build the prod release and (re)start the prod container.
#
# Refuses to run on a non-main branch. Builds compose.prod.yaml's image,
# starts/restarts the container with it, then verifies /healthz.
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
    die "no .env file. Copy .env.example and fill in SECRET_KEY_BASE + RELEASE_COOKIE."
fi
if [ ! -f grappa.toml ]; then
    die "no grappa.toml. Copy grappa.toml.example and fill in your IRC networks."
fi

# Build prod image
docker compose -f compose.prod.yaml build

# Restart container with new image
docker compose -f compose.prod.yaml up -d --force-recreate

# Run pending migrations against the prod Repo. Must happen AFTER the
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

# Wait for healthcheck to go green
echo "Waiting for /healthz..."
for i in $(seq 1 30); do
    if curl -fsS --max-time 2 http://192.168.53.11:4000/healthz >/dev/null 2>&1; then
        echo "✓ grappa is up at http://192.168.53.11:4000"
        exit 0
    fi
    sleep 2
done

die "grappa did not become healthy within 60s. Check: scripts/monitor.sh"
