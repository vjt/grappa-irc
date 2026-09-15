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
# PANE BINDING — resolved ONCE at `start`, then PINNED (#1761)
#
# This used to re-grep the pane TITLE on every tick, on the reasoning that
# "pane ids are ephemeral, the title is stable". Half of that is true, and
# the wrong half was load-bearing: an id is unstable ACROSS sessions, a
# title is unstable WITHIN one. Claude Code renames its pane to the
# conversation's topic while the session runs, so the first topic change
# made the grep return empty — and the loop `continue`d with no log line,
# no error, a live pid and a `status` still reading `running`. Observed
# twice: once dead for two days, once bound to `%5`, an unrelated pane,
# which is worse than dead because it lies. Cost the first time: the
# orchestrator at 87% context with both workers idle ~13 hours.
#
# A watchdog lives inside ONE session, which is exactly the axis on which
# an id does not move. So the binding happens once and never again:
#
#   --pane %NN   explicit, wins over everything
#   $TMUX_PANE   when set AND naming a live pane
#   the TITLE    grepped ONCE, and only if it matches EXACTLY ONE pane
#
# Refusals are synchronous and non-zero — no pane, an ambiguous title, a
# `--pane` that does not exist: nothing is forked. A watch that cannot
# resolve must not become a process that reports `running`.
#
# LOG POSTURE: healthy-but-not-firing is quiet (ctx below threshold, pane
# busy — the watch is working, the conditions just aren't met). CANNOT-SEE
# is loud, and there are THREE such states, not one: the capture fails
# (pane gone), the capture is empty, or the pane renders no context
# marker at all. Each used to end in a bare `continue`.
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
# The pane is deliberately NOT re-resolved when it goes: re-resolving is
# how it bound `%5`.
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
#   auto-clear-watch.sh start  [TITLE] [--pane %NN]
#   auto-clear-watch.sh stop   [TITLE]
#   auto-clear-watch.sh status [TITLE]
set -u

CMD="${1:-start}"
[ $# -gt 0 ] && shift

TITLE=""
PANE_OPT=""
SOURCE_OPT=""
while [ $# -gt 0 ]; do
  case "$1" in
  --pane)
    [ $# -ge 2 ] || { echo "auto-clear-watch: --pane needs a pane id (%NN)" >&2; exit 64; }
    PANE_OPT="$2"; shift 2 ;;
  --pane=*) PANE_OPT="${1#--pane=}"; shift ;;
  # Internal: `start` tells the forked loop how the pane was bound, so
  # the log records it. Not part of the operator surface.
  --source)
    [ $# -ge 2 ] || { echo "auto-clear-watch: --source needs a value" >&2; exit 64; }
    SOURCE_OPT="$2"; shift 2 ;;
  -*) echo "auto-clear-watch: unknown option '$1'" >&2; exit 64 ;;
  *)
    [ -z "$TITLE" ] || { echo "auto-clear-watch: unexpected argument '$1'" >&2; exit 64; }
    TITLE="$1"; shift ;;
  esac
done
TITLE="${TITLE:-grappa-orch}"

THRESHOLD="${AUTOCLEAR_THRESHOLD:-40}"
TICK="${AUTOCLEAR_TICK:-15}"                       # seconds between checks
IDLE_TICKS_REQUIRED="${AUTOCLEAR_IDLE_TICKS:-2}"   # consecutive qualifying ticks (2*15=30s; is_busy already guards mid-turn)
COOLDOWN="${AUTOCLEAR_COOLDOWN:-90}"               # pause after a clear
FLUSH_MAX="${AUTOCLEAR_FLUSH_MAX:-180}"            # max secs to wait for the pre-clear handoff flush to settle
RESUME_IDLE="${AUTOCLEAR_RESUME_IDLE:-900}"        # secs of unbroken idle below THRESHOLD before a resume nudge
RESUME_COOLDOWN="${AUTOCLEAR_RESUME_COOLDOWN:-900}" # pause after a nudge (0 disables the branch entirely)

SLUG="$(printf '%s' "$TITLE" | tr -c 'a-zA-Z0-9' '-')"
PIDFILE="/tmp/orchestrate-autoclear-${SLUG}.pid"
LOGFILE="/tmp/orchestrate-autoclear-${SLUG}.log"
PANEFILE="/tmp/orchestrate-autoclear-${SLUG}.pane"   # what `status` reports (#1761)

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOGFILE"; }

pane_exists() {
  [ -n "${1:-}" ] || return 1
  # -x: `%1` must not be satisfied by `%12`.
  tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF "$1"
}

# Pane ids whose TITLE contains $TITLE. Matched against the title FIELD
# only — the id shares the line and must not be able to satisfy the match.
panes_matching_title() {
  tmux list-panes -a -F '#{pane_id} #{pane_title}' 2>/dev/null \
    | awk -v t="$TITLE" '{ title = substr($0, index($0, " ") + 1); if (index(title, t) > 0) print $1 }'
}

