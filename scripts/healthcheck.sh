#!/usr/bin/env bash
# Curl the grappa /healthz endpoint.
#
# Usage:
#   scripts/healthcheck.sh
#
# When nginx is running (`--profile prod` brought it up) probes via
# nginx → grappa, otherwise probes grappa directly. Either way the
# probe runs from INSIDE the container, so it's independent of host
# port binding.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

nginx_cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -q nginx 2>/dev/null || true)"
if [ -n "$nginx_cid" ]; then
    docker compose "${COMPOSE_ARGS[@]}" exec -T nginx wget -qO- http://127.0.0.1/healthz
    echo
else
    in_container curl -fsS http://localhost:4000/healthz
    echo
fi
