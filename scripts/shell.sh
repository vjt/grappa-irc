#!/bin/bash
# Open a bash shell inside the running grappa container.
#
# Usage:
#   scripts/shell.sh
#
# Use for ad-hoc debugging. Don't add it to any docs flow — IEx is the
# normal entry point (scripts/iex.sh).

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

in_container bash
