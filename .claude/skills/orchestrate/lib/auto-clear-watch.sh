#!/usr/bin/env bash
# Auto-clear watchdog for the ORCHESTRATOR's own Claude pane.
#
# A turn-based Claude session can't self-poll (no background clock), so
# this EXTERNAL loop watches the orchestrator pane and, when its context
# crosses a threshold while idle + quiet, FIRST prompts the orchestrator
# to flush its handoff, WAITS for that flush turn to settle, and only
# THEN types `/clear` + `/orchestrate` so the orchestrator reloads from
# /srv/grappa/.orchestrate/orchestrator-resume.md (the persistent brain,
# durable path) + resume-checks the sibling daemon. The flush-before-clear
# step exists because the handoff is the ONLY thing that survives /clear —
# wiping with unsaved in-flight state (open decision, pending halt, a
# just-dispatched phase, a live waiter id) would lose it. Automates what
# vjt does manually.
#
# Resolves the target pane BY TITLE every tick (default "grappa-orch")
# — pane ids are ephemeral, the title is stable. Never hardcode %NN.
#
# Safeguards (all must hold to fire):
#   - ctx >= THRESHOLD (default 40%)
#   - pane is IDLE (no spinner "… (") — never clear mid-generation
#   - input line is empty (user not mid-typing) — back off if they are
#   - the above held for IDLE_TICKS_REQUIRED consecutive ticks (debounce)
# After firing, COOLDOWN seconds before it can fire again.
#
# Usage: auto-clear-watch.sh {start|stop|status} [TITLE]
set -u

CMD="${1:-start}"
TITLE="${2:-grappa-orch}"
THRESHOLD="${AUTOCLEAR_THRESHOLD:-40}"
TICK="${AUTOCLEAR_TICK:-15}"                       # seconds between checks
IDLE_TICKS_REQUIRED="${AUTOCLEAR_IDLE_TICKS:-2}"   # consecutive qualifying ticks (2*15=30s; is_busy already guards mid-turn)
COOLDOWN="${AUTOCLEAR_COOLDOWN:-90}"               # pause after a clear
FLUSH_MAX="${AUTOCLEAR_FLUSH_MAX:-180}"            # max secs to wait for the pre-clear handoff flush to settle

SLUG="$(printf '%s' "$TITLE" | tr -c 'a-zA-Z0-9' '-')"
PIDFILE="/tmp/orchestrate-autoclear-${SLUG}.pid"
LOGFILE="/tmp/orchestrate-autoclear-${SLUG}.log"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOGFILE"; }

resolve_pane() {
  # Match the pane whose title CONTAINS the target (the title carries a
  # varying activity-glyph prefix, so substring-match, not equality).
  tmux list-panes -a -F '#{pane_id} #{pane_title}' 2>/dev/null \
    | grep -F "$TITLE" | awk '{print $1}' | head -1
}

parse_ctx() { printf '%s' "$1" | grep -oE '🧠 [0-9]+%' | grep -oE '[0-9]+' | head -1; }
is_busy()   { printf '%s' "$1" | tail -15 | grep -qE '… \('; }            # spinner shape
input_pending() {
  printf '%s' "$1" | grep -E '^❯ ' | tail -1 | sed -E 's/^❯ +//' | grep -qE '[^[:space:]]'
}

