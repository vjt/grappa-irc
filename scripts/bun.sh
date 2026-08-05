#!/usr/bin/env bash
# Run a bun command inside an oven/bun:1 container against cicchetto/.
#
# Usage:
#   scripts/bun.sh install
#   scripts/bun.sh add phoenix
#   scripts/bun.sh run build
#   scripts/bun.sh run check                    # biome + tsc (lint + typecheck)
#   scripts/bun.sh run test                     # vitest (cic unit tests in jsdom)
#
# Canonical "which test runner do I use?" docs: docs/TESTING.md.
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
# (which exports the #538 GRAPPA_VERSION; a bare `docker compose run
# cicchetto-build` now fails loud in vite without it — prefer the script).
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

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

# oven/bun image, digest-pinned (#103 supply-chain: `oven/bun:1` is a
# major-moving tag). The tag stays for human readability; the @sha256 index
# digest enforces reproducibility and still resolves multi-arch (amd64 CI +
# arm64 dev host). Refresh on an intentional bump:
#   docker buildx imagetools inspect oven/bun:1 --format '{{.Manifest.Digest}}'
readonly BUN_IMAGE="oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4"

CICCHETTO_DIR="$SRC_ROOT/cicchetto"
BUN_CACHE_DIR="$REPO_ROOT/runtime/bun-cache"
mkdir -p "$CICCHETTO_DIR" "$BUN_CACHE_DIR"

# #538 — vite bakes GRAPPA_VERSION into <meta cicchetto-version>. This
# container mounts ONLY cicchetto/, so it cannot read mix.exs; derive the
# single-source version on the host (SRC_ROOT = this worktree) and pass it in
# via -e below. `run dev`/`run preview`/`run build` all evaluate vite.config.ts,
# which fails loud if unset — so set it for every verb (harmless for the rest).
GRAPPA_VERSION="$("$SRC_ROOT/infra/packaging/version.sh")"
export GRAPPA_VERSION

# Run bun inside the oven/bun:1 oneshot. Args are the trailing
# `docker run` operands (any extra flags + image + `bun` + bun args),
# so both the implicit install and the real invocation share one
# definition of the mount/uid/cache wiring.
run_bun() {
    # Honor CONTAINER_UID/GID like every compose service does (compose.yaml
    # `user:` + cicchetto-build tmpfs). runtime/bun-cache is bind-mounted and
    # SHARED with the compose `cicchetto-build` path; if this raw-`docker run`
    # bun used the live host UID while compose pins CONTAINER_UID, the two
    # write cache files under different owners → intermittent EACCES.
    local uid gid
    uid="${CONTAINER_UID:-$(id -u)}"
    gid="${CONTAINER_GID:-$(id -g)}"
    docker run --rm -i \
        --user "$uid:$gid" \
        -v "$CICCHETTO_DIR:/app" \
        -v "$BUN_CACHE_DIR:/cache" \
        --tmpfs "/tmp:exec,uid=$uid,gid=$gid" \
        -e HOME=/tmp \
        -e BUN_INSTALL_CACHE_DIR=/cache \
        -e GRAPPA_VERSION \
        -w /app \
        "$@"
}

# Self-heal a fresh worktree / clone: vitest, tsc, vite and biome all
# live in cicchetto/node_modules, which is PER-WORKTREE (unlike the bun
# download cache at runtime/bun-cache, which is shared). A new worktree
# has no node_modules, so the first `run test` / `run build` / `run
# check` would die with `vitest: command not found` (exit 127). Install
# on demand. The install-family verbs manage node_modules themselves —
# skip the pre-install for those (no point, and avoids double work).
case "${1:-}" in
    install | add | remove | update | outdated | pm | ci | link | unlink) ;;
    *)
        if [ ! -d "$CICCHETTO_DIR/node_modules" ]; then
            printf 'scripts/bun.sh: cicchetto/node_modules missing — running bun install...\n' >&2
            run_bun "$BUN_IMAGE" bun install >&2
        fi
        ;;
esac

# Vite dev/preview server binds 0.0.0.0:5173 inside the container. Expose
# the port to the host (and thus to the LAN, for iPhone PWA install
# testing) only for `run dev` / `run preview` — `bun add`, `run check`,
# `run test`, `run build` are short-lived and never serve traffic.
PORT_ARGS=()
if [ "${1:-}" = "run" ] && { [ "${2:-}" = "dev" ] || [ "${2:-}" = "preview" ]; }; then
    PORT_ARGS=(-p 5173:5173)
fi

run_bun "${PORT_ARGS[@]}" "$BUN_IMAGE" bun "$@"
