# shellcheck shell=bash
# Shared shell helpers for grappa scripts.
#
# Source this from every script:
#   . "$(dirname "$0")/_lib.sh"
#
# Worktree-aware: when invoked from a git worktree, docker compose still
# uses the MAIN repo's compose project (same image; `_build`/`deps`/`.mix`/
# `.hex` live inside the MAIN repo's `./:/app` bind mount — the named-volume
# shadowing was dropped, see compose.yaml grappa `volumes:`). The worktree's
# source files are bind-mounted on top via -v overrides during oneshot runs,
# so the container sees worktree code with main's compiled artifacts cache.
#
# Provides:
#   - SRC_ROOT           absolute path to source tree (worktree dir or main repo)
#   - REPO_ROOT          absolute path to main repo (resolved via git --git-common-dir)
#   - COMPOSE_ARGS       `-f compose.yaml [-f compose.override.yaml]` array;
#                        pass as `docker compose "${COMPOSE_ARGS[@]}" ...`.
#                        compose.yaml is unified (CP23 collapse — dev grappa-only,
#                        prod gated by `--profile prod`); the personal override
#                        is appended when present.
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

# REPO_ROOT — the MAIN repo (so the docker compose project + the repo-tree
# bind mounts that carry the `_build`/`deps` caches are shared across all
# worktrees). `git rev-parse --git-common-dir` returns the
# main repo's `.git` regardless of whether we're in a worktree.
REPO_ROOT="$(git -C "$SRC_ROOT" rev-parse --path-format=absolute --git-common-dir | sed 's|/\.git$||')"
export REPO_ROOT

# Compose files: unified compose.yaml (committed) + personal override
# (gitignored, optional). Personal overrides bind to a deployment-specific
# LAN IP / set $PHX_HOST / pin $GRAPPA_PUBLISH. See
# compose.override.yaml.example. Prod is selected via `--profile prod`
# at the call site, NOT via a separate base file (CP23 collapse).
#
# All scripts cd to $REPO_ROOT before running docker compose, so relative
# paths resolve against the main repo. The override is read from REPO_ROOT
# (not SRC_ROOT) because it represents the host machine's deployment
# binding, not the worktree's source — every worktree on this host shares
# the same LAN binding.
declare -ag COMPOSE_ARGS=(-f compose.yaml)
if [ -f "$REPO_ROOT/compose.override.yaml" ]; then
    COMPOSE_ARGS+=(-f compose.override.yaml)