# Echoes "<pane_id> <source>" on success. Diagnostics go to stderr and a
# failure returns non-zero: the caller must NOT fork on one.
resolve_pane_once() {
  if [ -n "$PANE_OPT" ]; then
    if pane_exists "$PANE_OPT"; then
      printf '%s explicit\n' "$PANE_OPT"
      return 0
    fi
    printf "auto-clear-watch: --pane %s names no live pane — refusing to start.\n" "$PANE_OPT" >&2
    return 1
  fi

  if [ -n "${TMUX_PANE:-}" ]; then
    if pane_exists "$TMUX_PANE"; then
      printf '%s TMUX_PANE\n' "$TMUX_PANE"
      return 0
    fi
    printf "auto-clear-watch: \$TMUX_PANE=%s is set but names no live pane — falling through to the title.\n" \
      "$TMUX_PANE" >&2
  fi

  local matches count
  matches="$(panes_matching_title)"
  count="$(printf '%s\n' "$matches" | grep -c '[^[:space:]]')" || true

  if [ "$count" -eq 0 ]; then
    printf "auto-clear-watch: no tmux pane title contains '%s' — refusing to start a watch that can never resolve.\n" \
      "$TITLE" >&2
    printf "auto-clear-watch: pass --pane %%NN if the pane has been renamed (Claude Code renames it to the conversation topic).\n" >&2
    return 1
  fi

  if [ "$count" -gt 1 ]; then
    printf "auto-clear-watch: AMBIGUOUS — %s panes match title '%s': %s\n" \
      "$count" "$TITLE" "$(printf '%s' "$matches" | tr '\n' ' ')" >&2
    printf "auto-clear-watch: pass --pane %%NN to say which one. Refusing to guess.\n" >&2
    return 1
  fi

  printf '%s title\n' "$matches"
}

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

# The ONE classifier for "the watch cannot see", shared by the loop and by
# `status` so the two can never disagree about what blindness is. Takes a
# capture attempt (pane, tmux's exit code, the captured text) and echoes
# the reason, or NOTHING when the pane is readable.
blind_reason() {
  local pane="$1" rc="$2" cap="$3"
  if [ "$rc" -ne 0 ]; then
    printf 'pane %s is GONE (tmux rc=%s) — the pane no longer exists, or there is no tmux server. This id was bound once at start and is deliberately NOT re-resolved; stop and restart the watch.' \
      "$pane" "$rc"
    return 0
  fi
  if [ -z "$cap" ]; then
    printf 'pane %s captured EMPTY — nothing to read.' "$pane"
    return 0
  fi
  if [ -z "$(parse_ctx "$cap")" ]; then
    printf "pane %s renders no '🧠 NN%%' context marker — it may not be the Claude pane at all." "$pane"
    return 0
  fi
}

run() {
  local pane="$1" bound_by="$2"
  printf '%s' "$$" > "$PIDFILE"
  printf '%s' "$pane" > "$PANEFILE"
  log "START pane=${pane} (bound by ${bound_by}) title='$TITLE' threshold=${THRESHOLD}% tick=${TICK}s idle_req=${IDLE_TICKS_REQUIRED} cooldown=${COOLDOWN}s"
  local qualifying=0 idle_secs=0
  # The blind state the log last recorded. A transition — in, out, or
  # from one reason to another — is what gets a line; a tick that only
  # repeats the known state does not (see LOG POSTURE in the header).
  local blind_now=""
  while true; do
    sleep "$TICK"

    local cap rc=0 reason
    cap="$(tmux capture-pane -t "$pane" -p -S -25 2>/dev/null)" || rc=$?
    reason="$(blind_reason "$pane" "$rc" "$cap")"
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
    echo "already running pid=$(cat "$PIDFILE") pane=$(cat "$PANEFILE" 2>/dev/null || echo UNKNOWN)"
    exit 0
  fi
  # Resolve BEFORE forking, so an unresolvable watch is an exit code the
  # operator sees rather than a background process reporting `running`.
  binding="$(resolve_pane_once)" || exit 1
  pane="${binding%% *}"
  bound_by="${binding##* }"
  nohup "$0" _run "$TITLE" --pane "$pane" --source "$bound_by" >/dev/null 2>&1 &
  disown
  sleep 1
  echo "started auto-clear watch pane=${pane} (bound by ${bound_by}) title='$TITLE' pid=$(cat "$PIDFILE" 2>/dev/null) log=$LOGFILE"
  ;;
_run)
  [ -n "$PANE_OPT" ] || { echo "auto-clear-watch: _run is internal and requires --pane" >&2; exit 64; }
  run "$PANE_OPT" "${SOURCE_OPT:-unknown}"
  ;;
stop)
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null
    rm -f "$PIDFILE" "$PANEFILE"
    echo "stopped"
  else echo "not running"; fi
  ;;
status)
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    # WHICH pane, always — a bare `running` is what let a watch bound
    # to `%5` look healthy for as long as it did (#1761).
    watched="$(cat "$PANEFILE" 2>/dev/null || true)"
    if [ -z "$watched" ]; then
      echo "running pid=$(cat "$PIDFILE") pane=UNKNOWN — no pane file, so this was started by a pre-#1761 build; stop and restart it. log=$LOGFILE"
    else
      # DERIVED, not remembered: run the loop's own observation right
      # now. A `running` that never looked is how the %5 misbinding
      # survived, and a status reading a state file would be one more
      # thing that can go stale.
      scap=""; srr=0
      scap="$(tmux capture-pane -t "$watched" -p -S -25 2>/dev/null)" || srr=$?
      sreason="$(blind_reason "$watched" "$srr" "$scap")"
      if [ -n "$sreason" ]; then
        echo "running pid=$(cat "$PIDFILE") pane=${watched} BLIND: ${sreason} log=$LOGFILE"
      else
        echo "running pid=$(cat "$PIDFILE") pane=${watched} watching (ctx=$(parse_ctx "$scap")%) log=$LOGFILE"
      fi
    fi
    tail -4 "$LOGFILE" 2>/dev/null
  else echo "not running"; fi
  ;;
*) echo "usage: $0 {start|stop|status} [TITLE] [--pane %NN]"; exit 64 ;;
esac
