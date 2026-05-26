#!/bin/sh
# Run an arbitrary sqlite3 query against the prod DB as grappa user.
# Usage:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_db_query.sh "SELECT ..."

set -eu

QUERY_FILE=$(mktemp /tmp/jail_db_query.XXXXXX)
chmod 0644 "${QUERY_FILE}"
trap 'rm -f "${QUERY_FILE}"' EXIT

case "$0" in
	*/jail_db_query.sh|jail_db_query.sh) : ;;
	*) set -- "$0" "$@" ;;
esac

printf '%s\n' "$*" > "${QUERY_FILE}"

exec su -l grappa -c '
exec sqlite3 -header -column /home/grappa/grappa/runtime/grappa_prod.db < "'"${QUERY_FILE}"'"
'
