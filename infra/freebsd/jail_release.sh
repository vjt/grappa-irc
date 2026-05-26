#!/bin/sh
# Run `bin/grappa <args>` as the grappa user inside the bastille
# jail, with /usr/local/etc/grappa/grappa.env sourced first.
#
# Invoke from m42 host:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_release.sh version
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_release.sh eval 'Grappa.Release.migrate()'
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_release.sh daemon
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_release.sh stop

set -eu

RELEASE_PATH="${RELEASE_PATH:-/home/grappa/grappa/_build/prod/rel/grappa}"
ENV_FILE="${ENV_FILE:-/usr/local/etc/grappa/grappa.env}"

if [ ! -r "${ENV_FILE}" ]; then
	echo "[jail_release] ERROR: env file ${ENV_FILE} not readable" >&2
	exit 1
fi

ARGS_FILE=$(mktemp /tmp/jail_release_args.XXXXXX)
chmod 0644 "${ARGS_FILE}"
trap 'rm -f "${ARGS_FILE}"' EXIT
# `bastille cmd <jail> <script> a b c` invokes the script with
# a as $0, b as $1, etc. — the first positional gets eaten as the
# script name. Reconstruct the real argv by prepending $0 unless
# it looks like our own path (defensive: if the operator invokes
# the script outside bastille, $0 IS the script path).
case "$0" in
	*/jail_release.sh|jail_release.sh)
		: # invoked normally, $@ is correct
		;;
	*)
		set -- "$0" "$@"
		;;
esac
printf '%s\n' "$@" > "${ARGS_FILE}"

exec su -l grappa -c '
set -eu
set -a
. '"${ENV_FILE}"'
set +a
set --
while IFS= read -r line; do
	set -- "$@" "$line"
done < "'"${ARGS_FILE}"'"
exec '"${RELEASE_PATH}"'/bin/grappa "$@"
'
