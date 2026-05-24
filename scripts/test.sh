#!/usr/bin/env bash
# Run mix test inside the container.
#
# Usage:
#   scripts/test.sh                              # full suite
#   scripts/test.sh test/grappa/scrollback_test.exs
#   scripts/test.sh --only integration
#   scripts/test.sh --cover                      # with coverage
#
# Routes through scripts/mix.sh's --env=test override; auto-detect would
# pick up the live container's MIX_ENV (likely dev or prod), neither of
# which is what tests want.
#
# Canonical "which test runner do I use?" docs: docs/TESTING.md.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

"$SRC_ROOT/scripts/mix.sh" --env=test test --warnings-as-errors "$@"
