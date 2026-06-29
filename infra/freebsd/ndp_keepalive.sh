#!/bin/sh
# Thin shim — the NDP keepalive supervisor now lives in ndp_keepalive.pl
# (perl, event-driven SIGCHLD respawn of long-lived `ping -i` data-plane
# processes). The old spawn-per-tick shell loop churned process accounting and
# inflated loadavg; see ndp_keepalive.pl for the why.
#
# This wrapper exists only so the rc.d command (`/bin/sh <script>`) and the
# daemon(8) -r respawn layer stay unchanged. All GRAPPA_NDP_KEEPALIVE_* env
# vars exported by the rc.d precmd are inherited by the exec below.

set -u

DIR=$(dirname "$0")
exec /usr/local/bin/perl "${DIR}/ndp_keepalive.pl"
