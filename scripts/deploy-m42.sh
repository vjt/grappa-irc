#!/usr/bin/env bash
# Host-side one-command deploy to the m42 bastille jail.
#
# Wraps `ssh m42` + `sudo bastille cmd grappa <jail script>`; the jail-side
# scripts live in infra/freebsd/. Runnable from anywhere with ssh access to
# m42 (workstation, repo checkout, CI).
#
# The jail scripts `git pull --ff-only` from origin/main, so PUSH FIRST —
# this script does NOT push, it only refuses to run when local main is
# ahead of origin/main.
#
# Modes (mirror the Docker split — deploy.sh / deploy-cic.sh):
#   scripts/deploy-m42.sh                 server deploy, auto hot/cold
#                                         → infra/freebsd/deploy.sh
#   scripts/deploy-m42.sh --force-hot     server, force hot (passthrough)
#   scripts/deploy-m42.sh --force-cold    server, force cold (passthrough)
#   scripts/deploy-m42.sh --cic           cic-only bundle deploy, NO BEAM
#                                         restart → jail_deploy_cic.sh
#                                         (vite rebuild + refresh banner)
#   scripts/deploy-m42.sh --full-restart  cold deploy + a single host
#                                         `bastille restart`, for when a new
#                                         vhost / jail-layer network change
#                                         must take effect
#
# Overridable via env:
#   M42_HOST   ssh host alias            (default: m42)
#   JAIL       bastille jail name        (default: $BASTILLE_JAIL, from
#                                        infra/lib/bastille_jail.sh)
#   JAIL_REPO  repo path inside the jail (default: /home/grappa/grappa)
#   FULL_RESTART_HC_URL/RETRIES/SLEEP    --full-restart post-bounce
#                                        healthcheck (defaults below)
#
# Exit codes: 0 ok, 64 usage, non-zero on ssh / remote failure.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"

# The jail's NAME — the one fact this script and the in-jail deploy's restart
# hint MUST agree on, so both read it from here rather than each carrying a
# literal. Why a constant and not a derivation: infra/lib/bastille_jail.sh (#2022).
# shellcheck source=infra/lib/bastille_jail.sh
. "${SCRIPT_DIR}/../infra/lib/bastille_jail.sh"

M42_HOST="${M42_HOST:-m42}"
JAIL="${JAIL:-$BASTILLE_JAIL}"
JAIL_REPO="${JAIL_REPO:-/home/grappa/grappa}"

# --full-restart post-bounce healthcheck (30×2s, like deploy.sh). Each
# attempt also carries an ssh round-trip. Overridable for tests / slow jails.
FULL_RESTART_HC_URL="${FULL_RESTART_HC_URL:-http://127.0.0.1:4000/healthz}"
FULL_RESTART_HC_RETRIES="${FULL_RESTART_HC_RETRIES:-30}"
FULL_RESTART_HC_SLEEP="${FULL_RESTART_HC_SLEEP:-2}"

die() { echo "deploy-m42: $*" >&2; exit 1; }

# Pick the jail script + a human label from the mode flag.
full_restart=0
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
  --full-restart)
    jail_script="$JAIL_REPO/infra/freebsd/deploy.sh"
    label="server (full cold + host bastille-restart — binds new vhosts)"
    remote_args="--force-cold --defer-restart"
    full_restart=1
    ;;
  "")
    jail_script="$JAIL_REPO/infra/freebsd/deploy.sh"
    label="server (auto hot/cold)"
    remote_args=""
    ;;
  *)
    echo "usage: $0 [--cic|--force-hot|--force-cold|--full-restart]" >&2
    exit 64
    ;;
esac

# Push guard: the jail pulls origin/main, so local main must not be ahead.
# Offline is tolerated (warn, don't block — the push may be from elsewhere).
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

