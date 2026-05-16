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
#
# Pins MIX_ENV=dev via scripts/mix.sh because dialyxir is
# `only: [:dev, :test]` and unavailable under MIX_ENV=prod.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

"$SRC_ROOT/scripts/mix.sh" --env=dev dialyzer --format short "$@"
