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
# PANE BINDING — looked up by ROLE on every tick (2026-11-28)
#
# The pane is the one whose tmux user option `@role` equals the ROLE
# argument (default `grappa-orch`). The orchestrator sets it on its OWN
# pane as part of `/orchestrate` step 0:
#
#   tmux set -p -t "$TMUX_PANE" @role grappa-orch
#
# Two bindings came before this one and each failed on one axis:
#
#   - the TITLE, re-grepped every tick: Claude Code renames its pane to the
#     conversation topic, so the grep went empty and the loop `continue`d
#     silently — dead for two days, once bound to an unrelated `%5` (#1761);
#   - the pane ID, resolved once and PINNED (#1761's cure): an id is stable
#     inside one tmux server and reused by the next. The Pi's tmux restarted
#     at 17:05Z 2026-11-27, `%6` came back as a different Claude session
#     (siem triage), and the watch typed two RESUME TICKs into it.
#
# `@role` holds on both axes: Claude Code rewrites `pane_title` and never a
# user option, and a tmux restart takes the option away WITH the pane, so
# the failure becomes "no pane carries the role" — BLIND, nothing typed —
# instead of "a stranger's pane carries the old id". Zero or several panes
# carrying it is BLIND too; the watch never picks one.
#
# LOG POSTURE: healthy-but-not-firing is quiet (ctx below threshold, pane
# busy — the watch is working, the conditions just aren't met). CANNOT-SEE
# is loud, and there are FIVE such states, not one: no pane carries the
# role, several do, the capture fails (pane gone), the capture is empty,
# or the pane renders no context marker at all. `observe` names each.
#
# "Loud every time" is implemented as TRANSITION + DERIVED STATUS, not as
# one identical line per tick. A line every 15s is not more visible than
# a line every hour — it is less, because it buries the transition and
# the operator learns to skip the file. So: the log records ENTERING a
# blind state and RECOVERING from it (a change of reason is a transition
# too), which keeps `tail -4` truthful in both directions; and `status`
# re-runs the very same observation LIVE, so the answer to "is it
# actually watching" is measured on demand rather than remembered. No
# state file: the blindness is derived from the pane, never duplicated.
#
# Safeguards (all must hold to fire):
#   - ctx >= THRESHOLD (default 40%)
#   - pane is IDLE (no spinner "… (") — never clear mid-generation
#   - input line is empty (user not mid-typing) — back off if they are
#   - the above held for IDLE_TICKS_REQUIRED consecutive ticks (debounce)
# After firing, COOLDOWN seconds before it can fire again.
#
# RESUME TICK (vjt's go, 2026-08-25 20:44 #grappa). The clear branch above
# only fires at ctx >= THRESHOLD, and an orchestrator that is DOING NOTHING
# burns no context — so a stalled orch sits below the threshold forever and
# nothing re-invokes it. Measured on 2026-08-25: two holes, ~7h of workers
# idle while the orch pane was quiet at low ctx. This second branch nudges
# the pane back into a turn once it has been idle for RESUME_IDLE seconds
# WITHOUT clearing anything: same idle/typing safeguards, plus a dialog guard
# (typing into an open permission modal would answer it at random).
#
# Usage:
#   auto-clear-watch.sh start  [ROLE]
#   auto-clear-watch.sh stop   [ROLE]
#   auto-clear-watch.sh status [ROLE]
set -u

CMD="${1:-start}"
[ $# -gt 0 ] && shift

ROLE=""
while [ $# -gt 0 ]; do
  case "$1" in
  -*) echo "auto-clear-watch: unknown option '$1'" >&2; exit 64 ;;
  *)
    [ -z "$ROLE" ] || { echo "auto-clear-watch: unexpected argument '$1'" >&2; exit 64; }
    ROLE="$1"; shift ;;
  esac
done
ROLE="${ROLE:-grappa-orch}"

THRESHOLD="${AUTOCLEAR_THRESHOLD:-40}"
TICK="${AUTOCLEAR_TICK:-15}"                       # seconds between checks
IDLE_TICKS_REQUIRED="${AUTOCLEAR_IDLE_TICKS:-2}"   # consecutive qualifying ticks (2*15=30s; is_busy already guards mid-turn)
COOLDOWN="${AUTOCLEAR_COOLDOWN:-90}"               # pause after a clear
FLUSH_MAX="${AUTOCLEAR_FLUSH_MAX:-180}"            # max secs to wait for the pre-clear handoff flush to settle
RESUME_IDLE="${AUTOCLEAR_RESUME_IDLE:-900}"        # secs of unbroken idle below THRESHOLD before a resume nudge
RESUME_COOLDOWN="${AUTOCLEAR_RESUME_COOLDOWN:-900}" # pause after a nudge (0 disables the branch entirely)

