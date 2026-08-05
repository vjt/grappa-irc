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

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

# #364 docker S10: assert main-checkout + main-branch BEFORE the dist
# rebuild swaps the on-disk bundle nginx serves. Pre-fix this script had
# NO branch guard (it shipped whatever the main checkout's branch held)
# and only hit in_container's worktree check AFTER the build — dist
# deployed, then a non-zero exit at the broadcast POST.
require_main_checkout "deploy-cic.sh"

cd "$REPO_ROOT"

mkdir -p runtime/cicchetto-dist

# #538 — derive the single-source version for the cic build. The
# cicchetto-build container mounts only ./cicchetto, so it can't read the repo
# root; pass GRAPPA_VERSION (from the VERSION file, #652) through the compose env.
GRAPPA_VERSION="$("$REPO_ROOT/infra/packaging/version.sh")"
export GRAPPA_VERSION
echo "Building cicchetto dist..."
docker compose "${COMPOSE_ARGS[@]}" --profile prod run --rm cicchetto-build
# Vite's `emptyOutDir` wipes .gitkeep on every build (the tracked
# placeholder is bait for fresh-clone Docker auto-mkdir-as-root —
# see .gitignore L44-46). Restore it so `git status` stays clean.
touch runtime/cicchetto-dist/.gitkeep

echo "Notifying grappa of new bundle hash..."
# Container `curl` against loopback inside the grappa pod —
# /admin/cic-bundle-changed is loopback-gated. Response body is the
# new hash on success, empty on 204 (the BEAM could not READ the bundle
# it was asked to broadcast). Routes through `_lib.sh in_container` so
# the container-name lookup is shared with every other operator surface
# (H27 from the 2026-05-22 codebase review) — bare `docker exec grappa`
# assumed `container_name: grappa` literally and was brittle to compose
# overrides.
if ! hash="$(in_container curl -fsS -X POST http://localhost:4000/admin/cic-bundle-changed)"; then
    die "cic-bundle-changed POST failed — is grappa up? scripts/healthcheck.sh"
fi

# #526: an empty body is HTTP 204 — the server could not read the dist we
# JUST built, so it broadcast NOTHING and no live client will see the
# refresh banner. That is a FAILED deploy, not a success: the whole point
# of this step is the broadcast. The old code printed a ✓ here, so the
# 2026-07-28 prod incident (CIC_DIST_ROOT resolving to a path the BEAM's
# CWD could not reach) degraded silently. Fail loud and name the fix.
if [ -z "$hash" ]; then
    die "cic-bundle-changed returned 204 (empty) — grappa built the dist but could NOT read it back to broadcast the hash, so NO refresh banner fired. Check that CIC_DIST_ROOT resolves to the dir the build wrote (runtime/cicchetto-dist). See issue #526."
fi

echo "✓ cic dist built + broadcast hash=$hash to all live user-topics"
