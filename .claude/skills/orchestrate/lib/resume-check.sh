#!/usr/bin/env bash
# orchestrate-resume-check — is there an active orchestrate session for
# this sibling pane already? Prints one of:
#   RESUMING age=<N>s daemon=running
#                       — yes, daemon up + state fresh
#   RESUMING age=<N>s daemon=stopped
#                       — state file fresh but daemon died — restart needed
#   STALE   age=<N>s    — state file ≥600s old (orchestrator long gone)
#   FRESH               — no state file at all → first invocation
#
# v2 (2026-05-15): added daemon liveness check. v1 only looked at file
# freshness; if daemon died but state file was recent, we'd return
# RESUMING and the orchestrator would wait forever for events that
# never come.
#
# Usage: resume-check.sh <SIBLING_PANE_ID>   e.g. resume-check.sh %0

set -u
pane="${1:?usage: resume-check.sh <SIBLING_PANE_ID>}"
slug="${pane#%}"
state_file="/tmp/orchestrate-state-${slug}.json"
pid_file="/tmp/orchestrate-daemon-${slug}.pid"

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

# 600s = 10 minutes. v2 cadence is 20s tick → fresh state file should be
# <30s old in practice; 600s gives generous slack for transient hiccups.
if [ "$age" -ge 600 ]; then
  echo "STALE age=${age}s"
  exit 0
fi

# Daemon liveness check.
daemon_status="stopped"
if [ -f "$pid_file" ]; then
  pid=$(cat "$pid_file" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    daemon_status="running"
  fi
fi

echo "RESUMING age=${age}s daemon=${daemon_status}"
