#!/usr/bin/env bash
# orchestrate-resume-check — is there an active orchestrate session for
# this sibling pane already? Prints one of:
#   RESUMING age=<N>s   — yes, recent state file exists (last_emit < 600s ago)
#   STALE   age=<N>s    — state file exists but ≥600s old (orchestrator long gone)
#   FRESH               — no state file at all → first invocation
#
# Detection: presence + freshness of /tmp/orchestrate-state-<pane>.json,
# the per-tick state cache written by lib/wakeup-tick.sh. The orchestrator
# is event-loop-driven (ScheduleWakeup every 60s, one tick per wake), so
# there is no long-lived process to pgrep — the file IS the durable
# handoff between wake-ups and across orchestrator /clears.
#
# Usage: resume-check.sh <SIBLING_PANE_ID>   e.g. resume-check.sh %0

set -u
pane="${1:?usage: resume-check.sh <SIBLING_PANE_ID>}"

state_file="/tmp/orchestrate-state-${pane#%}.json"

if [ ! -f "$state_file" ]; then
  echo "FRESH"
  exit 0
fi

last_emit=""
while IFS='=' read -r k v; do
  [ "$k" = "last_emit" ] && last_emit="$v"
done < "$state_file"

if [ -z "$last_emit" ]; then
  echo "FRESH"
  exit 0
fi

now=$(date +%s)
age=$(( now - last_emit ))

# 600s = 10 minutes. The orchestrator wakes every 60s, so any active
# session refreshes the state file at least that often. A stale state
# file means a prior orchestrator session ended (/exit, crashed, user
# walked away) without cleanup — treat as FRESH so the new session
# rebases from current pane state.
if [ "$age" -ge 600 ]; then
  echo "STALE age=${age}s"
else
  echo "RESUMING age=${age}s"
fi
