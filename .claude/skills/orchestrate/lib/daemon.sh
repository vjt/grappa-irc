#!/usr/bin/env bash
# orchestrate-daemon — long-running ticker for a sibling pane. Writes
# events to an append-only log so multiple consumers (wait-for-event.sh,
# state.sh, manual debug) can read the same stream.
#
# This replaces the brittle "single-shot wait-for-event re-arm" chain
# from v1: if the orchestrator forgets to re-arm or crashes mid-bucket,
# the daemon keeps ticking and queues events. When orchestrator next
# calls wait-for-event.sh, it picks up where it left off via cursor file.
#
# Single-instance per pane: pid file at /tmp/orchestrate-daemon-<pane>.pid.
# Stale pid is detected (kill -0) and replaced.
#
# Tick cadence: 5s (was 20s, was 60s) — aggressive on-change detection.
#
# Usage:
#   daemon.sh start <PANE>   — fork detached daemon (returns immediately)
#   daemon.sh stop  <PANE>   — kill daemon
#   daemon.sh status <PANE>  — running/not + last event
#   daemon.sh log <PANE>     — tail event log
#   daemon.sh _run <PANE>    — INTERNAL: the actual ticker loop body

set -u
cmd="${1:?usage: daemon.sh <start|stop|status|log> <PANE>}"
pane="${2:?usage: daemon.sh <start|stop|status|log> <PANE>}"

script_dir="$(cd "$(dirname "$0")" && pwd)"
self="$script_dir/$(basename "$0")"
tick="$script_dir/wakeup-tick.sh"
slug="${pane#%}"
pid_file="/tmp/orchestrate-daemon-${slug}.pid"
log_file="/tmp/orchestrate-events-${slug}.log"

is_running() {
  [ -f "$pid_file" ] || return 1
  local pid
  pid=$(cat "$pid_file" 2>/dev/null)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

pane_alive() {
  tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qx "$pane"
}

case "$cmd" in
  start)
    if is_running; then
      echo "daemon already running pid=$(cat "$pid_file")"
      exit 0
    fi
    if ! pane_alive; then
      echo "pane ${pane} not found"
      exit 1
    fi
    # Fork detached. macOS has no setsid; use nohup + & + disown.
    # Re-exec self in _run mode so the child is a clean process.
    nohup "$self" _run "$pane" </dev/null >/dev/null 2>&1 &
    child_pid=$!
    disown 2>/dev/null || true
    # Wait briefly for child to write pid file (it writes its own pid).
    for _ in 1 2 3 4 5; do
      sleep 0.3
      if [ -f "$pid_file" ] && is_running; then
        echo "daemon started pid=$(cat "$pid_file") log=$log_file"
        exit 0
      fi
    done
    echo "daemon failed to start (child pid was $child_pid)"
    exit 1
    ;;

  _run)
    # Internal: the actual ticker body. Writes own pid + loops.
    echo $$ > "$pid_file"
    trap 'rm -f "$pid_file"; exit 0' INT TERM EXIT
    miss_count=0
    while true; do
      if ! pane_alive; then
        miss_count=$((miss_count + 1))
        if [ "$miss_count" -ge 2 ]; then
          echo "PANE-MISSING" >> "$log_file"
          exit 0
        fi
      else
        miss_count=0
        # tick may emit multiple lines — append all, drop SAME noise.
        "$tick" "$pane" 2>/dev/null | grep -v '^SAME ' >> "$log_file" || true
      fi
      sleep 5
    done
    ;;

  stop)
    if is_running; then
      pid=$(cat "$pid_file")
      kill "$pid" 2>/dev/null
      pkill -P "$pid" 2>/dev/null || true
      rm -f "$pid_file"
      echo "daemon stopped pid=${pid}"
    else
      echo "daemon not running"
    fi
    ;;

  status)
    if is_running; then
      echo "running pid=$(cat "$pid_file") log=$log_file"
      [ -f "$log_file" ] && echo "last_event: $(tail -1 "$log_file")"
    else
      echo "not running"
      exit 1
    fi
    ;;

  log)
    [ -f "$log_file" ] && cat "$log_file" || echo "no log yet"
    ;;

  *)
    echo "unknown command: $cmd"
    echo "usage: daemon.sh <start|stop|status|log> <PANE>"
    exit 1
    ;;
esac
