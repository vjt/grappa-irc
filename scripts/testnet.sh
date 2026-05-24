#!/usr/bin/env bash
# scripts/testnet.sh — bring up / tear down / probe the integration
# testnet stack on its own (without running the Playwright suite).
#
# Wraps `cicchetto/e2e/compose.yaml` for iterative debugging — the
# integration.sh wrapper always tears the stack down on exit, which
# makes it useless when you want to inspect S2S linkup, conf rendering,
# or peer behavior interactively.
#
# Usage:
#   scripts/testnet.sh up         # build + start hub + leaves + services + grappa-test + nginx (no runner, no auto-tear-down)
#   scripts/testnet.sh down       # tear down (compose down -v --remove-orphans + wipe runtime/e2e)
#   scripts/testnet.sh status     # docker compose ps
#   scripts/testnet.sh logs <svc> # tail logs for one service
#   scripts/testnet.sh probe      # raw IRC client connect to leaf4 + /links + /stats l (oper-up auto)
#   scripts/testnet.sh shell <svc>  # exec sh inside one of the running containers
#
# Worktree-aware via _lib.sh — REPO_ROOT / SRC_ROOT resolution mirrors
# integration.sh so volumes + bind-mounts land in the right place.
#
# Canonical "which test runner do I use?" + e2e cascade-vs-flake triage
# runbook: docs/TESTING.md.

set -euo pipefail

. "$(dirname "$0")/_lib.sh"

E2E_DIR="$SRC_ROOT/cicchetto/e2e"

if [ ! -f "$E2E_DIR/compose.yaml" ]; then
    die "missing $E2E_DIR/compose.yaml"
fi
if [ ! -d "$E2E_DIR/infra/bahamut" ]; then
    die "azzurra-testnet submodule looks empty. Run: git submodule update --init"
fi
if [ ! -f "$E2E_DIR/infra/.env" ]; then
    cp "$E2E_DIR/infra/.env.example" "$E2E_DIR/infra/.env"
fi

cmd="${1:-}"
shift || true

case "$cmd" in
    up)
        # Same UID/GID handling + bind-mount mkdir as integration.sh —
        # without these the bahamut + grappa-test sqlite + cicchetto-dist
        # writes hit AccessDenied under the dropped UID.
        e2e_export_uid
        mkdir -p \
            "$REPO_ROOT/runtime/bun-cache" \
            "$SRC_ROOT/runtime/e2e/cicchetto-dist" \
            "$SRC_ROOT/runtime/e2e/grappa-runtime"

        cd "$E2E_DIR"
        # Idempotent: if a previous `testnet up` is still around (or an
        # integration.sh run died mid-flight), the bahamut leaf and the
        # grappa-test container still hold ports / DB locks / sqlite WAL
        # state. Tear down before bringing up so the second run inherits
        # a clean slate. `down -v` is destructive — wipes named volumes,
        # but those are e2e-only (deps, build, hex caches + runner
        # node_modules). The host bind-mount runtime/e2e/* is wiped in
        # the down branch, mirroring `down`.
        docker compose down -v --remove-orphans 2>&1 | tail -5 || true
        rm -rf "$SRC_ROOT/runtime/e2e/grappa-runtime" "$SRC_ROOT/runtime/e2e/cicchetto-dist"
        mkdir -p \
            "$SRC_ROOT/runtime/e2e/cicchetto-dist" \
            "$SRC_ROOT/runtime/e2e/grappa-runtime"

        # Phase 1: seeder oneshot. See integration.sh for the two-phase
        # rationale — TL;DR: re-running an already-completed seeder via
        # the dep graph trips on the duplicate user row, so we boot it
        # alone first.
        #
        # `compose run --rm` (NOT `up --wait`) — `up --wait` treats a
        # one-shot's normal exit as a healthcheck failure and returns
        # non-zero, tripping `set -e`. `run --rm` is sync + returns the
        # container's actual exit code, which is what we want for the
        # mix-task seed pipeline.
        docker compose build grappa-e2e-seeder
        docker compose run --rm grappa-e2e-seeder
        # Phase 2: long-running services (NO runner — that's what makes
        # this script different from integration.sh). `--build` here too
        # so bahamut hub + leaves pick up conf.{hub,leaf4,leaf6}.tmpl
        # edits — the seeder's `--build` only rebuilds the grappa image,
        # the azzurra-testnet bahamut images are independent and would
        # otherwise stay cached on whatever `infra/bahamut/*.tmpl` was
        # COPY'd at last build.
        docker compose up --build --wait hub leaf-v4 leaf-v6 services grappa-test nginx-test
        echo
        echo "testnet up. ports: nginx=http://nginx-test, irc=bahamut-test:6667 (in-network only)"
        echo "tear down: scripts/testnet.sh down"
        ;;
    down)
        cd "$E2E_DIR"
        docker compose down -v --remove-orphans
        rm -rf "$SRC_ROOT/runtime/e2e/grappa-runtime" "$SRC_ROOT/runtime/e2e/cicchetto-dist"
        ;;
    status)
        cd "$E2E_DIR"
        docker compose ps
        ;;
    logs)
        cd "$E2E_DIR"
        docker compose logs -f "${1:-}"
        ;;
    probe)
        # Raw IRC connect from inside the docker network. Uses nginx-test
        # as a convenient netcat host — the alpine image ships nc and is
        # already on the grappa-e2e bridge. Auto-opers via the baked-in
        # `azzurra`/`azzt3st` credential so /links + /stats l show real
        # link state. Output is raw IRC wire — useful for diagnosing
        # split-mode (255 :I have N clients and 0 servers = unlinked).
        docker exec grappa-e2e-nginx sh -c '{
            echo "NICK probe-$$";
            echo "USER probe 0 * :probe";
            sleep 1;
            echo "OPER azzurra azzt3st";
            sleep 1;
            echo "LINKS";
            sleep 1;
            echo "STATS l";
            sleep 1;
            echo "QUIT :bye";
            sleep 0.5;
        } | nc bahamut-test 6667'
        ;;
    shell)
        svc="${1:?usage: scripts/testnet.sh shell <service-name>}"
        cd "$E2E_DIR"
        docker compose exec "$svc" sh
        ;;
    *)
        die "usage: scripts/testnet.sh {up|down|status|logs <svc>|probe|shell <svc>}"
        ;;
esac
