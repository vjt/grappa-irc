#!/usr/bin/env bash
#
# quickstart-update.sh — bring an already-installed quickstart box up to
# the latest revision of whatever branch it tracks.
#
# Why this exists next to the other two:
#
#   * `quickstart.sh` INSTALLS. It deliberately never touches git, so
#     re-running it can only ever re-install what is already on disk.
#   * `deploy.sh` DEPLOYS PRODUCTION. Its `require_main_checkout` guard
#     refuses anything that is not the main checkout sitting on main —
#     correct there, useless for a staging box parked on a feature
#     branch, which is exactly what #469 asks for.
#
# So: pull, work out from the diff which of the expensive steps are
# actually needed, run only those, recreate the stack, wait for health.
#
# The whole project tree is bind-mounted into the container
# (`./:/app` in compose.yaml) and the image is toolchain-only, so a code
# change needs no image rebuild — the BEAM compiles from the mounted tree
# at boot. That is what makes a cheap update possible at all, and what
# decides the trigger list below.
#
# This is NOT the hot-reload path. `deploy.sh` can swap modules in a live
# BEAM via POST /admin/reload and keep sessions; here we always recreate.
# A staging box exists to be restarted, and a restart cannot be wrong,
# whereas a hot reload can be — see Grappa.Deploy.Preflight for the
# module shapes that silently refuse to swap.
#
# Usage:
#   scripts/quickstart-update.sh            # pull, then update
#   scripts/quickstart-update.sh --no-pull  # update from the working tree

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Same pin as quickstart.sh — the committed compose file only, no
# override auto-merge, so what this updates is what that installed.
COMPOSE=(docker compose -f compose.yaml)

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

PULL=1
case "${1:-}" in
  --no-pull) PULL=0 ;;
  '')        ;;
  *) die "usage: scripts/quickstart-update.sh [--no-pull]" ;;
esac

# ---- 0. preflight ------------------------------------------------------
# Every check that can refuse the run lives here, BEFORE the first side
# effect: a box left half-updated is worse than one not updated at all.
[ -f compose.yaml ] || die "compose.yaml not in $REPO_ROOT — run this from a grappa checkout."
[ -f .env ] || die "no .env in $REPO_ROOT — this box was never installed. Run scripts/quickstart.sh first."
command -v docker >/dev/null 2>&1 || die "docker not found."
git rev-parse --git-dir >/dev/null 2>&1 || die "not a git checkout — nothing to update from."

if [ "$PULL" -eq 1 ]; then
  # A fast-forward onto a dirty tree either fails halfway or silently
  # carries local edits into what you are about to call "the latest
  # revision". Refuse instead, and say which files.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    warn "uncommitted changes in the checkout:"
    git status --short >&2
    die "refusing to pull onto a dirty tree — commit, stash or use --no-pull."
  fi
fi

# ---- 1. move the checkout ---------------------------------------------
prev="$(git rev-parse HEAD)"

if [ "$PULL" -eq 1 ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  say "Pulling ${branch} (fast-forward only)"
  # --ff-only on purpose: if the branch diverged, that is a decision for
  # a human, not something an update script should resolve.
  git pull --ff-only || die "pull is not a fast-forward — the branch diverged. Resolve it by hand."
fi

now="$(git rev-parse HEAD)"

if [ "$prev" = "$now" ]; then
  changed=""
else
  changed="$(git diff --name-only "$prev" "$now")"
fi

# ---- 2. classify the diff ----------------------------------------------
# Each trigger is a thing the bind-mounted tree does NOT give us for free
# at container boot.
touched() { printf '%s\n' "$changed" | grep -qE "$1"; }

need_build=0; need_deps=0; need_migrate=0; need_cic=0
if [ -n "$changed" ]; then
  # The image is toolchain-only, so only its own recipe can invalidate it.
  touched '^Dockerfile$|^\.dockerignore$'      && need_build=1
  # deps/ lives in the mounted tree but is populated by mix, not by git.
  touched '^mix\.(lock|exs)$'                  && need_deps=1
  # Migrations must land before the app that expects them boots.
  touched '^priv/repo/migrations/'             && need_migrate=1
  # The PWA bundle is built by the bun oneshot into runtime/, not compiled
  # by the BEAM, so a frontend change is invisible without it.
  touched '^cicchetto/'                        && need_cic=1
fi

# ---- 3. do only what the diff asked for --------------------------------
if [ -z "$changed" ]; then
  say "already up to date at $(git rev-parse --short HEAD) — ensuring the stack is up"
  "${COMPOSE[@]}" --profile prod up -d
else
  say "Updating $(git rev-parse --short "$prev") → $(git rev-parse --short "$now")"

  [ "$need_build" -eq 1 ]   && { say "Dockerfile changed — rebuilding the image"; \
                                 "${COMPOSE[@]}" --profile prod build grappa; }
  [ "$need_deps" -eq 1 ]    && { say "mix.lock changed — fetching deps"; \
                                 "${COMPOSE[@]}" --profile prod run --rm --no-deps grappa mix deps.get; }
  [ "$need_cic" -eq 1 ]     && { say "cicchetto changed — rebuilding the PWA bundle"; \
                                 "${COMPOSE[@]}" --profile prod run --rm cicchetto-build; }
  [ "$need_migrate" -eq 1 ] && { say "new migrations — running ecto.migrate"; \
                                 "${COMPOSE[@]}" --profile prod run --rm --no-deps grappa mix ecto.migrate; }

  say "Recreating grappa + nginx"
  # --no-deps so compose does not drag the oneshot back in; it either ran
  # above or had no reason to.
  "${COMPOSE[@]}" --profile prod up -d --force-recreate --no-deps grappa nginx
fi

# ---- 4. wait for health ------------------------------------------------
# Probed from inside nginx, so it is independent of how the host port is
# published. A recompile of the mounted tree happens on this boot, hence
# the generous window.
say "Waiting for /healthz"
deadline=$((SECONDS + 600))
until "${COMPOSE[@]}" exec -T nginx wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    warn "stack did not become healthy in time. Inspect with:"
    warn "  ${COMPOSE[*]} --profile prod logs --tail=100 grappa"
    die "health check timed out"
  fi
  printf '.'; sleep 3
done
printf '\n'

# ---- 5. report ---------------------------------------------------------
# Read the bind back out of .env rather than assuming a default: an
# earlier run may have pinned it elsewhere, and printing a URL nobody
# listens on is the #469 bug this box already had once.
published="$(sed -n 's/^NGINX_PUBLISH=//p' .env | tail -n1)"
published="${published%:80}"
case "$published" in
  '')            published="127.0.0.1:3000" ;;
  0.0.0.0:*)     published="127.0.0.1:${published##*:}" ;;
  '[::]:'*)      published="127.0.0.1:${published##*:}" ;;
  *:*)           ;;
  *)             published="127.0.0.1:${published}" ;;
esac

say "grappa is up and healthy at $(git rev-parse --short HEAD) 🎉"
cat <<EOF

  Web UI:   http://${published}/
  Health:   curl http://${published}/healthz

  Logs:     ${COMPOSE[*]} --profile prod logs -f grappa
  Stop:     ${COMPOSE[*]} --profile prod down
EOF