SLUG="$(printf '%s' "$ROLE" | tr -c 'a-zA-Z0-9' '-')"
PIDFILE="/tmp/orchestrate-autoclear-${SLUG}.pid"
LOGFILE="/tmp/orchestrate-autoclear-${SLUG}.log"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOGFILE"; }

# The LAST marker in the capture, never the first (issue 2214). A pane's
# own status block is the live bottom of the screen; anything else that
# bears a marker is scrollback ABOVE it. The orchestrator pane samples its
# workers by capturing THEIR panes, so their status lines sit in its buffer
# as ordinary command output — and `head -1` took the oldest of them.
# Measured 2026-09-15: `status` reported 7% while the pane itself read 39%,
# one point under its own firing threshold. Reading LOW is the direction
# that costs: the watch never fires, and a watchdog that is alive, bound
# and silent is indistinguishable from a calm session.
#
# Anchored by POSITION and not by the glyphs around the block (📟 / ⏵⏵):
# a glyph this parse requires and the pane does not render would turn the
# watch permanently BLIND — a worse failure, bought to defend against a
# capture in which the live block is missing while a foreign marker is not.
parse_ctx() { printf '%s' "$1" | grep -oE '🧠 [0-9]+%' | grep -oE '[0-9]+' | tail -1; }
is_busy()   { printf '%s' "$1" | tail -15 | grep -qE '… \('; }            # spinner shape
input_pending() {
  printf '%s' "$1" | grep -E '^❯ ' | tail -1 | sed -E 's/^❯ +//' | grep -qE '[^[:space:]]'
}
# A permission modal / picker is up. is_busy() does NOT see these (no spinner),
# so without this guard the resume nudge would type into an open dialog and
# answer it at random. `1. Yes` is the invariant of the modal, not the wording
# of the question — same reasoning as wakeup-tick.sh's prompt detector.
dialog_pending() {
  printf '%s' "$1" | grep -qE '^[[:space:]│]*(1\.|❯ 1\.) Yes|↑/↓ to navigate|Enter to select'
}

# The ONE observation, shared by the loop and by `status` so the two can
# never disagree about what blindness is. Looks the pane up by role, then
# reads it. Sets OBS_PANE (the id, or empty), OBS_CAP (the capture) and
# OBS_REASON (why it cannot see; EMPTY when the pane is readable).
observe() {
  OBS_PANE=""; OBS_CAP=""; OBS_REASON=""
  local matches count rc=0
  matches="$(tmux list-panes -a -F '#{pane_id} #{@role}' 2>/dev/null \
    | awk -v r="$ROLE" '{ id = $1; sub(/^[^ ]+ ?/, ""); if ($0 == r) print id }')"
  count="$(printf '%s' "$matches" | grep -c .)" || true
  if [ "$count" -eq 0 ]; then
    OBS_REASON="no pane carries @role=${ROLE} (tmux restarted, or the orchestrator has not run /orchestrate step 0 yet). From the orchestrator pane: tmux set -p -t \"\$TMUX_PANE\" @role ${ROLE}"
    return
  fi
  if [ "$count" -gt 1 ]; then
    OBS_REASON="AMBIGUOUS: ${count} panes carry @role=${ROLE}: $(printf '%s' "$matches" | tr '\n' ' ')— refusing to guess; unset it on all but one (tmux set -p -u -t %NN @role)."
    return
  fi
  OBS_PANE="$matches"
  OBS_CAP="$(tmux capture-pane -t "$OBS_PANE" -p -S -25 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    OBS_REASON="pane ${OBS_PANE} is GONE (tmux rc=${rc})."
  elif [ -z "$OBS_CAP" ]; then
    OBS_REASON="pane ${OBS_PANE} captured EMPTY — nothing to read."
  elif [ -z "$(parse_ctx "$OBS_CAP")" ]; then
    OBS_REASON="pane ${OBS_PANE} renders no '🧠 NN%' context marker — it may not be the Claude pane at all."
  fi
}

