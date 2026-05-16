#!/usr/bin/env bash
# Run Credo (strict by default) inside the container.
#
# Usage:
#   scripts/credo.sh           # mix credo --strict
#   scripts/credo.sh suggest   # mix credo suggest --strict (more verbose)
#   scripts/credo.sh list      # mix credo list (one-line per finding)
#   scripts/credo.sh diff master  # show issues only on changed files vs master
#
# Pins MIX_ENV=dev via scripts/mix.sh because credo is `only: [:dev, :test]`
# and unavailable under MIX_ENV=prod (the typical live-container env).

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ $# -eq 0 ]; then
    "$SRC_ROOT/scripts/mix.sh" --env=dev credo --strict
else
    "$SRC_ROOT/scripts/mix.sh" --env=dev credo "$@" --strict
fi
