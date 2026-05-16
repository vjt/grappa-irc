#!/usr/bin/env bash
# Format Elixir code (or check formatting in CI mode).
#
# Usage:
#   scripts/format.sh           # mix format (rewrite in place)
#   scripts/format.sh --check   # mix format --check-formatted (CI mode, fails if dirty)
#
# Pins MIX_ENV=dev via scripts/mix.sh for consistency with the
# dev-tooling family — `.formatter.exs` may pull dev-only formatter
# plugins in the future.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ "${1:-}" = "--check" ]; then
    "$SRC_ROOT/scripts/mix.sh" --env=dev format --check-formatted
else
    "$SRC_ROOT/scripts/mix.sh" --env=dev format "$@"
fi
