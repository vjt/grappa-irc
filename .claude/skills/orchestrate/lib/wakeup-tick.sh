#!/usr/bin/env bash
# orchestrate-tick — one-shot pane sample. Detects sibling state and emits
# zero-or-more event lines to stdout. Designed to be called by daemon.sh
# every TICK_INTERVAL seconds, OR directly for one-shot probes (boot tick,
# debug).
#
# Event vocabulary (extended in v2 — was: BOOT/IDLE/BUSY/CTX-BUMP/HEARTBEAT/
# SAME/PANE-MISSING):
#   BOOT  state=<idle|busy|prompt|picker> ctx=<NN|TBD>%
#   IDLE  ctx=NN%               (busy → idle, no prompt/picker pending)
#   BUSY  ctx=NN%               (idle → busy)
#   PROMPT-PENDING ctx=NN%      (sibling on a permission/dialog prompt — DON'T act)
#   PROMPT-CLEARED ctx=NN%      (prompt resolved — sibling unblocked)
#   PICKER ctx=NN%              (sibling popped a design-Q picker — HALT)
#   PICKER-CLEARED ctx=NN%      (picker resolved)
#   USER-TYPED ctx=NN%          (vjt typed in pane directly — observe only)
#   CTX-BUMP NN% state=<...>    (entered new ≥10%-bucket at ≥30%)
#   CTX-CRITICAL NN% state=<...>(entered ≥80% — last-chance clear)
#   STALL state=<...> ctx=NN% duration=Ns  (same state ≥300s)
#   HEARTBEAT state=<...> ctx=NN%          (no event in ≥600s — down from 1800)
#   SAME state=<...> ctx=NN%    (no transition; daemon swallows, debug shows)
#   PANE-MISSING                (and exits)
#
# State file at /tmp/orchestrate-state-<pane>.json (key=value lines):
#   state                 — idle|busy|prompt|picker
#   ctx                   — NN or TBD
#   bucket                — NN (10s)
#   last_emit             — unix ts
#   last_state_change     — unix ts (for STALL detection)
#   last_user_typed_hash  — md5 of last user-typed line (for dedup)
#   prompt_active         — 0|1
#   picker_active         — 0|1
#
# Busy detector: spinner shape `… (` in last 15 OR explicit interrupt
# prompt (`Press up to edit` / `esc to interrupt`). Bare `…` is NOT busy.
# Idle debounce: 5s re-capture confirms idle (transient tool-call gaps).
#
# Prompt detector: `Do you want to proceed?` AND a `1. Yes` numbered list.
# Picker detector: `↑/↓ to navigate` OR `Tab/Arrow keys to navigate` OR
#   `Enter to select` lines.
#
# ctx parse: tries `🧠 NN%`, then `🧠 TBD` (clear-fresh), then nothing → TBD.

set -u
pane="${1:?usage: wakeup-tick.sh <SIBLING_PANE_ID>}"
state_file="/tmp/orchestrate-state-${pane#%}.json"
now=$(date +%s)

out=$(tmux capture-pane -t "$pane" -p 2>/dev/null)
if [ -z "$out" ]; then
  echo "PANE-MISSING"
  exit 0
fi

# Capture more lines than before — the status line + permission modal
# can push the spinner onto line 20+. Was: tail -15.
tail=$(echo "$out" | tail -30)

# --- Detect sub-state: prompt > picker > busy > idle ---
prompt_active=0
picker_active=0
state="idle"

if echo "$tail" | grep -qE 'Do you want to proceed\?' \
   && echo "$tail" | grep -qE '^[[:space:]]*[❯>]?[[:space:]]*1\.[[:space:]]+Yes'; then
  prompt_active=1
  state="prompt"
elif echo "$tail" | grep -qE '↑/↓ to navigate|Tab/Arrow keys to navigate|Enter to select'; then
  picker_active=1
  state="picker"
elif echo "$tail" | awk '/… \(/{f=1} END{exit !f}' \
     || echo "$tail" | grep -qE 'Press up to edit|esc to interrupt'; then
  state="busy"
else
  state="idle"
fi

# --- ctx parse with fallback ---
ctx=$(echo "$out" | grep -oE "🧠 [0-9]+%" | tail -1 | grep -oE "[0-9]+")
if [ -z "$ctx" ]; then
  if echo "$out" | grep -qE "🧠 TBD"; then
    ctx="TBD"
  else
    ctx="TBD"
  fi
fi
bucket=""
if [ "$ctx" != "TBD" ]; then
  bucket=$(( (ctx / 10) * 10 ))
fi

