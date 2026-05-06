#!/usr/bin/env bash
# orchestrate-tick — one-shot pane sample, called once per orchestrator
# wake-up (cadence is the orchestrator's ScheduleWakeup interval — typically
# 60s). Prints exactly one event line to stdout:
#   BOOT state=<idle|busy> ctx=NN%
#   IDLE ctx=NN%             (busy → idle)
#   BUSY ctx=NN%             (idle → busy)
#   CTX-BUMP NN% state=<...> (every new 10%-bucket, ≥30%)
#   HEARTBEAT state=<...>    (no event in ≥1800s)
#   SAME state=<...> ctx=NN% (no transition; orchestrator may ignore)
#   PANE-MISSING             (and exits)
#
# Persists rolling state in /tmp/orchestrate-state-<sanitized-pane>.json so
# subsequent ticks can detect transitions across orchestrator wake-ups.
#
# Busy detector mirrors the previous polling-loop semantics: a line in the
# last 15 carries `… (` (the spinner shape: ellipsis + space + open-paren
# that introduces the parenthesized status — `(NNs · ...)` once the timer
# arms, `(thinking)` / `(almost done ...)` in the pre-timer phase) — OR an
# explicit interrupt prompt (`Press up to edit` / `esc to interrupt`).
#
# Bare `…` (truncated task descriptions like `tok…`, list-compaction
# `… +N completed`) is treated as IDLE — kills the spurious-busy events
# from the earlier loose detector.
#
# Idle debounce: a single idle read after a busy read can be a transient
# tool-call gap (between Read/Bash result rendering and the next spinner
# line appearing). One 5s re-capture confirms before classifying as IDLE.
#
# Usage: wakeup-tick.sh <SIBLING_PANE_ID>   e.g. wakeup-tick.sh %0

set -u
pane="${1:?usage: wakeup-tick.sh <SIBLING_PANE_ID>}"

# Sanitize pane id for filename (% is fine on most filesystems but easier
# without): %0 → 0, %119 → 119.
state_file="/tmp/orchestrate-state-${pane#%}.json"

now=$(date +%s)

out=$(tmux capture-pane -t "$pane" -p 2>/dev/null)
if [ -z "$out" ]; then
  echo "PANE-MISSING"
  exit 0
fi

tail=$(echo "$out" | tail -15)
if echo "$tail" | awk '/… \(/{f=1} END{exit !f}' \
   || echo "$tail" | grep -qE 'Press up to edit|esc to interrupt'; then
  state="busy"
else
  state="idle"
fi

# Read previous tick's state (default: empty — first invocation = BOOT).
prev_state=""
prev_bucket=""
last_emit="$now"
if [ -f "$state_file" ]; then
  # Tiny ad-hoc parser: file is `key=value` lines (no real JSON dep needed).
  while IFS='=' read -r k v; do
    case "$k" in
      state)     prev_state="$v" ;;
      bucket)    prev_bucket="$v" ;;
      last_emit) last_emit="$v" ;;
    esac
  done < "$state_file"
fi

# Idle debounce — only when we have a prior busy state to flip from.
if [ "$state" = "idle" ] && [ "$prev_state" = "busy" ]; then
  sleep 5
  out2=$(tmux capture-pane -t "$pane" -p 2>/dev/null)
  tail2=$(echo "$out2" | tail -15)
  if echo "$tail2" | awk '/… \(/{f=1} END{exit !f}' \
     || echo "$tail2" | grep -qE 'Press up to edit|esc to interrupt'; then
    state="busy"
  fi
fi

ctx=$(echo "$out" | grep -oE "🧠 [0-9]+%" | tail -1 | grep -oE "[0-9]+")
bucket=""
[ -n "$ctx" ] && bucket=$(( (ctx / 10) * 10 ))

event=""
if [ -z "$prev_state" ]; then
  event="BOOT state=${state} ctx=${ctx}%"
elif [ "$state" = "idle" ] && [ "$prev_state" = "busy" ]; then
  event="IDLE ctx=${ctx}%"
elif [ "$state" = "busy" ] && [ "$prev_state" = "idle" ]; then
  event="BUSY ctx=${ctx}%"
fi

ctx_event=""
if [ -n "$ctx" ] && [ -n "$bucket" ] && [ "$bucket" -ge 30 ] && [ "$bucket" != "$prev_bucket" ]; then
  ctx_event="CTX-BUMP ${ctx}% state=${state}"
fi

if [ -n "$event" ]; then
  echo "$event"
  last_emit="$now"
fi
if [ -n "$ctx_event" ]; then
  echo "$ctx_event"
  last_emit="$now"
fi

if [ -z "$event" ] && [ -z "$ctx_event" ]; then
  if [ $((now - last_emit)) -ge 1800 ]; then
    echo "HEARTBEAT state=${state} ctx=${ctx}%"
    last_emit="$now"
  else
    echo "SAME state=${state} ctx=${ctx}%"
  fi
fi

# Persist new state.
{
  echo "state=${state}"
  echo "bucket=${bucket}"
  echo "last_emit=${last_emit}"
} > "$state_file"
