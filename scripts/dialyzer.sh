#!/bin/bash
# Run Dialyzer inside the container.
#
# Usage:
#   scripts/dialyzer.sh           # full whole-app type check
#   scripts/dialyzer.sh --plt     # rebuild PLT cache (slow, do once after deps change)
#
# PLT cache lives in the named volume grappa_build (under _build/dev/dialyxir_*),
# so it survives container restarts but is rebuilt cleanly with `docker compose down -v`.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

in_container mix dialyzer --format short "$@"
