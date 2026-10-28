#!/bin/sh
# Run a sqlite UPDATE/INSERT against the prod DB as the grappa user.
# Usage:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_db_write.sh "UPDATE ..."

set -eu

case "$0" in
	*/jail_db_write.sh|jail_db_write.sh) : ;;
	*) set -- "$0" "$@" ;;
esac

QUERY_FILE=$(mktemp /tmp/jail_db_write.XXXXXX)
chmod 0644 "${QUERY_FILE}"
trap 'rm -f "${QUERY_FILE}"' EXIT

printf '%s\n' "$*" > "${QUERY_FILE}"

exec su -l grappa -c '
exec sqlite3 /home/grappa/grappa/runtime/grappa_prod.db < "'"${QUERY_FILE}"'"
'
