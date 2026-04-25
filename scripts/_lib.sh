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
# bind-mounted on top of compose.yaml's `./:/app` bind so the container
# sees worktree code while still benefiting from main's cached `_build`,
# `deps`, `priv/plts`, `runtime/`, etc.
#
# Source directories (lib, test, config, priv/repo) are mounted READ-WRITE
# because Elixir 1.19's incremental compiler updates source-file mtimes
# (`File.touch!`) for staleness tracking. RO mounts produce
# `File.Error: read-only file system` on every recompile cycle that
# touches a changed source. Container UID matches host UID via
# CONTAINER_UID in compose.yaml, so writes from the container land as
# the host user — no privilege escalation surface to defend against.
#
# Config files (mix.exs, mix.lock, .formatter.exs, .credo.exs,
# .sobelow-conf) stay RO because the compiler never touches them, but
# `mix deps.get` could mutate mix.lock — RO prevents drift between
# what's checked in and what the worktree sees during a oneshot run.
#
# Escape hatch: `WRITABLE_LOCK=1 scripts/mix.sh deps.get` flips mix.lock
# to RW so dep additions in worktrees actually flow back to disk. Use
# only when intentionally adding/updating deps from a worktree branch
# (the resulting mix.lock change should be committed on that branch and
# merged back via the normal worktree workflow).
declare -ag WORKTREE_VOLUMES=()
if [ "$SRC_ROOT" != "$REPO_ROOT" ]; then
    lock_mode="ro"
    if [ "${WRITABLE_LOCK:-}" = "1" ]; then
        lock_mode="rw"
    fi
    WORKTREE_VOLUMES=(
        -v "$SRC_ROOT/lib:/app/lib"
        -v "$SRC_ROOT/test:/app/test"
        -v "$SRC_ROOT/config:/app/config"
        -v "$SRC_ROOT/priv/repo:/app/priv/repo"
        -v "$SRC_ROOT/mix.exs:/app/mix.exs:ro"
        -v "$SRC_ROOT/mix.lock:/app/mix.lock:$lock_mode"
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
#
# `compose.oneshot.yaml` is layered ON TOP of $COMPOSE_FILE so the run
# container drops the static vlan53 IP + fixed container_name. Without
# this, a oneshot started while ANY long-lived container (dev or prod)
# holds 192.168.53.11 bombs with "Address already in use".
#
# The override path is absolute via $SRC_ROOT so the file resolves to
# the worktree copy (when running from a worktree) — the scripts cd to
# REPO_ROOT first, but oneshot config should track the worktree, same
# as the source mounts in WORKTREE_VOLUMES.
in_oneshot() {
    docker compose -f "$COMPOSE_FILE" -f "$SRC_ROOT/compose.oneshot.yaml" \
        run --rm --no-deps "${WORKTREE_VOLUMES[@]}" grappa "$@"
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
