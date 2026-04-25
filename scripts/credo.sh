#!/bin/bash
# Run Credo (strict by default) inside the container.
#
# Usage:
#   scripts/credo.sh           # mix credo --strict
#   scripts/credo.sh suggest   # mix credo suggest --strict (more verbose)
#   scripts/credo.sh list      # mix credo list (one-line per finding)
#   scripts/credo.sh diff master  # show issues only on changed files vs master

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ $# -eq 0 ]; then
    in_container_or_oneshot mix credo --strict
else
    in_container_or_oneshot mix credo "$@" --strict
fi
