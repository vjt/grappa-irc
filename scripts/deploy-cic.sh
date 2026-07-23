#!/usr/bin/env bash
# Deploy a fresh cicchetto bundle to runtime/cicchetto-dist + notify
# the live grappa container so connected browsers see the refresh
# banner.
#
# Two-step:
#   1. `compose --profile prod run --rm cicchetto-build` — bun + Vite
#      build into the bind-mounted runtime/cicchetto-dist/. Produces a
#      new `index-<hash>.js` whose hash differs from the previous build
#      iff the source changed.
#   2. `POST /admin/cic-bundle-changed` — re-reads the new index.html
#      via `Grappa.Cic.Bundle.current_hash/0` and broadcasts
#      `{kind: "bundle_hash", hash}` on every live user-topic. cic
#      compares against `bootBundleHash` (the hash baked into the page
#      the browser loaded) and surfaces a refresh banner on mismatch.
#      Click → `window.location.reload()`.
#
# Independent of `scripts/deploy.sh`: cic deploys never need a server
# restart, server deploys never trigger a cic refresh. Each surface
# ships on its own cadence.
#
# Usage:
#   scripts/deploy-cic.sh
#
# Operator workflow: edit cicchetto/src/, then `scripts/deploy-cic.sh`.
# Browsers with the old bundle see the refresh banner within seconds.

set -euo pipefail

. "$(dirname "$0")/_lib.sh"

# #364 docker S10: assert main-checkout + main-branch BEFORE the dist
# rebuild swaps the on-disk bundle nginx serves. Pre-fix this script had
# NO branch guard (it shipped whatever the main checkout's branch held)
# and only hit in_container's worktree check AFTER the build — dist
# deployed, then a non-zero exit at the broadcast POST.
require_main_checkout "deploy-cic.sh"

cd "$REPO_ROOT"

mkdir -p runtime/cicchetto-dist

echo "Building cicchetto dist..."
docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm cicchetto-build
# Vite's `emptyOutDir` wipes .gitkeep on every build (the tracked
# placeholder is bait for fresh-clone Docker auto-mkdir-as-root —
# see .gitignore L44-46). Restore it so `git status` stays clean.
touch runtime/cicchetto-dist/.gitkeep

echo "Notifying grappa of new bundle hash..."
# Container `curl` against loopback inside the grappa pod —
# /admin/cic-bundle-changed is loopback-gated. Response body is the
# new hash on success, empty on 204 (bundle file absent — shouldn't
# happen post-build but the endpoint is safe). Routes through
# `_lib.sh in_container` so the container-name lookup is shared with
# every other operator surface (H27 from the 2026-05-22 codebase
# review) — bare `docker exec grappa` assumed `container_name: grappa`
# literally and was brittle to compose overrides.
if ! hash="$(in_container curl -fsS -X POST http://localhost:4000/admin/cic-bundle-changed)"; then
    die "cic-bundle-changed POST failed — is grappa up? scripts/healthcheck.sh"
fi

if [ -z "$hash" ]; then
    echo "✓ cic dist built; server returned 204 (no bundle on disk?)"
else
    echo "✓ cic dist built + broadcast hash=$hash to all live user-topics"
fi
