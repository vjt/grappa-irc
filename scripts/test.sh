#!/bin/bash
# Run mix test inside the container.
#
# Usage:
#   scripts/test.sh                              # full suite
#   scripts/test.sh test/grappa/scrollback_test.exs
#   scripts/test.sh --only integration
#   scripts/test.sh --cover                      # with coverage

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

# MIX_ENV=test is the default for `mix test`, but we set it explicitly so
# this script works whether or not the container is currently in dev mode.
in_container env MIX_ENV=test mix test --warnings-as-errors "$@"
