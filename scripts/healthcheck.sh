#!/bin/bash
# Curl the grappa /healthz endpoint.
#
# Usage:
#   scripts/healthcheck.sh                     # via the LAN IP (192.168.53.11)
#   scripts/healthcheck.sh --inside            # from inside the container

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ "${1:-}" = "--inside" ]; then
    in_container curl -fsS http://localhost:4000/healthz
    echo
else
    curl -fsS http://192.168.53.11:4000/healthz
    echo
fi
