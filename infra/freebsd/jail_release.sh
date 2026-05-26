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
trap 'rm -f "${ARGS_FILE}"' EXIT
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
