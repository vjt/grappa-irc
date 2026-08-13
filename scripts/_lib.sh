# shellcheck shell=bash
# Shared shell helpers for grappa scripts.
#
# Source this from every script:
#   . "$(dirname "$0")/_lib.sh"
#
# Worktree-aware: from a worktree, docker compose still drives the MAIN
# repo's compose project (whose `./:/app` bind carries the `_build`/`deps`/
# `.mix`/`.hex` caches) and the worktree's own sources are bind-mounted on
# top during oneshot runs.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
#
# Provides:
#   - SRC_ROOT           absolute path to source tree (worktree dir or main repo)
#   - REPO_ROOT          absolute path to main repo (resolved via git --git-common-dir)
#   - COMPOSE_ARGS       `-f compose.yaml [-f compose.override.yaml]` array;
#                        pass as `docker compose "${COMPOSE_ARGS[@]}" ...`.
#                        The personal override is appended when present.
#   - WORKTREE_VOLUMES   array of `-v SRC_ROOT/x:/app/x:ro` overrides (empty when on main)
#   - in_container()              runs args inside the running grappa container (errors if not up)
#   - in_oneshot()                runs args in a fresh one-shot container w/ worktree overrides
#   - in_container_or_oneshot()   live exec when on main + container up, oneshot otherwise
#   - die()                       prints to stderr and exits 1

set -euo pipefail

# SRC_ROOT — where the source we're editing lives. A worktree root has
# `lib/` AND `.git` as a FILE; the main repo has `.git` as a directory.
if [ -d "$PWD/lib" ] && [ -f "$PWD/.git" ]; then
    SRC_ROOT="$PWD"
else
    SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
export SRC_ROOT

# REPO_ROOT — the MAIN repo, so the compose project + the `_build`/`deps`
# caches are shared across all worktrees. `--git-common-dir` returns main's
# `.git` regardless of whether we're in a worktree.
REPO_ROOT="$(git -C "$SRC_ROOT" rev-parse --path-format=absolute --git-common-dir | sed 's|/\.git$||')"
export REPO_ROOT

# Compose files: unified compose.yaml (committed) + personal override
# (gitignored, optional — see compose.override.yaml.example). Prod is
# selected via `--profile prod` at the call site, NOT a separate base file.
# The override is read from REPO_ROOT, never SRC_ROOT: it is the host
# machine's deployment binding, shared by every worktree on this host.
declare -ag COMPOSE_ARGS=(-f compose.yaml)
if [ -f "$REPO_ROOT/compose.override.yaml" ]; then
    COMPOSE_ARGS+=(-f compose.override.yaml)
fi
export COMPOSE_ARGS

# Worktree source overrides — empty when running from main, so
# `"${WORKTREE_VOLUMES[@]}"` expands to nothing. From a worktree each path
# is bind-mounted on top of compose.yaml's `./:/app` bind, so the container
# sees worktree code with main's cached `_build`, `deps`, `priv/plts`.
#
# Source dirs (lib, test, config, priv/repo) are READ-WRITE; config files
# are RO. Do not "tidy" the source dirs to RO.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
#
# Escape hatch: `WRITABLE_LOCK=1 scripts/mix.sh deps.get` flips mix.lock to
# RW so dep additions made from a worktree flow back to disk.
declare -ag WORKTREE_VOLUMES=()
if [ "$SRC_ROOT" != "$REPO_ROOT" ]; then
    lock_mode="ro"
    if [ "${WRITABLE_LOCK:-}" = "1" ]; then
        lock_mode="rw"
    fi
    # WRITABLE_CIC=1 flips cicchetto/src to RW so `mix grappa.gen_wire_types`
    # can write the generated wireTypes.ts back to disk from a worktree
    # oneshot. Default RO protects cic source from container-side mutation.
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
        # VERSION is the version SSOT, read at COMPILE time by mix.exs +
        # lib/grappa/version.ex. Root-level, so it needs its own override or
        # the container compiles against MAIN's (#652).
        -v "$SRC_ROOT/VERSION:/app/VERSION:ro"
        -v "$SRC_ROOT/mix.lock:/app/mix.lock:$lock_mode"
        -v "$SRC_ROOT/.formatter.exs:/app/.formatter.exs:ro"
        -v "$SRC_ROOT/.credo.exs:/app/.credo.exs:ro"
        -v "$SRC_ROOT/.sobelow-conf:/app/.sobelow-conf:ro"
        # The next four mounts are all DRIFT-PIN inputs: root-level files a
        # test reads to assert doc-matches-reality. Without an override a
        # worktree run reads MAIN's copy and the fix can never go GREEN
        # before merge. RO — the tests only read them.
        #   CLAUDE.md    → application_supervision_tree_test.exs (#369 theme 8)
        -v "$SRC_ROOT/CLAUDE.md:/app/CLAUDE.md:ro"
        #   compose.yaml + .env.example → env_registry_drift_test.exs (#369 X1)
        -v "$SRC_ROOT/compose.yaml:/app/compose.yaml:ro"
        -v "$SRC_ROOT/.env.example:/app/.env.example:ro"
        #   bin/         → operator_help_drift_test.exs (#1086)
        -v "$SRC_ROOT/bin:/app/bin:ro"
        #   cicchetto/e2e/ → keepalive_idle_ordering_test.exs (#1030). The
        #   only cic path a server-side test reads; cicchetto/src above is
        #   mounted for a different reason and does not cover it.
        -v "$SRC_ROOT/cicchetto/e2e:/app/cicchetto/e2e:ro"
    )
