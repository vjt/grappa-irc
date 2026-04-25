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

# MIX_ENV=test is set explicitly so this script works whether or not the
# container is currently in dev mode. Uses in_container_or_oneshot so a
# fresh checkout can run tests without first booting phx.server.
in_container_or_oneshot env MIX_ENV=test mix test --warnings-as-errors "$@"
