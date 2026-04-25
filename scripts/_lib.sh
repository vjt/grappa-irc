# shellcheck shell=bash
# Shared shell helpers for grappa scripts.
#
# Source this from every script:
#   . "$(dirname "$0")/_lib.sh"
#
# Worktree-aware: when invoked from a git worktree, docker compose still
# uses the MAIN repo's compose project (same image, same named volumes —
# deps cache, _build cache, PLT cache, hex cache all shared). The worktree's
# source files are bind-mounted on top via -v overrides during oneshot runs,
# so the container sees worktree code with main's compiled artifacts cache.
#
# Provides:
#   - SRC_ROOT           absolute path to source tree (worktree dir or main repo)
#   - REPO_ROOT          absolute path to main repo (resolved via git --git-common-dir)
#   - COMPOSE_FILE       compose.yaml unless GRAPPA_PROD=1, then compose.prod.yaml
#   - WORKTREE_VOLUMES   array of `-v SRC_ROOT/x:/app/x:ro` overrides (empty when on main)
#   - in_container()              runs args inside the running grappa container (errors if not up)
#   - in_oneshot()                runs args in a fresh one-shot container w/ worktree overrides
#   - in_container_or_oneshot()   live exec when on main + container up, oneshot otherwise
#   - die()                       prints to stderr and exits 1

set -euo pipefail

# SRC_ROOT — where the source we're editing lives.
# A git worktree's root has `lib/` AND a `.git` FILE (not a directory —
# that's the marker that disambiguates worktree from main). Main repo has
# `lib/` and `.git` as a directory.
if [ -d "$PWD/lib" ] && [ -f "$PWD/.git" ]; then
    SRC_ROOT="$PWD"
else
    SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
export SRC_ROOT

# REPO_ROOT — the MAIN repo (so docker compose project + named volumes are
# shared across all worktrees). `git rev-parse --git-common-dir` returns the
# main repo's `.git` regardless of whether we're in a worktree.
REPO_ROOT="$(git -C "$SRC_ROOT" rev-parse --path-format=absolute --git-common-dir | sed 's|/\.git$||')"
export REPO_ROOT

COMPOSE_FILE="compose.yaml"
if [ "${GRAPPA_PROD:-}" = "1" ]; then
    COMPOSE_FILE="compose.prod.yaml"
fi
export COMPOSE_FILE

# Worktree source overrides. When SRC_ROOT == REPO_ROOT (running from main),
# this stays empty and `"${WORKTREE_VOLUMES[@]}"` expands to nothing.
# When SRC_ROOT != REPO_ROOT (running from a worktree), each path is
# bind-mounted read-only on top of compose.yaml's `./:/app` bind so the
# container sees worktree code while still benefiting from main's cached
# `_build`, `deps`, `priv/plts`, `runtime/`, etc.
declare -ag WORKTREE_VOLUMES=()
if [ "$SRC_ROOT" != "$REPO_ROOT" ]; then
    WORKTREE_VOLUMES=(
        -v "$SRC_ROOT/lib:/app/lib:ro"
        -v "$SRC_ROOT/test:/app/test:ro"
        -v "$SRC_ROOT/config:/app/config:ro"
        -v "$SRC_ROOT/priv/repo:/app/priv/repo:ro"
        -v "$SRC_ROOT/mix.exs:/app/mix.exs:ro"
        -v "$SRC_ROOT/mix.lock:/app/mix.lock:ro"
        -v "$SRC_ROOT/.formatter.exs:/app/.formatter.exs:ro"
        -v "$SRC_ROOT/.credo.exs:/app/.credo.exs:ro"
        -v "$SRC_ROOT/.sobelow-conf:/app/.sobelow-conf:ro"
    )
fi

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

in_container() {
    if [ "$SRC_ROOT" != "$REPO_ROOT" ]; then
        die "in_container called from a worktree — the live container has main's source mounted, not the worktree's. Use in_oneshot or in_container_or_oneshot."
    fi
    local cid
    cid="$(docker compose -f "$COMPOSE_FILE" ps -q grappa 2>/dev/null || true)"
    if [ -z "$cid" ]; then
        die "grappa container is not running. Start it with: docker compose up -d"
    fi
    docker compose -f "$COMPOSE_FILE" exec -T grappa "$@"
}

# Run a one-shot mix task without requiring the long-running container.
# Useful for `mix deps.get`, `mix ecto.create`, etc. before first boot.
# Layers worktree source overrides if invoked from a worktree.
in_oneshot() {
    docker compose -f "$COMPOSE_FILE" run --rm --no-deps "${WORKTREE_VOLUMES[@]}" grappa "$@"
}

# Prefer exec into the live container when on main and it's up; otherwise
# oneshot. From a worktree, ALWAYS oneshot — the live container has main's
# source mounted, not the worktree's, so exec there would run the wrong code.
in_container_or_oneshot() {
    if [ "$SRC_ROOT" = "$REPO_ROOT" ] \
       && docker compose -f "$COMPOSE_FILE" ps -q grappa 2>/dev/null | grep -q .; then
        docker compose -f "$COMPOSE_FILE" exec -T grappa "$@"
    else
        in_oneshot "$@"
    fi
}