if [ "$full_restart" -eq 1 ]; then
  # One-bounce vhost bind: the jail stages the release + rc.d wrappers and
  # STOPS the BEAM (--defer-restart exits 0 without starting it), then a
  # single host `bastille restart` boots it and binds any new jail vhosts.
  # The completed-deploy marker is written by the HOST, below, only after
  # the post-bounce healthcheck passes.
  # Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
  echo "==> deploy-m42: staging release + rc.d wrappers (BEAM stops, NOT restarted)"
  # shellcheck disable=SC2029  # intentional client-side expansion of vars
  ssh "$M42_HOST" "sudo bastille cmd ${JAIL} ${jail_script} ${remote_args}"

  echo "==> deploy-m42: bastille restart ${JAIL} (single host bounce — boots staged release, binds new vhosts)"
  # shellcheck disable=SC2029  # intentional client-side expansion of vars
  ssh "$M42_HOST" "sudo bastille restart ${JAIL}"

  echo "==> deploy-m42: healthcheck (${FULL_RESTART_HC_URL}, ${FULL_RESTART_HC_RETRIES}×${FULL_RESTART_HC_SLEEP}s)"
  hc_ok=0
  i=0
  while [ "$i" -lt "$FULL_RESTART_HC_RETRIES" ]; do
    # shellcheck disable=SC2029  # intentional client-side expansion of vars
    if ssh "$M42_HOST" "sudo bastille cmd ${JAIL} curl -fsS -o /dev/null ${FULL_RESTART_HC_URL}"; then
      hc_ok=1
      break
    fi
    i=$((i + 1))
    sleep "$FULL_RESTART_HC_SLEEP"
  done
  if [ "$hc_ok" -ne 1 ]; then
    # "The healthcheck failed" and "production is DOWN" are different
    # emergencies, and this arm used to print one sentence for both (#1656 —
    # the v1.3.0 cold deploy exited on the healthcheck budget while the node
    # had already terminated). Same policy as the in-jail loop in
    # infra/lib/deploy_common.sh; the mechanism differs because this door only
    # reaches the jail over ssh, so it cannot share that hook.
    echo "deploy-m42: ERROR: healthcheck never returned 200 after $((FULL_RESTART_HC_RETRIES * FULL_RESTART_HC_SLEEP))s — marker NOT written" >&2

    # The probe above runs `curl -fsS`, and `-f` discards the body. /healthz
    # answers a non-200 with a body naming the failing check — ask once more
    # WITHOUT `-f` so that answer reaches the operator instead of /dev/null.
    echo "deploy-m42: last /healthz answer:" >&2
    # shellcheck disable=SC2029  # intentional client-side expansion of vars
    ssh "$M42_HOST" "sudo bastille cmd ${JAIL} curl -sS ${FULL_RESTART_HC_URL}" >&2 || true
    echo >&2

    # shellcheck disable=SC2029  # intentional client-side expansion of vars
    if ssh "$M42_HOST" "sudo bastille cmd ${JAIL} service grappa status" >/dev/null 2>&1; then
      die "the daemon is still RUNNING — up but not answering a healthy /healthz. The jail is serving; read the answer above before touching it, then fix and rerun"
    fi
    echo "deploy-m42: nothing was restarted — that is your call, not the deploy's." >&2
    die "the daemon is GONE — PRODUCTION IS DOWN. Bring it back with: ssh ${M42_HOST} sudo bastille cmd ${JAIL} service grappa start"
  fi

  # Write the marker INSIDE the jail (deploy.sh reads it as the
  # completed-deploy signal), from the jail's OWN HEAD — never a sha passed
  # down from the host, which a sibling push could have raced.
  echo "==> deploy-m42: healthcheck ok — recording runtime/last-deployed-sha (jail HEAD)"
  # shellcheck disable=SC2029  # intentional client-side expansion of vars
  ssh "$M42_HOST" "sudo bastille cmd ${JAIL} su -l grappa -c 'cd ${JAIL_REPO} && git rev-parse HEAD > runtime/last-deployed-sha'"

  echo "==> deploy-m42: done (${label})"
  exit 0
fi

# `bastille cmd` runs the jail script as root inside the jail. Quote the
# remote command so the flag (if any) reaches the jail script intact.
# shellcheck disable=SC2029  # intentional client-side expansion of vars
ssh "$M42_HOST" "sudo bastille cmd ${JAIL} ${jail_script} ${remote_args}"

echo "==> deploy-m42: done (${label})"
