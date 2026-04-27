#!/bin/bash
# Run a bun command inside an oven/bun:1 container against cicchetto/.
#
# Usage:
#   scripts/bun.sh install
#   scripts/bun.sh add phoenix
#   scripts/bun.sh run build
#   scripts/bun.sh run check
#
# cicchetto/ (the SolidJS PWA) is the working directory inside the
# container at /app. The grappa Elixir container is unaffected — bun
# is dev-only (typecheck, lint, vitest, vite preview, vite build into
# `cicchetto/dist/` for local inspection). Production deploys do NOT
# consume `cicchetto/dist/`; `scripts/deploy.sh` invokes the compose
# `cicchetto-build` oneshot which writes to the bind-mounted
# `runtime/cicchetto-dist/` (the path nginx serves). So `bun.sh run
# build` is for local preview / debugging, not "preview prod" — for a
# build that matches what nginx will serve, run `scripts/deploy.sh`
# (or the standalone `docker compose run cicchetto-build`).
#
# Worktree-aware: cicchetto/ is bind-mounted from SRC_ROOT, so each
# worktree builds from its own source. The bun install cache is a host
# bind-mount at REPO_ROOT/runtime/bun-cache — shared across all
# worktrees (REPO_ROOT is always main, regardless of caller worktree),
# so `bun install` is fast after the first run. Host bind-mount (not
# named volume) so the cache dir inherits host vjt:vjt ownership and
# the --user override below can write to it.
#
# Files written from the container land as the host user via --user.
# /tmp is a tmpfs so bun's tempdir writes succeed under the dropped
# UID (the image's default /tmp is root-owned).

. "$(dirname "$0")/_lib.sh"

CICCHETTO_DIR="$SRC_ROOT/cicchetto"
BUN_CACHE_DIR="$REPO_ROOT/runtime/bun-cache"
mkdir -p "$CICCHETTO_DIR" "$BUN_CACHE_DIR"

# Vite dev/preview server binds 0.0.0.0:5173 inside the container. Expose
# the port to the host (and thus to the LAN, for iPhone PWA install
# testing) only for `run dev` / `run preview` — `bun add`, `run check`,
# `run test`, `run build` are short-lived and never serve traffic.
PORT_ARGS=()
if [ "${1:-}" = "run" ] && { [ "${2:-}" = "dev" ] || [ "${2:-}" = "preview" ]; }; then
    PORT_ARGS=(-p 5173:5173)
fi

docker run --rm -i \
    --user "$(id -u):$(id -g)" \
    -v "$CICCHETTO_DIR:/app" \
    -v "$BUN_CACHE_DIR:/cache" \
    --tmpfs "/tmp:exec,uid=$(id -u),gid=$(id -g)" \
    -e HOME=/tmp \
    -e BUN_INSTALL_CACHE_DIR=/cache \
    -w /app \
    "${PORT_ARGS[@]}" \
    oven/bun:1 \
    bun "$@"