fi

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

# GRAPPA_CACHE_ID — opt-in per-worker build caches (#1263).
#
# UNSET is today's behaviour, byte for byte: CACHE_VOLUMES stays empty,
# `"${CACHE_VOLUMES[@]}"` expands to nothing, and `_build`/`deps`/`priv/plts`
# keep arriving through compose.yaml's `./:/app` bind on the MAIN repo. That
# sharing is deliberate (see REPO_ROOT above) and is also why two workers on
# one host cannot compile at the same time — the orchestrator hands out an
# exclusive COMPILE lane and one of them idles.
#
# SET: the three caches are bound to `$REPO_ROOT/.caches/<id>/` instead, so
# two ids can run `mix` concurrently without meeting in one `_build`. The
# price, paid once per id: a full first compile, a dialyzer PLT of its own,
# and ~200M of disk. Nothing is seeded from the shared cache on purpose —
# artefacts compiled from another worktree's source are the very
# contamination this exists to end, and a fresh id must not inherit it.
#
# This block sits AFTER die() because it calls it: at source time a function
# defined further down does not exist yet.
declare -ag CACHE_VOLUMES=()
declare -ag CACHE_ENV=()
if [ -n "${GRAPPA_CACHE_ID:-}" ]; then
    # The id becomes a directory name and reaches a `docker -v` argument.
    # Anything outside this class — a slash, a `..`, a shell metacharacter,
    # a leading dot — is refused HERE, before any side effect.
    case "$GRAPPA_CACHE_ID" in
        *[!A-Za-z0-9._-]* | .*)
            die "GRAPPA_CACHE_ID must match [A-Za-z0-9._-]+ and may not start with a dot (got '$GRAPPA_CACHE_ID') — it becomes a directory name and a docker -v argument."
            ;;
    esac

    CACHE_ROOT="$REPO_ROOT/.caches/$GRAPPA_CACHE_ID"
    export CACHE_ROOT
    # Created host-side on purpose: docker would otherwise materialise a
    # missing bind source itself, as root on Linux, and the UID-dropped
    # container could then not write into its own cache.
    mkdir -p "$CACHE_ROOT/_build" "$CACHE_ROOT/deps" "$CACHE_ROOT/priv/plts"
    CACHE_VOLUMES=(
        -v "$CACHE_ROOT/_build:/app/_build"
        -v "$CACHE_ROOT/deps:/app/deps"
        -v "$CACHE_ROOT/priv/plts:/app/priv/plts"
    )

    # The test database is the OTHER shared resource, and it is only
    # half-solved upstream: config/test.exs builds the sqlite path from
    # MIX_TEST_PARTITION, but nothing on the shell side ever set it, and
    # `docker compose run` does not inherit host env — so setting it on the
    # host was a silent no-op and two isolated caches would still have
    # fought over one runtime/grappa_test.db. Derive it from the id (one
    # knob, one isolation identity) and FORWARD it across the boundary. An
    # explicit MIX_TEST_PARTITION wins: the operator may be partitioning
    # for a different reason.
    MIX_TEST_PARTITION="${MIX_TEST_PARTITION:-$GRAPPA_CACHE_ID}"
    export MIX_TEST_PARTITION
    CACHE_ENV=(-e "MIX_TEST_PARTITION=$MIX_TEST_PARTITION")