run() {
  printf '%s' "$$" > "$PIDFILE"
  log "START title='$TITLE' threshold=${THRESHOLD}% tick=${TICK}s idle_req=${IDLE_TICKS_REQUIRED} cooldown=${COOLDOWN}s"
  local qualifying=0
  while true; do
    sleep "$TICK"
    local pane; pane="$(resolve_pane)"
    if [ -z "$pane" ]; then qualifying=0; continue; fi
    local cap; cap="$(tmux capture-pane -t "$pane" -p -S -25 2>/dev/null)"
    [ -z "$cap" ] && { qualifying=0; continue; }
    local ctx; ctx="$(parse_ctx "$cap")"; [ -z "$ctx" ] && ctx=-1

    if [ "$ctx" -lt "$THRESHOLD" ]; then qualifying=0; continue; fi
    if is_busy "$cap"; then qualifying=0; continue; fi
    if input_pending "$cap"; then log "ctx=${ctx}% idle but USER TYPING — back off"; qualifying=0; continue; fi

    qualifying=$((qualifying + 1))
    log "ctx=${ctx}% idle+quiet (${qualifying}/${IDLE_TICKS_REQUIRED})"
    if [ "$qualifying" -ge "$IDLE_TICKS_REQUIRED" ]; then
      log "FIRING on ${pane} (ctx=${ctx}%) — prompting handoff flush BEFORE clear"
      # 1. Prompt the orchestrator to flush its handoff FIRST. The
      #    handoff (/srv/grappa/.orchestrate/orchestrator-resume.md) is
      #    the ONLY thing that survives /clear — clearing with in-flight
      #    unsaved state (open decision, pending halt, just-dispatched
      #    phase, live waiter id) loses it. Give it a turn to persist.
      local msg="AUTO-CLEAR IMMINENT (ctx=${ctx}%): flush ALL in-flight state to the handoff /srv/grappa/.orchestrate/orchestrator-resume.md NOW — open decisions, pending halts, the dispatched/awaited phase, live waiter ids, anything not yet written — then go idle. I /clear you the moment you settle, so save first or lose it."
      tmux send-keys -t "$pane" C-u; sleep 1
      tmux send-keys -t "$pane" -l "$msg"; sleep 1
      tmux send-keys -t "$pane" Enter; sleep 1
      tmux send-keys -t "$pane" Enter                 # 2nd Enter — flush the submit
      # 2. WAIT for the flush turn to finish before wiping. Give it a
      #    beat to pick up the prompt (go busy), then poll until idle
      #    (no spinner), capped at FLUSH_MAX so a wedged flush can't hang
      #    the watchdog forever. Clearing mid-flush would be worse than
      #    not prompting at all, so this wait is the point of the fix.
      sleep 8
      local fwait=0
      while [ "$fwait" -lt "$FLUSH_MAX" ]; do
        local fcap; fcap="$(tmux capture-pane -t "$pane" -p -S -25 2>/dev/null)"
        is_busy "$fcap" || break
        sleep 5; fwait=$((fwait + 5))
      done
      log "handoff flush settled after ~${fwait}s (cap ${FLUSH_MAX}s) — clearing now"
      # 3. Now wipe + reload (the orchestrator re-reads the freshly
      #    flushed handoff on /orchestrate).
      tmux send-keys -t "$pane" C-u; sleep 1
      tmux send-keys -t "$pane" '/clear' Enter; sleep 4
      tmux send-keys -t "$pane" '/orchestrate' Enter; sleep 1
      tmux send-keys -t "$pane" Enter
      log "sent /clear + /orchestrate — cooldown ${COOLDOWN}s"
      qualifying=0
      sleep "$COOLDOWN"
    fi
  done
}

case "$CMD" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
      echo "already running pid=$(cat "$PIDFILE")"; exit 0
    fi
    nohup "$0" _run "$TITLE" >/dev/null 2>&1 &
    disown
    sleep 1
    echo "started auto-clear watch on title='$TITLE' pid=$(cat "$PIDFILE" 2>/dev/null) log=$LOGFILE"
    ;;
  _run) run ;;
  stop)
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null; rm -f "$PIDFILE"; echo "stopped"; else echo "not running"; fi
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
      echo "running pid=$(cat "$PIDFILE") log=$LOGFILE"; tail -4 "$LOGFILE" 2>/dev/null
    else echo "not running"; fi
    ;;
  *) echo "usage: $0 {start|stop|status} [TITLE]"; exit 64 ;;
esac
