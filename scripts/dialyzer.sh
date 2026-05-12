#!/usr/bin/env bash
# Run Dialyzer inside the container.
#
# Usage:
#   scripts/dialyzer.sh           # full whole-app type check
#   scripts/dialyzer.sh --plt     # rebuild PLT cache (slow, do once after deps change)
#
# PLT cache lives in the bind-mounted `priv/plts/` (configured via
# `mix.exs` `plt_local_path` + `plt_core_path`), so it survives container
# restarts and is shared across worktrees via the main-repo bind mount.
# Rebuild with `scripts/dialyzer.sh --plt`.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

in_container_or_oneshot mix dialyzer --format short "$@"
