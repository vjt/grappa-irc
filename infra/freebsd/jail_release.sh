#!/bin/sh
# Convenience wrapper: invoke the assembled release's `bin/grappa`
# (or `bin/grappa eval <code>`) as the grappa user inside the
# bastille jail, with the env file sourced first.
#
# Usage (from m42 host):
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_release.sh version
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_release.sh eval 'Grappa.Release.migrate()'
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_release.sh start_iex
#
# `start_iex` is useful for first-boot smoke against the env without
# committing to running as a service.

set -eu

RELEASE_PATH="${RELEASE_PATH:-/home/grappa/grappa/_build/prod/rel/grappa}"
ENV_FILE="${ENV_FILE:-/usr/local/etc/grappa/grappa.env}"

if [ ! -r "${ENV_FILE}" ]; then
	echo "[jail_release] ERROR: env file ${ENV_FILE} not readable" >&2
	exit 1
fi

exec su -l grappa -c "
set -a
. ${ENV_FILE}
set +a
exec ${RELEASE_PATH}/bin/grappa $*
"