run() {
  printf '%s' "$$" > "$PIDFILE"
  log "START role='$ROLE' threshold=${THRESHOLD}% tick=${TICK}s idle_req=${IDLE_TICKS_REQUIRED} cooldown=${COOLDOWN}s"
  local qualifying=0 idle_secs=0
  # The pane the log last said it was reading: a change of binding is a
  # transition too, and the log is where the operator checks it.
  local bound_now=""
  # The blind state the log last recorded. A transition — in, out, or
  # from one reason to another — is what gets a line; a tick that only
  # repeats the known state does not (see LOG POSTURE in the header).
  local blind_now=""
  while true; do
    sleep "$TICK"

    observe
    local pane="$OBS_PANE" cap="$OBS_CAP" reason="$OBS_REASON"
    if [ -n "$pane" ] && [ "$pane" != "$bound_now" ]; then
      log "BOUND to pane ${pane} (@role=${ROLE})${bound_now:+, was ${bound_now}}"
      bound_now="$pane"
      # Idle time is a fact about ONE pane: carrying it over would nudge a
      # pane the watch has just met.
      qualifying=0; idle_secs=0
    fi
    if [ -n "$reason" ]; then
      if [ "$reason" != "$blind_now" ]; then
        blind_now="$reason"
        log "BLIND: $reason"
      fi
      # A blind tick is not an idle tick: we did not observe an idle pane,
      # we observed nothing. Nudging on unread time is how a watchdog types
      # into a pane it cannot see.
      qualifying=0; idle_secs=0; continue
    fi
    if [ -n "$blind_now" ]; then
      log "RECOVERED: reading pane ${pane} again (was BLIND: ${blind_now})"
      blind_now=""
    fi
    local ctx; ctx="$(parse_ctx "$cap")"

    # --- RESUME TICK: idle below the clear threshold ---------------------
    # Anything that means "not sitting there doing nothing" resets the timer:
    # a live turn, a modal waiting on a human, vjt mid-typing.
    if is_busy "$cap" || dialog_pending "$cap" || input_pending "$cap"; then
      idle_secs=0
    else
      idle_secs=$((idle_secs + TICK))
      if [ "$RESUME_COOLDOWN" -gt 0 ] && [ "$idle_secs" -ge "$RESUME_IDLE" ]; then
        log "RESUME NUDGE on ${pane} (ctx=${ctx}%, idle ${idle_secs}s) — re-invoking, NOT clearing"
        local nudge="RESUME TICK: you have been idle ${idle_secs}s. Re-read the handoff at /srv/grappa/.orchestrate/orchestrator-resume.md, run a board check and a wakeup tick on the workers, and dispatch whatever is ready. If there is genuinely nothing to do, say so in ONE line and go idle — this is an automatic heartbeat, not a human asking."
        tmux send-keys -t "$pane" C-u; sleep 1
        tmux send-keys -t "$pane" -l "$nudge"; sleep 1
        tmux send-keys -t "$pane" Enter; sleep 1
        tmux send-keys -t "$pane" Enter               # 2nd Enter — flush the submit
        idle_secs=0
        sleep "$RESUME_COOLDOWN"
        continue
      fi
    fi

    # Healthy but not firing: quiet on purpose.
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
      # Text and Enter NEVER in the same send-keys: measured 2026-08-25, the
      # combined form leaves the line sitting un-submitted in the prompt.
      tmux send-keys -t "$pane" C-u; sleep 1
      tmux send-keys -t "$pane" -l '/clear'; sleep 1
      tmux send-keys -t "$pane" Enter; sleep 4
      tmux send-keys -t "$pane" -l '/orchestrate'; sleep 1
      tmux send-keys -t "$pane" Enter; sleep 1
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
    echo "already running pid=$(cat "$PIDFILE")"
    exit 0
  fi
  nohup "$0" _run "$ROLE" >/dev/null 2>&1 &
  disown
  sleep 1
  # Say what it sees NOW. Starting with no pane carrying the role is legal
  # (systemd starts it at boot, before the orchestrator exists) — but it is
  # said, not implied.
  observe
  if [ -n "$OBS_REASON" ]; then
    echo "started auto-clear watch role='$ROLE' pid=$(cat "$PIDFILE" 2>/dev/null) BLIND: ${OBS_REASON} log=$LOGFILE"
  else
    echo "started auto-clear watch role='$ROLE' pane=${OBS_PANE} pid=$(cat "$PIDFILE" 2>/dev/null) log=$LOGFILE"
  fi
  ;;
_run)
  run
  ;;
stop)
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null
    rm -f "$PIDFILE"
    echo "stopped"
  else echo "not running"; fi
  ;;
status)
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    # DERIVED, not remembered: the loop's own observation, run right now.
    observe
    if [ -n "$OBS_REASON" ]; then
      echo "running pid=$(cat "$PIDFILE") role='$ROLE' BLIND: ${OBS_REASON} log=$LOGFILE"
    else
      echo "running pid=$(cat "$PIDFILE") role='$ROLE' pane=${OBS_PANE} watching (ctx=$(parse_ctx "$OBS_CAP")%) log=$LOGFILE"
    fi
    tail -4 "$LOGFILE" 2>/dev/null
  else echo "not running"; fi
  ;;
*) echo "usage: $0 {start|stop|status} [ROLE]"; exit 64 ;;
esac