fi

# Guard: refuse to run from a worktree or a non-main branch. Deploy scripts
# MUST call this as their FIRST step, before any side effect — in_container's
# own worktree check fires too late to help. ALLOW_DEPLOY_FROM_BRANCH=1
# overrides the branch check. $1 is the caller's name, for the error message.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#364).
require_main_checkout() {
    local script="$1"
    if [ "$SRC_ROOT" != "$REPO_ROOT" ]; then
        die "$script must run from the main checkout, not a worktree ($SRC_ROOT). cd $REPO_ROOT and deploy from there."
    fi
    local branch
    branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
    if [ "$branch" != "main" ] && [ "${ALLOW_DEPLOY_FROM_BRANCH:-}" != "1" ]; then
        die "$script refuses to run on branch '$branch'. Set ALLOW_DEPLOY_FROM_BRANCH=1 to override."
    fi
}

# Export CONTAINER_UID/GID for the e2e compose stack on Linux, where the
# bind-mounts under runtime/ must be writable by the in-container UID (a
# no-op on macOS). MUST be called from BOTH integration.sh and testnet.sh,
# in the same shell that invokes `docker compose` — a subshell export does
# not propagate back.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
e2e_export_uid() {
    if [ "$(uname -s)" = "Linux" ]; then
        export CONTAINER_UID="${CONTAINER_UID:-$(id -u)}"
        export CONTAINER_GID="${CONTAINER_GID:-$(id -g)}"
    fi
}

# Force-remove e2e-ephemeral paths even when a prior container run left
# ROOT-OWNED files behind: plain rm first, then non-interactive sudo for
# whatever survives. Never blocks — it warns and lets the next compose
# write surface the real error.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
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

# Probe the running grappa container for its MIX_ENV; empty when none is
# up. Single source of truth for scripts/mix.sh + bin/grappa open-db.
detect_mix_env() {
    docker compose "${COMPOSE_ARGS[@]}" exec -T grappa printenv MIX_ENV 2>/dev/null | tr -d '\r' || true
}

# The container DB file path for a given MIX_ENV. The shape MUST stay
# character-identical to compose.yaml's `DATABASE_PATH:` interpolation
# (`/app/runtime/grappa_${MIX_ENV:-dev}.db`). Consumed by scripts/mix.sh +
# scripts/db.sh; partitioned test DBs are out of scope.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#364).
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

# Run a one-shot mix task without the long-running container (e.g. `mix
# deps.get` before first boot), layering worktree source overrides.
#
# `compose.oneshot.yaml` MUST stay layered LAST — its `ports: !reset []` +
# `container_name: !reset null` drop host-side bindings inherited from the
# base file or the personal override. Its path is absolute via $SRC_ROOT so
# it resolves to the worktree copy, like the WORKTREE_VOLUMES mounts.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
in_oneshot() {
    docker compose "${COMPOSE_ARGS[@]}" -f "$SRC_ROOT/compose.oneshot.yaml" \
        run --rm --no-deps "${CACHE_ENV[@]}" \
        "${WORKTREE_VOLUMES[@]}" "${CACHE_VOLUMES[@]}" grappa "$@"
}

# Prefer exec into the live container when on main and it's up; otherwise
# oneshot. From a worktree, ALWAYS oneshot — the live container has main's
# source mounted, so exec there would run the wrong code.
#
# MIX_ENV is NOT injected here; `scripts/mix.sh` is the policy layer.
in_container_or_oneshot() {
    # GRAPPA_CACHE_ID forces the oneshot (#1263). An exec enters a container
    # whose /app/_build is ALREADY bound to the shared tree, and a running
    # container cannot be remounted — so execing would hand back the shared
    # cache while the caller believes they asked for an isolated one. Silent
    # loss of the isolation is the one failure this knob must not have.
    if [ "$SRC_ROOT" = "$REPO_ROOT" ] && [ -z "${GRAPPA_CACHE_ID:-}" ]; then
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
