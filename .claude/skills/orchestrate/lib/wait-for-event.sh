#!/usr/bin/env bash
# orchestrate-wait-for-event — block until the next NEW event in the
# daemon's append-only log, then exit. Stdout = the event line.
#
# Cursor-tracking: persists last-read byte offset in
# /tmp/orchestrate-cursor-<pane>. Each invocation resumes from where
# the previous one stopped, so events emitted while no waiter was
# armed (orchestrator forgot to re-arm, was clearing, etc.) are NOT
# lost — they're queued in the log and consumed on the next call.
#
# v2 design (was: one-shot polling re-arm chain): daemon does the
# polling. This script just tails the log. Many events may have
# accumulated since last call — emits ALL of them, one per line, then
# exits. Orchestrator should react to each.
#
# Boot semantics: if daemon isn't running, starts it before tailing.
#
# Usage: wait-for-event.sh <SIBLING_PANE_ID>   e.g. wait-for-event.sh %0

set -u
pane="${1:?usage: wait-for-event.sh <SIBLING_PANE_ID>}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
daemon="$script_dir/daemon.sh"
slug="${pane#%}"
log_file="/tmp/orchestrate-events-${slug}.log"
cursor_file="/tmp/orchestrate-cursor-${slug}"

# Ensure daemon is running.
if ! "$daemon" status "$pane" >/dev/null 2>&1; then
  "$daemon" start "$pane" >/dev/null
fi

# Ensure log file exists (daemon may not have written yet).
touch "$log_file"

# Read cursor (byte offset in log).
cursor=0
[ -f "$cursor_file" ] && cursor=$(cat "$cursor_file" 2>/dev/null || echo 0)
[ -z "$cursor" ] && cursor=0

# Wait for log size > cursor. Poll every 2s for snappy event delivery.
# (Daemon ticks every 20s, but multiple events may already be queued
# from prior daemon ticks — we'll consume them all immediately.)
while true; do
  size=$(wc -c < "$log_file" | tr -d ' ')
  if [ "$size" -gt "$cursor" ]; then
    # Read all bytes from cursor to end.
    new=$(tail -c +$((cursor + 1)) "$log_file")
    if [ -n "$new" ]; then
      echo "$new"
      echo "$size" > "$cursor_file"
      exit 0
    fi
  fi
  sleep 2
done
