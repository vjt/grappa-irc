#!/usr/bin/env bash
# Attach observer_cli to the running grappa node.
#
# observer_cli is a TUI-based runtime introspection tool. From here you can
# see every supervised process, mailbox depth, memory, scheduler load, etc.
# It's the BEAM equivalent of htop+strace+tokio-console combined.
#
# Usage:
#   scripts/observer.sh

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

in_container iex -S mix run -e ':observer_cli.start()'
