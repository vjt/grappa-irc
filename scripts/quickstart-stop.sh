#!/usr/bin/env bash
#
# quickstart-stop.sh — take a quickstart box all the way down.
#
# Why this exists next to the other two:
#
#   * `quickstart.sh` INSTALLS and `quickstart-update.sh` UPDATES; both
#     end by printing a stop command, and both print it with the profile
#     because without it the command is wrong.
#   * The long-lived nginx sits behind the `prod` compose profile, so a
#     plain `docker compose down` never considers it. It stays up, keeps
#     the project network attached, and the down ends with
#
#         Network <project>_grappa_internal  Resource is still in use
#
#     which reads like a docker glitch and is really "half your box is
#     still running". The fix is one flag nobody remembers at the moment
#     they need it.
#
# So: the same preflight and the same ownership guard as the other two,
# then the down that actually finishes.
#
# Usage:
#   scripts/quickstart-stop.sh              # stop the stack
#   scripts/quickstart-stop.sh --volumes    # ...and drop its named volumes

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Same pin as the other two — the committed compose file only, no
# override auto-merge, so what this stops is what those started.
COMPOSE=(docker compose -f compose.yaml)

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

DROP_VOLUMES=0
case "${1:-}" in
  --volumes|-v) DROP_VOLUMES=1 ;;
  '')           ;;
  *) die "usage: scripts/quickstart-stop.sh [--volumes]" ;;
esac

# ---- 0. preflight ------------------------------------------------------
# Deliberately NOT requiring .env: that file is what "installed" means to
# quickstart-update.sh, but a box you cannot stop because its config went
# missing is a trap, and the containers exist either way.
[ -f compose.yaml ] || die "compose.yaml not in $REPO_ROOT — run this from a grappa checkout."
command -v docker >/dev/null 2>&1 || die "docker not found."

# compose.yaml pins `container_name` on the long-lived services, so those
# names are global to the docker daemon and not scoped by project: from
# here, `down` would happily stop a box belonging to a different checkout
# of grappa. Ask the running container who owns it — the label is
# docker's own bookkeeping — and refuse if the answer is not us. Same
# guard as quickstart.sh / quickstart-update.sh, mirrored on purpose:
# three scripts that disagree about ownership would be worse than none.
running=0
for cname in $(sed -n 's/^[[:space:]]*container_name:[[:space:]]*//p' compose.yaml); do
  owner="$(docker inspect --format \
    '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
    "$cname" 2>/dev/null)" || continue        # not running: nothing to stop
  running=1
  if [ -n "$owner" ] && [ "$owner" != "$REPO_ROOT" ]; then
    warn "container '$cname' is up, but it belongs to another checkout:"
    warn "  $owner"
    die "run scripts/quickstart-stop.sh from $owner — stopping it from here would take down somebody else's box."
  fi
done

# ---- 1. down -----------------------------------------------------------
# Run even when nothing is up: a previous half-down (the profile bug this
# script exists for) can leave networks behind, and collecting them is
# free. Report the no-op rather than refusing it.
if [ "$running" -eq 0 ]; then
  say "No grappa containers are up — collecting whatever is left"
else
  say "Stopping the stack (prod profile: grappa + nginx)"
fi

down=("${COMPOSE[@]}" --profile prod down)
[ "$DROP_VOLUMES" -eq 1 ] && down+=(--volumes)
"${down[@]}"

# ---- 2. report ---------------------------------------------------------
if [ "$running" -eq 0 ]; then
  say "nothing was running 🫥"
else
  say "box is down 🛑"
fi

if [ "$DROP_VOLUMES" -eq 1 ]; then
  warn "named volumes dropped — the next start recompiles from scratch."
fi

cat <<EOF

  Start again:  scripts/quickstart-update.sh
  Data:         runtime/ is a bind mount in this checkout — untouched.
EOF
