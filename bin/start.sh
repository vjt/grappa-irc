#!/bin/sh
# bin/start.sh — container entrypoint. Sets BEAM resource caps from the
# operator-facing knobs, then execs `mix phx.server`.
#
# Lives here (rather than rel/env.sh.eex, EEX-templated by `mix release`)
# because the cluster-code-reload cluster dropped the release stage —
# `mix phx.server` is the canonical boot path in dev, prod, and CI.
#
# Knobs:
#   - GRAPPA_MAX_USERS (default: 100)
#       Sizes both VM tables. Drives `+Q` (max OS ports: sockets, file
#       handles, drivers) and `+P` (max BEAM processes: GenServers,
#       Tasks, Phoenix Channels) linearly. One knob, both tables move
#       together.
#
#   - GRAPPA_DIRTY_SCHEDULERS (default: $(nproc))
#       Sets BOTH `+SDcpu` (dirty CPU schedulers) and `+SDio` (dirty
#       IO schedulers). BEAM's `+SDio` default is a fixed 10 regardless
#       of CPU count, which is wasteful on a 4-core host (10 idle
#       threads with their own allocator carriers). Defaulting to nproc
#       gives 1 dirty scheduler per CPU for each pool.
#
# Why this exists: Docker on Linux 6.x inherits NOFILE = 2^30 from the
# host; without a `+Q` cap BEAM sizes the port table at
# `min(ulimit -n, 2^27 - 1) = 134M ports` → ~1.5 GB ll_alloc carrier
# reserved at boot. The default `+SDio 10` adds ~14 idle scheduler
# threads (4 normal + 4 dirty CPU + 10 dirty IO) with per-scheduler
# allocator carriers, ~30-50 MB of unused capacity on a Pi 5.
#
# Per-user ratios (with comfort headroom for reconnect storms,
# multi-tab clients, future Phase 6 IRCv3 listener facade):
#   - 400 ports/user  → covers heavy user (~8 active) ~50× over
#   - 100 procs/user  → covers ~10 BEAM procs/user 10× over

set -e

: "${GRAPPA_MAX_USERS:=100}"
: "${GRAPPA_DIRTY_SCHEDULERS:=$(nproc)}"

GRAPPA_MAX_PORTS=$((GRAPPA_MAX_USERS * 400))
GRAPPA_MAX_PROCS=$((GRAPPA_MAX_USERS * 100))

export ELIXIR_ERL_OPTIONS="+Q ${GRAPPA_MAX_PORTS} +P ${GRAPPA_MAX_PROCS} +SDcpu ${GRAPPA_DIRTY_SCHEDULERS} +SDio ${GRAPPA_DIRTY_SCHEDULERS}"

exec mix phx.server
