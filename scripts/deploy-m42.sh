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
#   scripts/deploy-m42.sh --full-restart  cold deploy that binds NEW jail
#                                         vhosts in ONE bounce: the jail
#                                         stages the release + rc.d wrappers
#                                         and STOPS the BEAM (deploy.sh
#                                         --force-cold --defer-restart), then
#                                         the host does a single
#                                         `bastille restart` to boot it. Use
#                                         when a new vhost / jail-layer
#                                         network change must take effect.
#
# EVERY path (server + --cic + --full-restart) also reinstalls the jail
# nginx config — the /admin/* proxy allowlist (infra/snippets/) + a
# graceful reload — from the freshly-pulled repo, so an allowlist change
# ships on the same deploy that ships the route. Nothing else refreshes
# it: not git pull, not a mix release, not even `bastille restart` (which
# only re-reads whatever is ALREADY on disk). See refresh_nginx below.
#
# Overridable via env:
#   M42_HOST   ssh host alias            (default: m42)
#   JAIL       bastille jail name        (default: grappa)
#   JAIL_REPO  repo path inside the jail (default: /home/grappa/grappa)
#   FULL_RESTART_HC_URL/RETRIES/SLEEP    --full-restart post-bounce
#                                        healthcheck (defaults below)
#
# Exit codes: 0 ok, 64 usage, non-zero on ssh / remote failure.
set -euo pipefail

M42_HOST="${M42_HOST:-m42}"
JAIL="${JAIL:-grappa}"
JAIL_REPO="${JAIL_REPO:-/home/grappa/grappa}"

# --full-restart post-bounce healthcheck. Mirrors deploy.sh's
# HEALTHCHECK_* feel (30×2s); the jail-internal curl runs over ssh so each
# attempt also carries an ssh round-trip. Overridable for tests / slow jails.
FULL_RESTART_HC_URL="${FULL_RESTART_HC_URL:-http://127.0.0.1:4000/healthz}"
FULL_RESTART_HC_RETRIES="${FULL_RESTART_HC_RETRIES:-30}"
FULL_RESTART_HC_SLEEP="${FULL_RESTART_HC_SLEEP:-2}"

die() { echo "deploy-m42: $*" >&2; exit 1; }

# Reinstall the jail nginx config (allowlist snippets + graceful reload)
# from the freshly-pulled repo. Runs AFTER the app deploy on every path:
# both deploy.sh and jail_deploy_cic.sh `git pull --ff-only` as their
# FIRST step, so the new infra/snippets/*.conf is already on disk in the
# jail by the time this runs. Delegates to the existing idempotent
# jail_install_nginx.sh — `install(1)` overwrites nginx.conf + snippets,
# `nginx -t` validates BEFORE a `service nginx reload` (SIGHUP; new
# workers pick up the config, in-flight connections drain — no jail
# disruption), and it `service nginx start`s if nginx wasn't running. A
# broken config fails `nginx -t` under `set -eu` and the OLD config keeps
# serving — reload never happens.
#
# Failure is SURFACED, never swallowed (CLAUDE.md no-silent-swallow): the
# app is already deployed + healthy here, so we do NOT pretend the whole
# deploy failed — but a stale allowlist is a real defect (new /admin/*
# routes 404 at nginx before reaching Phoenix), so we print a clear
# diagnostic and exit non-zero. The step is idempotent, so any later
# deploy-m42 run — even a nothing-to-do app deploy — retries it.
refresh_nginx() {
  echo "==> deploy-m42: refresh jail nginx config (allowlist snippets + graceful reload)"
  # shellcheck disable=SC2029  # intentional client-side expansion of vars
  if ssh "$M42_HOST" "sudo bastille cmd ${JAIL} ${JAIL_REPO}/infra/freebsd/jail_install_nginx.sh"; then
    return 0
  fi
  echo "deploy-m42: ERROR — app deploy SUCCEEDED but nginx config refresh FAILED" >&2
  echo "deploy-m42:   the /admin/* proxy allowlist may be STALE (new routes 404 at nginx before Phoenix)" >&2
  echo "deploy-m42:   fix: ssh ${M42_HOST} \"sudo bastille cmd ${JAIL} ${JAIL_REPO}/infra/freebsd/jail_install_nginx.sh\" and read the nginx -t output" >&2
  exit 1
}

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

if [ "$full_restart" -eq 1 ]; then
  # One-bounce vhost bind. The jail stages the release + rc.d wrappers and
  # STOPS the BEAM (deploy.sh --force-cold --defer-restart exits 0 without
  # starting it); then a single host `bastille restart` boots the staged
  # release through the new wrapper and binds any new jail vhosts. The
  # completed-deploy marker is written here, by the host, only AFTER the
  # post-bounce healthcheck passes — deploy.sh deliberately did not write it.
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
    die "healthcheck never returned 200 after $((FULL_RESTART_HC_RETRIES * FULL_RESTART_HC_SLEEP))s — jail may be unhealthy; marker NOT written, fix and rerun"
  fi

  # Write the marker INSIDE the jail (deploy.sh reads it as the
  # completed-deploy signal). Read the jail's own HEAD rather than passing a
  # sha from the host — a sibling push could have raced the host's view.
  echo "==> deploy-m42: healthcheck ok — recording runtime/last-deployed-sha (jail HEAD)"
  # shellcheck disable=SC2029  # intentional client-side expansion of vars
  ssh "$M42_HOST" "sudo bastille cmd ${JAIL} su -l grappa -c 'cd ${JAIL_REPO} && git rev-parse HEAD > runtime/last-deployed-sha'"

  refresh_nginx

  echo "==> deploy-m42: done (${label})"
  exit 0
fi

# bastille cmd runs the jail script as root inside the jail. Quote the
# remote command so the flag (if any) reaches the jail script intact.
# shellcheck disable=SC2029  # intentional client-side expansion of vars
ssh "$M42_HOST" "sudo bastille cmd ${JAIL} ${jail_script} ${remote_args}"

refresh_nginx

echo "==> deploy-m42: done (${label})"
