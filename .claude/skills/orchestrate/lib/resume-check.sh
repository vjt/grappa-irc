#!/usr/bin/env bash
# orchestrate-resume-check — does an orchestrate monitor already watch this
# sibling pane? Prints one of:
#   RESUMING pid=<NNN>   — yes, monitor running with PID <NNN>
#   FRESH                — no monitor → caller arms one via Step 2 of SKILL.md
#
# Detection: pgrep -f for `monitor.sh <SIBLING_PANE_ID>`. Because the Monitor
# tool starts the script directly via the persistent Bash invocation, the
# script's path + the pane-id arg are both literal in /proc/<pid>/cmdline,
# making detection trivial regardless of TaskList's blind spot for
# /clear-surviving Monitors.
#
# Usage: resume-check.sh <SIBLING_PANE_ID>   e.g. resume-check.sh %119

set -u
pane="${1:?usage: resume-check.sh <SIBLING_PANE_ID>}"

# Match the canonical invocation. The pane id (`%119`) is a unique signature
# per orchestrator/sibling pair so two unrelated orchestrate sessions on the
# same host don't confuse each other.
script_path="$(cd "$(dirname "$0")" && pwd)/monitor.sh"
pid=$(pgrep -fx "bash $script_path $pane" 2>/dev/null \
   || pgrep -f "$script_path $pane" 2>/dev/null \
   | head -1)

if [ -n "$pid" ]; then
  echo "RESUMING pid=$pid"
else
  echo "FRESH"
fi
