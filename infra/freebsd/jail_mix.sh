#!/bin/sh
# Run `mix <args>` as the grappa user inside the bastille jail.
#
# Invoke from m42 host:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_mix.sh deps.get --only prod
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_mix.sh compile --warnings-as-errors
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_mix.sh release --overwrite
#
# `MIX_OS_CONCURRENCY_LOCK=0` because jail /tmp cannot take the cross-uid
# hard links mix uses as a build lock; safe while deploy runs are
# serialized.

set -eu

# Pass-through args via a temp file so quoting survives su -l.
ARGS_FILE=$(mktemp /tmp/jail_mix_args.XXXXXX)
chmod 0644 "${ARGS_FILE}"
trap 'rm -f "${ARGS_FILE}"' EXIT
# `bastille cmd <jail> <script> a b c` invokes the script with a as $0
# (eaten as the script name), b as $1, etc. Restore the real argv by
# prepending $0 unless it already looks like this script's own path.
case "$0" in
	*/jail_mix.sh|jail_mix.sh)
		: # invoked normally
		;;
	*)
		set -- "$0" "$@"
		;;
esac
printf '%s\n' "$@" > "${ARGS_FILE}"

# shellcheck disable=SC2016  # the single quotes are the point: this body
# is a script for the CHILD shell, where $PATH / $@ / $line resolve.
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
