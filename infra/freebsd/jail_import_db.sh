#!/bin/sh
# Import a sqlite DB file dropped at /tmp/grappa_prod.db (jail-side
# path; via SCP host->jail-mount) into the runtime location, owned
# by the grappa user.
#
# Invoke from m42 host:
#   scp local-grappa-prod.db m42:/tmp/
#   ssh m42 sudo cp /tmp/local-grappa-prod.db /usr/local/bastille/jails/grappa/root/tmp/grappa_prod.db
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_import_db.sh
#
# Assumes grappa service is STOPPED — refuses to run if a pid file
# exists. Atomic rename so a concurrent reader never sees a partial
# DB.

set -eu

SRC="/tmp/grappa_prod.db"
DST="/home/grappa/grappa/runtime/grappa_prod.db"
PID_FILE="/home/grappa/grappa/_build/prod/rel/grappa/tmp/pid"

if [ ! -r "${SRC}" ]; then
	echo "[import_db] ERROR: ${SRC} not readable — copy it in first via:" >&2
	echo "  scp grappa_prod.db m42:/tmp/" >&2
	echo "  sudo cp /tmp/grappa_prod.db /usr/local/bastille/jails/grappa/root/tmp/" >&2
	exit 1
fi

if [ -r "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
	echo "[import_db] ERROR: grappa is running (pid $(cat "${PID_FILE}")). Stop it first:" >&2
	echo "  sudo bastille cmd grappa service grappa stop" >&2
	exit 1
fi

# Backup current DB if present.
if [ -f "${DST}" ]; then
	BACKUP="${DST}.before-import-$(date -u +%Y%m%dT%H%M%SZ)"
	echo "[import_db] backing up current DB -> ${BACKUP}"
	cp -p "${DST}" "${BACKUP}"
	chown grappa:grappa "${BACKUP}"
fi

# WAL + SHM sidecars from the previous DB MUST be removed before
# importing — sqlite would otherwise mix the new main DB with the
# old WAL frames (corruption).
rm -f "${DST}-wal" "${DST}-shm"

echo "[import_db] installing ${SRC} -> ${DST}"
install -o grappa -g grappa -m 0640 "${SRC}" "${DST}"

echo "[import_db] integrity_check:"
su -l grappa -c "sqlite3 '${DST}' 'PRAGMA integrity_check;'"

echo "[import_db] schema_migrations head:"
su -l grappa -c "sqlite3 '${DST}' 'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 3;'"

echo "[import_db] done. Start service with: sudo bastille cmd grappa service grappa start"
