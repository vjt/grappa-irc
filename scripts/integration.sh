#!/usr/bin/env bash
# scripts/integration.sh — boot the integration testing stack and run
# the Playwright suite, then tear down.
#
# The stack lives at cicchetto/e2e/compose.yaml and includes the
# azzurra-testnet submodule (hub + leaves + services), grappa (dev
# image), nginx-test, cicchetto-build-test, and the playwright-runner
# itself. Stack uses no host port publishes — runs cleanly alongside
# dev/prod stacks.
#
# Usage:
#   scripts/integration.sh                      # full suite
#   scripts/integration.sh --grep mysmoke       # passes through to playwright
#
# Worktree-aware: SRC_ROOT is the worktree (or main) the script is run
# from. Compose project name is derived from the e2e/ compose `name:`
# field (`grappa-e2e`), so this stack is always distinct from the
# dev/prod project.
#
# Behavior:
#   - --build forces image rebuilds on every invocation. The dev image
#     is fast on warm cache; the runner image is a Playwright base
#     pull on first run only.
#   - --abort-on-container-exit ties the runner's exit to the whole
#     stack: when the runner finishes, compose stops everything.
#   - Trap on EXIT runs `compose down -v` so a failed run leaves no
#     dangling containers, networks, or volumes (named volumes are
#     wiped — sqlite e2e DB is ephemeral, intentionally).
#   - Exit code is the runner's exit code, propagated through compose.

set -euo pipefail

. "$(dirname "$0")/_lib.sh"

E2E_DIR="$SRC_ROOT/cicchetto/e2e"

if [ ! -f "$E2E_DIR/compose.yaml" ]; then
    die "missing $E2E_DIR/compose.yaml — is the cicchetto/e2e/infra submodule initialized? Run: git submodule update --init"
fi

if [ ! -d "$E2E_DIR/infra/bahamut" ]; then
    die "azzurra-testnet submodule looks empty. Run: git submodule update --init"
fi

# Default .env for the testnet — the submodule expects it. Operator
# can pre-supply for non-defaults; otherwise we copy the example so the
# stack boots out of the box.
if [ ! -f "$E2E_DIR/infra/.env" ]; then
    cp "$E2E_DIR/infra/.env.example" "$E2E_DIR/infra/.env"
fi

cd "$E2E_DIR"

# UID/GID handling: macOS Docker Desktop's bind-mount layer translates
# ownership transparently, so the container can stay 1000:1000 even
# though the host is 501:20. On Linux, exporting `id -u/-g` only when
# they're not 1000 keeps the build cache hot for the typical 1000:1000
# dev box (and for CI runners) while still letting non-default-UID
# Linux operators (e.g. on a NAS) override.
#
# The macOS GID=20 (staff) collides with hexpm/elixir's Debian system
# `tty` group at GID 20 — `groupadd -g 20` exits 4. Skip the override
# on macOS entirely.
if [ "$(uname -s)" = "Linux" ]; then
    export CONTAINER_UID="${CONTAINER_UID:-$(id -u)}"
    export CONTAINER_GID="${CONTAINER_GID:-$(id -g)}"
fi

# Pre-create host bind-mount targets for the bun install cache + the
# cicchetto e2e dist. Mirrors scripts/bun.sh's mkdir -p prelude. Named
# volumes won't work here: a fresh named volume is root-owned, but the
# bun + nginx containers drop to UID 1000 (or the host UID on Linux),
# so any write fails with AccessDenied. Host bind-mount inherits the
# operator's UID — `mkdir -p` from this script lands as the operator.
mkdir -p "$REPO_ROOT/runtime/bun-cache" "$REPO_ROOT/runtime/e2e/cicchetto-dist"

cleanup() {
    # Always tear down — even on Ctrl-C or a runner crash. -v wipes
    # named volumes (e2e_runtime sqlite, e2e_cicchetto_dist) so each
    # invocation gets a clean slate. _build / deps caches stay (they
    # have their own named volumes that survive `down -v` only because
    # compose doesn't list them in this stack's `volumes:` section…
    # actually they DO survive only because they're in the stack —
    # so -v wipes them too on every run, paying the warm-cache cost).
    #
    # The right knob is to let the user opt out via KEEP_STACK=1 for
    # iterative debugging.
    if [ "${KEEP_STACK:-}" != "1" ]; then
        docker compose down -v --remove-orphans 2>&1 || true
    else
        echo "KEEP_STACK=1 — leaving stack up. Tear down with:"
        echo "  cd $E2E_DIR && docker compose down -v"
    fi
}
trap cleanup EXIT

# Build the runner image first (so the abort-on-exit trigger fires
# correctly — if --abort-on-container-exit catches an early build
# failure on a different service, debugging is messy).
docker compose build playwright-runner

# Orchestration shape:
#
#   docker compose up --build -d --wait <long-running services>
#   docker compose run playwright-runner   # blocks; exit code = test result
#
# We can't use `compose up --exit-code-from runner` because that flag
# implies `--abort-on-container-exit`, which fires on the FIRST oneshot
# exit (cert-init exits 0 by design, immediately killing the rest of
# the stack via SIGTERM mid-build → cicchetto-build-test 137 → fail).
# Splitting boot from run sidesteps the all-or-nothing semantics.
#
# `--wait` blocks `up -d` until every dependency reaches its terminal
# state (`service_healthy` for grappa/hub/nginx, `service_completed_
# successfully` for cert-init + cicchetto-build-test). The runner is
# excluded from the dep graph it cares about (no service depends on
# it), so `--wait` returns once everything else is ready.
#
# Then `compose run playwright-runner` starts the runner in foreground,
# attaches stdout/stderr, and exits with the runner's exit code.

# Long-running services to bring up + wait on.
LONG_RUNNING=(hub leaf-v4 leaf-v6 services grappa-test nginx-test)

# Boot everything except the runner. --wait blocks until all healthy /
# oneshots completed.
docker compose up --build --wait "${LONG_RUNNING[@]}" "$@"

# Now run the test suite. `compose run` exit code propagates.
docker compose run --rm playwright-runner
