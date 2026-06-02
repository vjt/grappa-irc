#!/usr/bin/env bash
# Host-side one-command deploy to the m42 bastille jail.
#
# Wraps the `ssh m42` + `sudo bastille cmd grappa <jail script>`
# incantation so the operator doesn't have to memorise it. The jail-side
# scripts live in infra/freebsd/ and are documented "invoke from m42
# host"; this is that host-side caller, runnable from anywhere with ssh
# access to m42 (workstation, this repo checkout, CI).
#
# The jail scripts `git pull --ff-only` from origin/main, so PUSH your
# commits to origin/main FIRST — this script does NOT push. As a guard it
# fetches origin and refuses to run if local main is ahead of origin/main
# (you'd otherwise deploy a stale tree and wonder why nothing changed).
#
# Modes (mirror the Docker split — deploy.sh / deploy-cic.sh):
#   scripts/deploy-m42.sh                 server deploy, auto hot/cold
#                                         → infra/freebsd/deploy.sh
#   scripts/deploy-m42.sh --force-hot     server, force hot (passthrough)
#   scripts/deploy-m42.sh --force-cold    server, force cold (passthrough)
#   scripts/deploy-m42.sh --cic           cic-only bundle deploy, NO BEAM
#                                         restart → jail_deploy_cic.sh
#                                         (vite rebuild + refresh banner)
#
# Overridable via env:
#   M42_HOST   ssh host alias            (default: m42)
#   JAIL       bastille jail name        (default: grappa)
#   JAIL_REPO  repo path inside the jail (default: /home/grappa/grappa)
#
# Exit codes: 0 ok, 64 usage, non-zero on ssh / remote failure.
set -euo pipefail

M42_HOST="${M42_HOST:-m42}"
JAIL="${JAIL:-grappa}"
JAIL_REPO="${JAIL_REPO:-/home/grappa/grappa}"

die() { echo "deploy-m42: $*" >&2; exit 1; }

# Pick the jail script + a human label from the mode flag.
case "${1:-}" in
  --cic)
    jail_script="$JAIL_REPO/infra/freebsd/jail_deploy_cic.sh"
    label="cic bundle (hot — no BEAM restart)"
    remote_args=""
    ;;
  --force-hot | --force-cold)
    jail_script="$JAIL_REPO/infra/freebsd/deploy.sh"
    label="server (${1#--force-})"
    remote_args="$1"
    ;;
  "")
    jail_script="$JAIL_REPO/infra/freebsd/deploy.sh"
    label="server (auto hot/cold)"
    remote_args=""
    ;;
  *)
    echo "usage: $0 [--cic|--force-hot|--force-cold]" >&2
    exit 64
    ;;
esac

# Push guard: the jail pulls origin/main, so local main must not be ahead.
# Fetch quietly; tolerate offline (warn, don't block — operator may have
# pushed from elsewhere).
if git rev-parse --git-dir >/dev/null 2>&1; then
  git fetch -q origin main 2>/dev/null || echo "deploy-m42: warning — could not fetch origin (offline?); skipping push check" >&2
  local_main="$(git rev-parse main 2>/dev/null || true)"
  origin_main="$(git rev-parse origin/main 2>/dev/null || true)"
  if [ -n "$local_main" ] && [ -n "$origin_main" ] && [ "$local_main" != "$origin_main" ]; then
    if git merge-base --is-ancestor "$origin_main" "$local_main" 2>/dev/null; then
      die "local main is AHEAD of origin/main — push first (the jail pulls origin): git push origin main"
    fi
  fi
fi

echo "==> deploy-m42: ${label}"
echo "    host=${M42_HOST} jail=${JAIL} script=${jail_script}"

# bastille cmd runs the jail script as root inside the jail. Quote the
# remote command so the flag (if any) reaches the jail script intact.
# shellcheck disable=SC2029  # intentional client-side expansion of vars
ssh "$M42_HOST" "sudo bastille cmd ${JAIL} ${jail_script} ${remote_args}"

echo "==> deploy-m42: done (${label})"
