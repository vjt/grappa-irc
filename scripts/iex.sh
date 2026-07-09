#!/usr/bin/env bash
# Open an IEx shell inside the running grappa container.
#
# Usage:
#   scripts/iex.sh                # iex -S mix (loads project)
#
# Post-CP23 the image is single-stage `mix phx.server` everywhere, so
# `iex -S mix` is the only attach path — `bin/grappa remote` is gone
# along with `mix release`.

. "$(dirname "$0")/_lib.sh"

# Worktree guard (mirrors in_container's): the live container has MAIN's
# source mounted, so attaching IEx from a worktree would silently poke
# main's code, not the worktree's. We can't route through in_container
# itself — it runs `exec -T` (no TTY) and IEx needs an interactive TTY —
# so replicate just the guard and keep the interactive exec.
if [ "$SRC_ROOT" != "$REPO_ROOT" ]; then
    die "iex.sh called from a worktree — the live container runs main's source, not this worktree's. Run it from $REPO_ROOT."
fi

cd "$REPO_ROOT"

docker compose "${COMPOSE_ARGS[@]}" exec grappa iex -S mix
