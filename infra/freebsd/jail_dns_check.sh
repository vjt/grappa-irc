#!/bin/sh
# DNS smoke check from inside the BEAM (the OS resolver may work
# while Erlang's :inet_res still has a stale cache).
#
# Usage: sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_dns_check.sh <hostname>

set -eu

case "$0" in
	*/jail_dns_check.sh|jail_dns_check.sh) : ;;
	*) set -- "$0" "$@" ;;
esac

HOST="${1:-irc.azzurra.chat}"

exec su -l grappa -c "
set -a
. /usr/local/etc/grappa/grappa.env
set +a
exec /home/grappa/grappa/_build/prod/rel/grappa/bin/grappa rpc 'IO.inspect(:inet_res.lookup(~c\"${HOST}\", :in, :a), label: \":inet_res a/${HOST}\"); IO.inspect(:inet.gethostbyname(~c\"${HOST}\"), label: \":inet/${HOST}\"); :ok'
"
