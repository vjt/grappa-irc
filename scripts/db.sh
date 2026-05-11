#!/usr/bin/env bash
# Open a sqlite3 shell against the active database.
#
# Usage:
#   scripts/db.sh                 # interactive sqlite3 shell
#   scripts/db.sh "SELECT * FROM messages LIMIT 5;"   # one-shot query
#
# Reads MIX_ENV from the running container to pick the right db file.
# Defaults to dev when not set. Prod DBs open read-only via WAL-safe
# attach.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

env="$(in_container printenv MIX_ENV 2>/dev/null || echo dev)"
DB="/app/runtime/grappa_${env}.db"
MODE_ARG=""
if [ "$env" = "prod" ]; then
    MODE_ARG="-readonly"
fi

if [ $# -eq 0 ]; then
    in_container sqlite3 $MODE_ARG "$DB"
else
    in_container sqlite3 $MODE_ARG "$DB" "$*"
fi
