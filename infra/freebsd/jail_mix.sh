#!/bin/sh
# Run `mix <args>` as the grappa user inside the bastille jail.
#
# Invoke from m42 host:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_mix.sh deps.get --only prod
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_mix.sh compile --warnings-as-errors
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_mix.sh release --overwrite
#
# `MIX_OS_CONCURRENCY_LOCK=0` because jail /tmp can't take cross-uid
# hard links; mix only uses them as a build lock — harmless to disable
# for serialized deploy runs.

set -eu

# Pass-through args via a temp file so quoting survives su -l.
ARGS_FILE=$(mktemp /tmp/jail_mix_args.XXXXXX)
trap 'rm -f "${ARGS_FILE}"' EXIT
printf '%s\n' "$@" > "${ARGS_FILE}"

exec su -l grappa -c '
set -eu
export PATH=/usr/local/lib/erlang28/bin:$PATH
export MIX_ENV=${MIX_ENV:-prod}
export MIX_OS_CONCURRENCY_LOCK=0
cd /home/grappa/grappa
# Re-read args from the file into "$@"
set --
while IFS= read -r line; do
	set -- "$@" "$line"
done < "'"${ARGS_FILE}"'"
exec mix "$@"
'