fi
export COMPOSE_ARGS

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
    # WRITABLE_CIC=1 flips cicchetto/src to RW so `mix grappa.gen_wire_types`
    # can write the generated wireTypes.ts back to disk from a worktree
    # oneshot. Without it the codegen task hits read-only filesystem when
    # invoked via scripts/mix.sh; the default RO mount protects cic source
    # from accidental container-side mutation during normal mix tasks.
    cic_mode="ro"
    if [ "${WRITABLE_CIC:-}" = "1" ]; then
        cic_mode="rw"
    fi
    WORKTREE_VOLUMES=(
        -v "$SRC_ROOT/lib:/app/lib"
        -v "$SRC_ROOT/test:/app/test"
        -v "$SRC_ROOT/config:/app/config"
        -v "$SRC_ROOT/priv/repo:/app/priv/repo"
        -v "$SRC_ROOT/infra:/app/infra:ro"
        -v "$SRC_ROOT/cicchetto/src:/app/cicchetto/src:$cic_mode"
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

# Export CONTAINER_UID/GID for the e2e compose stack on Linux. macOS lets
# Docker Desktop translate ownership transparently, so leaving the
# defaults (1000) is fine; on Linux the bind-mounts to runtime/bun-cache
# and runtime/e2e/cicchetto-dist must be writable by the in-container
# UID, so we drop to the host UID. MUST be called from BOTH integration.sh
# and testnet.sh in the same shell that invokes `docker compose ...` —
# `testnet.sh up` runs in a subshell when invoked by integration.sh, so
# the export there does NOT propagate back. CI symptom of getting this
# wrong: the cicchetto-build-test config-hash drifts between the two
# `compose up` phases (testnet.sh's, then integration.sh's during the
# playwright-runner depends_on chain), compose RECREATEs the container,
# and the second start exits 1 on AccessDenied writing to dist/cache.
e2e_export_uid() {
    if [ "$(uname -s)" = "Linux" ]; then
        export CONTAINER_UID="${CONTAINER_UID:-$(id -u)}"
        export CONTAINER_GID="${CONTAINER_GID:-$(id -g)}"
    fi
}

# Force-remove e2e-ephemeral paths even when a prior container run left
# ROOT-OWNED files behind (cicchetto-dist / grappa-runtime / playwright
# test-results sometimes land as uid 0 despite the --user drop, e.g. when
# an image's entrypoint writes before su-exec, or a pre-`e2e_export_uid`
# run wrote them). A plain `rm -rf` then fails with Permission denied,
# and under `set -e` that aborts the NEXT `testnet up` with the symptoms
# operators keep re-hitting: cicchetto-dist AccessDenied, sqlite
# database_open_failed, "Pool overlaps". This used to be a manual
# `sudo rm -rf runtime/e2e/* ...` ritual that everyone forgot. Now it's
# automatic: plain rm first, then non-interactive sudo for whatever
# survives and is root-owned. Never blocks (warns if it cannot clean —
# the next compose write surfaces the real error loudly anyway).
e2e_force_rm() {
    rm -rf "$@" 2>/dev/null || true
    local p
    for p in "$@"; do
        [ -e "$p" ] || continue
        if sudo -n rm -rf "$p" 2>/dev/null; then
            continue
        fi
        printf 'e2e_force_rm: could not remove root-owned %s — run: sudo rm -rf %s\n' "$p" "$p" >&2
    done
}

# Probe the running grappa container for its MIX_ENV. Empty string when
# no container is up. Used by scripts/mix.sh (auto-detect default) and
# bin/grappa open-db (active env's DB file). Single source of truth so
# the two callers can't drift.
detect_mix_env() {
    docker compose "${COMPOSE_ARGS[@]}" exec -T grappa printenv MIX_ENV 2>/dev/null | tr -d '\r' || true
}

# The container DB file path for a given MIX_ENV. The path shape MUST stay
# character-identical to compose.yaml's `DATABASE_PATH:` interpolation
# (`/app/runtime/grappa_${MIX_ENV:-dev}.db`) — this is the shell-side
# source of truth. compose.yaml derives DATABASE_PATH from the HOST's
# MIX_ENV at container-create time; any caller that overrides MIX_ENV
# *in-process* (scripts/mix.sh --env=<env>) MUST inject a matching
# DATABASE_PATH via this helper, or runtime.exs reads the wrong DB file
# for the selected env (#364 docker S5).
db_path_for_env() {
    printf '/app/runtime/grappa_%s.db' "$1"
}

in_container() {
    if [ "$SRC_ROOT" != "$REPO_ROOT" ]; then
        die "in_container called from a worktree — the live container has main's source mounted, not the worktree's. Use in_oneshot or in_container_or_oneshot."
    fi
    local cid
    cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -q grappa 2>/dev/null || true)"
    if [ -z "$cid" ]; then
        die "grappa container is not running. Start it with: docker compose up -d"
    fi
    docker compose "${COMPOSE_ARGS[@]}" exec -T grappa "$@"
}

# Run a one-shot mix task without requiring the long-running container.
# Useful for `mix deps.get`, `mix ecto.create`, etc. before first boot.
# Layers worktree source overrides if invoked from a worktree.
#
# `compose.oneshot.yaml` is layered LAST so its `ports: !reset []` and
# `container_name: !reset null` overrides drop any host-side bindings
# inherited from the base compose file or the personal override.
# Without this, a oneshot started while ANY long-lived container holds
# the same host port bombs with "Address already in use".
#
# The oneshot override path is absolute via $SRC_ROOT so the file
# resolves to the worktree copy when running from a worktree — same as
# the source mounts in WORKTREE_VOLUMES.
in_oneshot() {
    docker compose "${COMPOSE_ARGS[@]}" -f "$SRC_ROOT/compose.oneshot.yaml" \
        run --rm --no-deps "${WORKTREE_VOLUMES[@]}" grappa "$@"
}

# Prefer exec into the live container when on main and it's up; otherwise
# oneshot. From a worktree, ALWAYS oneshot — the live container has main's
# source mounted, not the worktree's, so exec there would run the wrong
# code.
#
# MIX_ENV is NOT injected here; the caller is responsible. `scripts/mix.sh`
# is the policy layer (auto-detects MIX_ENV from the running container,
# `--env=<env>` for explicit override). Dev-deps sibling scripts
# (credo.sh, dialyzer.sh, format.sh, etc.) route through `scripts/mix.sh
# --env=dev` because dev-only deps (credo, dialyxir, sobelow, mix_audit,
# doctor, ex_doc) live behind `only: [:dev, :test]` in mix.exs and aren't
# compiled into prod images.
#
# Post-CP23 the unified image always has `mix` (single-stage, no release
# binary), so the legacy mix-probe defensive branch is gone — any
# running `grappa` container is exec-able for mix tasks.
in_container_or_oneshot() {
    if [ "$SRC_ROOT" = "$REPO_ROOT" ]; then
        local cid
        cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -q grappa 2>/dev/null || true)"
        if [ -n "$cid" ]; then
            docker compose "${COMPOSE_ARGS[@]}" exec -T \
                -e HOME=/app \
                -e XDG_CACHE_HOME=/app/.cache \
                -e XDG_DATA_HOME=/app/.local/share \
                grappa "$@"
            return
        fi
    fi
    in_oneshot "$@"
}
