#!/usr/bin/env bash
# orchestrate-state — query current sibling state without consuming
# events. Reads the daemon's state file directly. Useful when:
#   - orchestrator wakes via user message and wants ground truth
#   - debugging "is the sibling actually busy or did the detector lie?"
#   - resume-check wants more detail than just RESUMING/STALE/FRESH
#
# Output: one line per state field, key=value format.
#   state=<idle|busy|prompt|picker>
#   ctx=<NN|TBD>
#   bucket=<NN|empty>
#   prompt_active=<0|1>
#   picker_active=<0|1>
#   last_emit=<unix-ts>  (also: last_emit_age=<N>s)
#   last_state_change=<unix-ts>  (also: state_age=<N>s)
#   daemon=<running|stopped|missing>
#
# Usage: state.sh <SIBLING_PANE_ID>   e.g. state.sh %0

set -u
pane="${1:?usage: state.sh <SIBLING_PANE_ID>}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
daemon="$script_dir/daemon.sh"
slug="${pane#%}"
state_file="/tmp/orchestrate-state-${slug}.json"
pid_file="/tmp/orchestrate-daemon-${slug}.pid"

now=$(date +%s)

# Daemon status.
daemon_status="missing"
if [ -f "$pid_file" ]; then
  pid=$(cat "$pid_file" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    daemon_status="running"
  else
    daemon_status="stopped"
  fi
fi

# State file (might not exist if daemon never ran).
if [ ! -f "$state_file" ]; then
  echo "state=unknown"
  echo "ctx=TBD"
  echo "daemon=${daemon_status}"
  exit 0
fi

last_emit=""
last_state_change=""
while IFS='=' read -r k v; do
  case "$k" in
    last_emit)         last_emit="$v" ;;
    last_state_change) last_state_change="$v" ;;
  esac
  echo "${k}=${v}"
done < "$state_file"

[ -n "$last_emit" ]         && echo "last_emit_age=$((now - last_emit))s"
[ -n "$last_state_change" ] && echo "state_age=$((now - last_state_change))s"
echo "daemon=${daemon_status}"
