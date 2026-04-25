#!/bin/bash
# Open a sqlite3 shell against the dev (or prod) database.
#
# Usage:
#   scripts/db.sh                 # interactive sqlite3 shell on dev DB
#   scripts/db.sh "SELECT * FROM messages LIMIT 5;"   # one-shot query
#
# In prod (GRAPPA_PROD=1) opens the prod DB read-only via WAL-safe attach.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ "${GRAPPA_PROD:-}" = "1" ]; then
    DB="/app/runtime/grappa_prod.db"
    MODE_ARG="-readonly"
else
    DB="/app/runtime/grappa_dev.db"
    MODE_ARG=""
fi

if [ $# -eq 0 ]; then
    in_container sqlite3 $MODE_ARG "$DB"
else
    in_container sqlite3 $MODE_ARG "$DB" "$*"
fi
