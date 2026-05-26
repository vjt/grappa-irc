#!/bin/sh
# Pull HEAD of main into the jail-side checkout. Runs as grappa user.
#
# Invoke from m42 host:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_git_pull.sh

set -eu
exec su -l grappa -c '
set -eu
cd /home/grappa/grappa
git pull --ff-only
git log --oneline -3
'
