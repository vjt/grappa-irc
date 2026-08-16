#!/usr/bin/env bash
# scripts/integration.sh — boot the integration testing stack (via
# scripts/testnet.sh), run the Playwright suite, then tear down.
#
# Stack management lives in scripts/testnet.sh — call that directly to
# bring up / probe / tear down the testnet without running tests.
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
#   - Trap on EXIT runs `testnet.sh down`; on a NON-ZERO exit it first
#     dumps every container's log to cicchetto/e2e/container-logs/.
#   - On EVERY exit, green included, it writes a gap census beside them
#     (#1429): the same streams, scanned in flight, a few KB.
#   - KEEP_STACK=1 opts out of the tear-down for iterative debugging.
#
# Canonical "which test runner do I use?" + e2e cascade-vs-flake-vs-real-bug
# triage runbook: docs/TESTING.md.

set -euo pipefail

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

E2E_DIR="$SRC_ROOT/cicchetto/e2e"
TESTNET="$(cd "$(dirname "$0")" && pwd)/testnet.sh"

# Export the single-source version here too, NOT only in testnet.sh: the
# `docker compose run playwright-runner` below re-resolves the stack.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)" (#538).
GRAPPA_VERSION="$("$SRC_ROOT/infra/packaging/version.sh")"
export GRAPPA_VERSION

LOG_DIR="$E2E_DIR/container-logs"
CENSUS_FILE="$LOG_DIR/gap-scan.tsv"
SCAN_AWK="$(cd "$(dirname "$0")" && pwd)/log-gap-scan.awk"

# Inter-line silence worth naming, in seconds. Above the stack's 5 s
# healthcheck cadence, below the 30 s busy_timeout whose expiry #1420 is
# counting — so an idle stack scores zero gaps and a stalled one scores.
GAP_THRESHOLD=10

# One log file per container, written BEFORE the tear-down destroys them,
# plus the gap census taken from the same streams on EVERY exit.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)"
# (#702, #1429).
#
# $1 is "raw" to also materialise the streams to disk, anything else to
# keep the census alone. Required: the caller holds the exit code.
capture_container_logs() {
    local mode="$1"
    local services svc sink

    mkdir -p "$LOG_DIR"
    cd "$E2E_DIR" || return 0

    # DERIVED from what compose actually has containers for, never a hand
    # list. `compose run --rm` one-shots are already gone and self-exclude.
    if [ "$mode" = raw ]; then
        docker compose ps --all >"$LOG_DIR/compose-ps.txt" 2>&1 || true
    fi
    services="$(docker compose ps --all --services 2>/dev/null || true)"

    : >"$CENSUS_FILE"
    while IFS= read -r svc; do
        [ -n "$svc" ] || continue
        if [ "$mode" = raw ]; then sink="$LOG_DIR/$svc.log"; else sink=/dev/null; fi
        # --timestamps so a server-side event can be lined up against the
        # trace's clock across services — and so the census can measure the
        # silence BETWEEN lines; --no-log-prefix because the service name
        # is already the filename. `tee` is what lets the ~275 MB reach the
        # scanner without reaching the disk on a green run.
        docker compose logs --no-color --timestamps --no-log-prefix "$svc" 2>&1 \
            | tee "$sink" \
            | awk -v SVC="$svc" -v THRESH="$GAP_THRESHOLD" -f "$SCAN_AWK" \
                >>"$CENSUS_FILE" || true
    done <<<"$services"

    # To stdout as well: on a green run CI keeps the job log and no
    # artifact, so this is the copy that survives by default.
    echo "=== #1429: log gap census (threshold ${GAP_THRESHOLD}s) ==="
    cat "$CENSUS_FILE" || true

    if [ "$mode" = raw ]; then
        # Print the sizes — what a failed run costs in artifacts is
        # measured, not estimated.
        echo "=== #702: container logs captured to $LOG_DIR ==="
        ls -l "$LOG_DIR" || true
    fi
}

# The two retention triggers, read off the census the trap just wrote.
#
# ATTRIBUTION and RETENTION are different jobs, and only the first is
# single-criterion. Blaming a red uses ONE rule — a silence at or over
# GAP_THRESHOLD — and that rule is untouched here. Deciding what evidence
# to still have tomorrow is the other job, and there a silence is only a
# PROXY for the mechanism while a dropped row IS the damage. Discarding
# the bytes of a run that lost data without stalling would make "damage
# WITHOUT a stall" permanently unobservable — the class nobody can
# currently prove exists.
census_has_gap() {
    grep -q -- $'\tGAP\t' "$CENSUS_FILE" 2>/dev/null
}

census_has_dropped() {
    grep -qE -- $'\tdropped=[1-9]' "$CENSUS_FILE" 2>/dev/null
}

# Which trigger fired, as the census's last line. Costs nothing and makes
# "damage without a stall" COUNTABLE across artifacts rather than merely
# retained: one grep over the uploads answers whether the class exists.
record_retention() {
    printf 'RUN\tRETENTION\tkept=%s\tby_gap=%s\tby_dropped=%s\n' \
        "$1" "$2" "$3" >>"$CENSUS_FILE"
}

cleanup() {
    local rc=$?
    local by_gap=0 by_dropped=0 kept=no

    # The census on both exits; the bytes on a red, and on a green when
    # either trigger fired. Evidence collection, never an assertion — no
    # branch here touches $rc.
    if [ "$rc" -ne 0 ]; then
        capture_container_logs raw
        kept=yes
    else
        capture_container_logs census-only
    fi

    if census_has_gap; then by_gap=1; fi
    if census_has_dropped; then by_dropped=1; fi

    if [ "$kept" = no ] && { [ "$by_gap" = 1 ] || [ "$by_dropped" = 1 ]; }; then
        # The one green worth its bytes. Costs a second extraction, which
        # is the right place to spend it.
        echo "=== #1429: census tripped on a GREEN run — keeping the bytes ==="
        capture_container_logs raw
        kept=yes
    fi

    # AFTER the last capture: capture_container_logs truncates the census,
    # so a verdict written before it would be wiped by it.
    record_retention "$kept" "$by_gap" "$by_dropped"

    if [ "${KEEP_STACK:-}" != "1" ]; then
        "$TESTNET" down 2>&1 || true
    else
        echo "KEEP_STACK=1 — leaving stack up. Tear down with:"
        echo "  scripts/testnet.sh down"
    fi
}
trap cleanup EXIT

# CONTAINER_UID/GID must be exported in THIS shell, not just in the
# testnet.sh subshell, so the `docker compose run playwright-runner` below
# sees the same `user:` value testnet.sh used.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
e2e_export_uid

# Bring up the testnet (idempotent — kills any leftover containers
# first; rebuilds bahamut + grappa images as needed).
"$TESTNET" up

cd "$E2E_DIR"

# Build the runner image — e2e-suite-specific, not part of the testnet
# stack contract, hence separate from `testnet up`.
docker compose build playwright-runner

# Run the test suite; `compose run` exit code propagates. `--name
# e2e-runner` keeps the container's docker-DNS PTR SHORT — do not drop it.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
#
# compose run treats everything after the service name as the override
# command, so the image's CMD is re-stated here and extra args (e.g.
# `--grep mN-`) appended.
docker compose run --rm --name e2e-runner playwright-runner npx playwright test "$@"
