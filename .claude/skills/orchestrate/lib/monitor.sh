#!/usr/bin/env bash
# orchestrate-monitor — polling loop watching a sibling Claude Code tmux pane.
#
# Emits one stdout line per state-change event (the Monitor tool delivers each
# line to the orchestrator as a notification):
#   BOOT state=<idle|busy> ctx=NN%
#   IDLE ctx=NN%             (busy → idle)
#   BUSY ctx=NN%             (idle → busy)
#   CTX-BUMP NN% state=<...> (every new 10%-bucket, ≥30%)
#   HEARTBEAT state=<...>    (every 1800s if no other event)
#   PANE-MISSING             (and exits — pane is gone)
#
# Busy detector: a line in the last 15 carries `…` AND a spinner timer
# `(NNs` / `(Nm Ms` / `(Nh Mm Ss` (active spinner), OR an explicit
# interrupt prompt (`Press up to edit` / `esc to interrupt`). Bare `…`
# (truncated task descriptions like `tok…`, list-compaction
# `… +N completed`) is treated as IDLE — it tripped the old detector
# for ~30 minutes during CP10 S6 and produced confusing HEARTBEAT-busy
# events. `h` was added to the timer-unit alternation after a Task 4
# sibling spun for >1h and emitted `(1h 0m 30s`, which the old `[ms]`
# class missed → false IDLE during long generations.
#
# Usage: monitor.sh <SIBLING_PANE_ID>   e.g. monitor.sh %119
#
# Run via the Monitor tool with persistent: true, timeout_ms: 3600000.
# A stable cmdline (this script's path + the pane id) lets `pgrep -f`
# detect a surviving monitor across the orchestrator's /clear — see
# resume-check.sh.

set -u
pane="${1:?usage: monitor.sh <SIBLING_PANE_ID>}"

prev_state=""
prev_bucket=""
last_emit=0

while true; do
  out=$(tmux capture-pane -t "$pane" -p 2>/dev/null)
  [ -z "$out" ] && { echo "PANE-MISSING"; break; }

  tail=$(echo "$out" | tail -15)
  if echo "$tail" | awk '/…/ && /\([0-9]+[hms]/{f=1} END{exit !f}' \
     || echo "$tail" | grep -qE 'Press up to edit|esc to interrupt'; then
    state="busy"
  else
    state="idle"
  fi

  ctx=$(echo "$out" | grep -oE "🧠 [0-9]+%" | tail -1 | grep -oE "[0-9]+")
  bucket=""
  [ -n "$ctx" ] && bucket=$(( (ctx / 10) * 10 ))

  now=$(date +%s)
  if [ "$prev_state" = "" ]; then
    echo "BOOT state=${state} ctx=${ctx}%"
    last_emit=$now
  elif [ "$state" = "idle" ] && [ "$prev_state" = "busy" ]; then
    echo "IDLE ctx=${ctx}%"
    last_emit=$now
  elif [ "$state" = "busy" ] && [ "$prev_state" = "idle" ]; then
    echo "BUSY ctx=${ctx}%"
    last_emit=$now
  fi

  if [ -n "$ctx" ] && [ -n "$bucket" ] && [ "$bucket" -ge 30 ] && [ "$bucket" != "$prev_bucket" ]; then
    echo "CTX-BUMP ${ctx}% state=${state}"
    prev_bucket="$bucket"
    last_emit=$now
  fi

  if [ $((now - last_emit)) -ge 1800 ]; then
    echo "HEARTBEAT state=${state} ctx=${ctx}%"
    last_emit=$now
  fi

  prev_state="$state"
  sleep 60
done
