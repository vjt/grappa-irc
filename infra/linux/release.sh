#!/usr/bin/env bash
# Run `bin/grappa <args>` as the grappa user on a native Linux/systemd
# host, with the secrets env file sourced first.
#
# Usage (as root, or any user that can sudo -u grappa):
#   infra/linux/release.sh version
#   infra/linux/release.sh eval 'Grappa.Release.migrate()'
#   infra/linux/release.sh remote
#   infra/linux/release.sh stop
#
# Port of infra/freebsd/jail_release.sh. Simpler here: no bastille-cmd
# argv-eating quirk to work around, so no $0-vs-$@ reconstruction dance.

set -euo pipefail

RELEASE_PATH="${RELEASE_PATH:-/home/grappa/grappa/_build/prod/rel/grappa}"
ENV_FILE="${ENV_FILE:-/etc/grappa/grappa.env}"
GRAPPA_USER="${GRAPPA_USER:-grappa}"

if [ ! -r "${ENV_FILE}" ]; then
	echo "[release] ERROR: env file ${ENV_FILE} not readable" >&2
	exit 1
fi

exec sudo -u "${GRAPPA_USER}" -H bash -c '
set -euo pipefail
set -a
. "'"${ENV_FILE}"'"
set +a
exec "'"${RELEASE_PATH}"'/bin/grappa" "$@"
' bash "$@"
