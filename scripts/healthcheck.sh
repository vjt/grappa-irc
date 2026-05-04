#!/usr/bin/env bash
# Curl the grappa /healthz endpoint.
#
# Usage:
#   scripts/healthcheck.sh                     # via container exec (always works)
#   scripts/healthcheck.sh --inside            # alias of the default
#
# Set GRAPPA_PROD=1 to probe the prod stack (nginx → grappa).
#
# Probes from INSIDE the container so the check is independent of host
# port binding. Dev publishes :4000 on the host (default wildcard, or a
# personal-override LAN IP); prod publishes :3000 → :80 on the host.
# Both are exec'd against the in-container loopback.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ "${GRAPPA_PROD:-}" = "1" ]; then
    docker compose "${COMPOSE_ARGS[@]}" exec -T nginx wget -qO- http://127.0.0.1/healthz
    echo
else
    in_container curl -fsS http://localhost:4000/healthz
    echo
fi
