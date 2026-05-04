#!/usr/bin/env bash
# Tail the grappa container logs.
#
# Usage:
#   scripts/monitor.sh                # tail -f -n 50
#   scripts/monitor.sh -n 200         # custom line count
#   scripts/monitor.sh --since 10m    # logs from 10 minutes ago

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ $# -eq 0 ]; then
    args=(-n 50 -f)
else
    args=("$@")
fi

exec docker compose "${COMPOSE_ARGS[@]}" logs "${args[@]}" grappa
