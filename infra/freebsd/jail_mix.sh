#!/bin/sh
# Convenience wrapper: run `mix <args>` as the grappa user inside the
# bastille jail with PATH + MIX_ENV + concurrency-lock set right.
#
# Usage (from m42 host):
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_mix.sh deps.get --only prod
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_mix.sh compile --warnings-as-errors
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_mix.sh release --overwrite
#
# Lives in the repo so the recipe is checked in + reproducible.
# `MIX_OS_CONCURRENCY_LOCK=0` because the jail's /tmp can't take
# hard-links across uid boundaries; mix only uses them as a build
# lock, harmless to disable for serialized deploy runs.

set -eu

exec su -l grappa -c "
export PATH=/usr/local/lib/erlang28/bin:\$PATH
export MIX_ENV=${MIX_ENV:-prod}
export MIX_OS_CONCURRENCY_LOCK=0
cd /home/grappa/grappa
exec mix $*
"
