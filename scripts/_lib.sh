# shellcheck shell=bash
# Shared shell helpers for grappa scripts.
#
# Source this from every script:
#   . "$(dirname "$0")/_lib.sh"
#
# Provides:
#   - REPO_ROOT          absolute path to /srv/grappa (or wherever the repo lives)
#   - COMPOSE_FILE       compose.yaml unless GRAPPA_PROD=1, then compose.prod.yaml
#   - in_container()     runs args inside the running grappa container (errors if not up)
#   - in_oneshot()       runs args in a fresh one-shot container (no live service needed)
#   - in_container_or_oneshot()  picks live exec when up, oneshot otherwise
#   - die()              prints to stderr and exits 1

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT

COMPOSE_FILE="compose.yaml"
if [ "${GRAPPA_PROD:-}" = "1" ]; then
    COMPOSE_FILE="compose.prod.yaml"
fi
export COMPOSE_FILE

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

in_container() {
    local cid
    cid="$(docker compose -f "$COMPOSE_FILE" ps -q grappa 2>/dev/null || true)"
    if [ -z "$cid" ]; then
        die "grappa container is not running. Start it with: docker compose up -d"
    fi
    docker compose -f "$COMPOSE_FILE" exec -T grappa "$@"
}

# Run a one-shot mix task without requiring the long-running container.
# Useful for `mix deps.get`, `mix ecto.create`, etc. before first boot.
in_oneshot() {
    docker compose -f "$COMPOSE_FILE" run --rm --no-deps grappa "$@"
}

# Prefer exec into the live container; fall back to one-shot if not running.
# Use for stateless mix tasks (test, credo, dialyzer, format, etc.) so they
# work whether or not the operator has booted the long-running service.
in_container_or_oneshot() {
    if docker compose -f "$COMPOSE_FILE" ps -q grappa 2>/dev/null | grep -q .; then
        docker compose -f "$COMPOSE_FILE" exec -T grappa "$@"
    else
        in_oneshot "$@"
    fi
}
