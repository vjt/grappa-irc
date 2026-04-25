#!/bin/bash
# Run a mix task inside the grappa container.
#
# Usage:
#   scripts/mix.sh deps.get
#   scripts/mix.sh test
#   scripts/mix.sh phx.gen.secret
#
# If the container isn't running, falls back to a one-shot run.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if docker compose -f "$COMPOSE_FILE" ps -q grappa 2>/dev/null | grep -q .; then
    in_container mix "$@"
else
    in_oneshot mix "$@"
fi