# --- Read prior state ---
prev_state=""
prev_bucket=""
prev_prompt=0
prev_picker=0
prev_user_hash=""
last_emit="$now"
last_state_change="$now"
if [ -f "$state_file" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      state)                prev_state="$v" ;;
      bucket)               prev_bucket="$v" ;;
      prompt_active)        prev_prompt="$v" ;;
      picker_active)        prev_picker="$v" ;;
      last_user_typed_hash) prev_user_hash="$v" ;;
      last_emit)            last_emit="$v" ;;
      last_state_change)    last_state_change="$v" ;;
    esac
  done < "$state_file"
fi

# --- Idle debounce (only on busy → idle) ---
if [ "$state" = "idle" ] && [ "$prev_state" = "busy" ]; then
  sleep 5
  out2=$(tmux capture-pane -t "$pane" -p 2>/dev/null)
  tail2=$(echo "$out2" | tail -30)
  if echo "$tail2" | grep -qE 'Do you want to proceed\?'; then
    state="prompt"
    prompt_active=1
  elif echo "$tail2" | grep -qE '↑/↓ to navigate|Tab/Arrow keys to navigate|Enter to select'; then
    state="picker"
    picker_active=1
  elif echo "$tail2" | awk '/… \(/{f=1} END{exit !f}' \
       || echo "$tail2" | grep -qE 'Press up to edit|esc to interrupt'; then
    state="busy"
  fi
fi

# --- USER-TYPED detection ---
# Find the last `❯ <text>` line that isn't part of the input prompt frame.
# The pane's empty input is rendered as `❯ ` (no trailing text). Anything
# else is either user input echo (recent submission) or a queued message.
last_user_line=$(echo "$out" | grep -E '^❯ .+' | tail -1 | sed 's/^❯ //')
user_hash=""
user_typed_event=""
if [ -n "$last_user_line" ]; then
  user_hash=$(echo -n "$last_user_line" | md5)
  if [ "$user_hash" != "$prev_user_hash" ] && [ -n "$prev_user_hash" ]; then
    user_typed_event="USER-TYPED ctx=${ctx}%"
  fi
fi

# --- Compute primary event ---
event=""
if [ -z "$prev_state" ]; then
  event="BOOT state=${state} ctx=${ctx}%"
elif [ "$state" != "$prev_state" ]; then
  case "$state" in
    idle)
      # Where did we come from?
      if [ "$prev_state" = "prompt" ]; then
        event="PROMPT-CLEARED ctx=${ctx}%"
      elif [ "$prev_state" = "picker" ]; then
        event="PICKER-CLEARED ctx=${ctx}%"
      else
        event="IDLE ctx=${ctx}%"
      fi
      ;;
    busy)
      event="BUSY ctx=${ctx}%"
      ;;
    prompt)
      event="PROMPT-PENDING ctx=${ctx}%"
      ;;
    picker)
      event="PICKER ctx=${ctx}%"
      ;;
  esac
fi

# --- ctx-bump events ---
ctx_event=""
if [ -n "$bucket" ] && [ "$bucket" -ge 30 ] && [ "$bucket" != "$prev_bucket" ]; then
  if [ "$bucket" -ge 80 ]; then
    ctx_event="CTX-CRITICAL ${ctx}% state=${state}"
  else
    ctx_event="CTX-BUMP ${ctx}% state=${state}"
  fi
fi

# --- Emit + update state-change tracking ---
emitted=0
if [ -n "$event" ]; then
  echo "$event"
  emitted=1
  last_emit="$now"
  last_state_change="$now"
fi
if [ -n "$ctx_event" ]; then
  echo "$ctx_event"
  emitted=1
  last_emit="$now"
fi
if [ -n "$user_typed_event" ]; then
  echo "$user_typed_event"
  emitted=1
  last_emit="$now"
fi

# --- STALL detection (same state ≥300s) ---
if [ "$emitted" = "0" ] && [ "$state" = "$prev_state" ]; then
  stall=$(( now - last_state_change ))
  if [ "$stall" -ge 300 ]; then
    # Only emit STALL once per 300s window — gate via last_emit.
    if [ $((now - last_emit)) -ge 300 ]; then
      echo "STALL state=${state} ctx=${ctx}% duration=${stall}s"
      emitted=1
      last_emit="$now"
    fi
  fi
fi

# --- Heartbeat (no event in ≥600s — was 1800) ---
if [ "$emitted" = "0" ]; then
  if [ $((now - last_emit)) -ge 600 ]; then
    echo "HEARTBEAT state=${state} ctx=${ctx}%"
    emitted=1
    last_emit="$now"
  else
    echo "SAME state=${state} ctx=${ctx}%"
  fi
fi

# --- Persist new state ---
{
  echo "state=${state}"
  echo "ctx=${ctx}"
  echo "bucket=${bucket}"
  echo "prompt_active=${prompt_active}"
  echo "picker_active=${picker_active}"
  echo "last_user_typed_hash=${user_hash}"
  echo "last_emit=${last_emit}"
  echo "last_state_change=${last_state_change}"
} > "$state_file"
