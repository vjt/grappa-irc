#!/usr/bin/env bash
# scripts/integration.sh — boot the integration testing stack (via
# scripts/testnet.sh), run the Playwright suite, then tear down.
#
# Stack management lives in scripts/testnet.sh — bring up / probe /
# tear down the testnet without running tests by calling that directly.
# This script wraps it with a one-shot Playwright run + automatic
# tear-down on exit.
#
# Usage:
#   scripts/integration.sh                      # full suite
#   scripts/integration.sh --grep mysmoke       # passes through to playwright
#   scripts/integration.sh --project chromium --grep "spec name" --repeat-each 3
#                                               # iso-rerun for cascade-vs-flake triage
#
# Behavior:
#   - testnet.sh up brings up hub + leaves + services + grappa-test +
#     nginx (idempotent — kills any prior testnet first).
#   - The runner is built + executed via `compose run`, exit code
#     propagated.
#   - Trap on EXIT runs `testnet.sh down` so a failed run leaves no
#     dangling containers, networks, or volumes.
#   - On a NON-ZERO exit the same trap first dumps every container's
#     log to cicchetto/e2e/container-logs/ (#702). It has to happen
#     here: the tear-down below destroys the containers, so by the
#     time a CI workflow step could run `docker compose logs` there is
#     nothing left to read, and a CI-only failure is diagnosable from
#     the browser side alone.
#   - KEEP_STACK=1 opts out of the tear-down for iterative debugging
#     (delegates to the same opt-out in testnet.sh down behavior:
#     just don't call it).
#
# Canonical "which test runner do I use?" + e2e cascade-vs-flake-vs-real-bug
# triage runbook: docs/TESTING.md.

set -euo pipefail

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

E2E_DIR="$SRC_ROOT/cicchetto/e2e"
TESTNET="$(cd "$(dirname "$0")" && pwd)/testnet.sh"

# #538 — same single-source version the cic build bakes into
# <meta cicchetto-version>. testnet.sh (invoked below) also derives+exports it,
# but this script's own `docker compose run playwright-runner` re-resolves the
# stack, so set it here too (SRC_ROOT has mix.exs; the container build mounts
# only ./cicchetto and cannot).
GRAPPA_VERSION="$("$SRC_ROOT/infra/packaging/version.sh")"
export GRAPPA_VERSION

LOG_DIR="$E2E_DIR/container-logs"

# #702 — one file per container, written BEFORE the tear-down. The
# Playwright trace shows the browser half of a failure whose cause is
# usually upstream (grappa, bahamut, services); without this the
# investigation of a CI-only red stops at the browser.
capture_container_logs() {
    local services svc
    mkdir -p "$LOG_DIR"
    cd "$E2E_DIR" || return 0

    # DERIVED from what compose actually has containers for, not a hand
    # list: a hand list stops covering the service added after it was
    # written, and looks like coverage while it does (the #441 lesson,
    # same shape). `compose run --rm` one-shots (the Playwright runner)
    # are already gone by now and self-exclude — their stdout is the job
    # log anyway.
    docker compose ps --all >"$LOG_DIR/compose-ps.txt" 2>&1 || true
    services="$(docker compose ps --all --services 2>/dev/null || true)"

    while IFS= read -r svc; do
        [ -n "$svc" ] || continue
        # --timestamps so a server-side event can be lined up against the
        # trace's clock across services; --no-log-prefix because the
        # service name is already the filename.
        docker compose logs --no-color --timestamps --no-log-prefix "$svc" \
            >"$LOG_DIR/$svc.log" 2>&1 || true
    done <<<"$services"

    # Print the sizes: what this costs per failed run is a measurement,
    # not an estimate, and it is the number to revisit if it ever grows
    # into something worth capping.
    echo "=== #702: container logs captured to $LOG_DIR ==="
    ls -l "$LOG_DIR" || true
}

cleanup() {
    local rc=$?

    # Failure-only. A green run's logs answer no question, and capturing
    # them every time is how an artifact store becomes a landfill.
    if [ "$rc" -ne 0 ]; then
        capture_container_logs
    fi

    if [ "${KEEP_STACK:-}" != "1" ]; then
        "$TESTNET" down 2>&1 || true
    else
        echo "KEEP_STACK=1 — leaving stack up. Tear down with:"
        echo "  scripts/testnet.sh down"
    fi
}
trap cleanup EXIT

# CONTAINER_UID/GID must be exported in THIS shell, not just in the
# testnet.sh subshell, so the later `docker compose run playwright-runner`
# below — whose `depends_on` pulls in cicchetto-build-test — sees the
# same `user:` value testnet.sh used. Otherwise compose detects a
# config-hash drift on cicchetto-build-test (UID 1000 vs the runner's
# 1001), RECREATEs the container, and the second start fails on
# AccessDenied writing to bind-mounted dist/cache directories that the
# first run already wrote as the host UID. macOS doesn't hit this:
# Docker Desktop translates ownership transparently and `e2e_export_uid`
# is a no-op there.
e2e_export_uid

# Bring up the testnet (idempotent — kills any leftover containers
# first; rebuilds bahamut + grappa images as needed).
"$TESTNET" up

cd "$E2E_DIR"

# Build the runner image (separate from `testnet up` because the runner
# is e2e-suite-specific, not part of the testnet stack contract).
docker compose build playwright-runner

# Run the test suite. `compose run` exit code propagates.
# `--name e2e-runner` keeps the container's docker-DNS PTR short.
# Default `compose run` synthesises a long name like
# `grappa-e2e-playwright-runner-run-<hex>` (45 chars), which combined
# with the network suffix `.grappa-e2e_grappa-e2e` (22 chars) overflows
# bahamut's 63-char `HOSTLEN` cap in `dn_expand` (res.c:1064): the
# function returns -1, `proc_answer` aborts mid-parse, the DNS request
# stays PENDING for ~28s of retries, and `check_pings`'s
# `CONNECTTIMEOUT=30s` then forces SetAccess. Net effect: ~30s
# pre-welcome stall on every peer connect. Keeping the runtime
# container name short sidesteps the whole truncation path.
#
# Extra args (e.g. `--grep mN-`) are forwarded to playwright AFTER the
# image's CMD (`npx playwright test`). compose run treats everything
# after the service name as the override command, so we have to
# re-state the command and append "$@".
docker compose run --rm --name e2e-runner playwright-runner npx playwright test "$@"
