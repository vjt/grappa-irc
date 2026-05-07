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
#
# Behavior:
#   - testnet.sh up brings up hub + leaves + services + grappa-test +
#     nginx (idempotent — kills any prior testnet first).
#   - The runner is built + executed via `compose run`, exit code
#     propagated.
#   - Trap on EXIT runs `testnet.sh down` so a failed run leaves no
#     dangling containers, networks, or volumes.
#   - KEEP_STACK=1 opts out of the tear-down for iterative debugging
#     (delegates to the same opt-out in testnet.sh down behavior:
#     just don't call it).

set -euo pipefail

. "$(dirname "$0")/_lib.sh"

E2E_DIR="$SRC_ROOT/cicchetto/e2e"
TESTNET="$(dirname "$0")/testnet.sh"

cleanup() {
    if [ "${KEEP_STACK:-}" != "1" ]; then
        "$TESTNET" down 2>&1 || true
    else
        echo "KEEP_STACK=1 — leaving stack up. Tear down with:"
        echo "  scripts/testnet.sh down"
    fi
}
trap cleanup EXIT

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
