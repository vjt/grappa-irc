#!/usr/bin/env bash
# orchestrate-wait-for-event — block until the next interesting event from
# the sibling pane, then exit. Stdout = the event line.
#
# Designed to run via `Bash run_in_background: true`. The harness fires
# a task-completion notification when this script exits, giving the
# orchestrator a per-event wakeup without a polling cron.
#
# Internally just loops `wakeup-tick.sh` every 60s, ignoring SAME events.
# Exits 0 on the first BOOT / IDLE / BUSY / CTX-BUMP / HEARTBEAT /
# PANE-MISSING line.
#
# Usage: wait-for-event.sh <SIBLING_PANE_ID>   e.g. wait-for-event.sh %0

set -u
pane="${1:?usage: wait-for-event.sh <SIBLING_PANE_ID>}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
tick="$script_dir/wakeup-tick.sh"

while true; do
  event=$("$tick" "$pane")
  case "$event" in
    SAME*) sleep 60 ;;
    *)     echo "$event"; exit 0 ;;
  esac
done
