#!/bin/sh
# Pull HEAD of main into the jail-side checkout. Runs as grappa user.
#
# Invoke from m42 host:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_git_pull.sh

set -eu
exec su -l grappa -c '
set -eu
cd /home/grappa/grappa
# --recurse-submodules=on-demand completes the pull: without it a gitlink
# bump leaves this checkout dirty forever and every release reports
# X.Y.Z-<sha>. Why + why not the bare flag: infra/lib/deploy_common.sh,
# above the substrate_pull call (#1851).
git pull --ff-only --recurse-submodules=on-demand
git log --oneline -3
'
