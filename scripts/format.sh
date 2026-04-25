#!/bin/bash
# Format Elixir code (or check formatting in CI mode).
#
# Usage:
#   scripts/format.sh           # mix format (rewrite in place)
#   scripts/format.sh --check   # mix format --check-formatted (CI mode, fails if dirty)

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ "${1:-}" = "--check" ]; then
    in_container_or_oneshot mix format --check-formatted
else
    in_container_or_oneshot mix format "$@"
fi
