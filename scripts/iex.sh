#!/bin/bash
# Open an IEx shell inside the running grappa container.
#
# Usage:
#   scripts/iex.sh                # iex -S mix (loads project)
#   scripts/iex.sh --remsh         # remote-shell into the running release (prod only)

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ "${1:-}" = "--remsh" ]; then
    docker compose -f "$COMPOSE_FILE" exec grappa bin/grappa remote
else
    docker compose -f "$COMPOSE_FILE" exec grappa iex -S mix
fi
