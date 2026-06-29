#!/bin/sh
# Background NDP keepalive — every PERIOD seconds, fires one ICMPv6 packet
# from EVERY source address in GRAPPA_OUTBOUND_V6_POOL to the v6 gateway,
# IN PARALLEL, so the upstream router's NDP table never expires a pool entry.
#
# Why: m42's upstream router ages NDP entries aggressively. A source
# address that hasn't sent a packet recently goes stale; the next outbound
# connect from it drops at the first hop until neighbor solicitation
# resolves. Touching each source every PERIOD keeps the entry warm at L2.
#
# Design (robust, pool-size-independent):
#   - Per cycle, spawn one `ping -c COUNT` per source in the BACKGROUND, then
#     `wait`. Each ping is short-lived (-c COUNT, bounded by -W) so there are
#     NO long-lived children to supervise and NO PID bookkeeping.
#   - Per-IP refresh period = PERIOD, independent of how many IPs are in the
#     pool (the old serial loop made it grow with the pool size).
#   - A single dropped solicitation just means that IP waits one more PERIOD;
#     no count>1 / sub-second spacing needed, so this does NOT require root.
#   - trap kills any stragglers on stop.
#
# Gateway resolution order:
#   1. GRAPPA_NDP_KEEPALIVE_GATEWAY (operator-pinned, e.g. "fe80::1%vtnet0")
#      — required for shared-IP bastille jails where `route get default`
#      returns nothing because the host owns routing.
#   2. `route -6 -n get default`.
#
# Invoked by /usr/local/etc/rc.d/grappa_ndp_keepalive via daemon(8).
# Sources GRAPPA_OUTBOUND_V6_POOL from /usr/local/etc/grappa/grappa.env.

set -u

ENV_FILE="${GRAPPA_ENV_FILE:-/usr/local/etc/grappa/grappa.env}"
INTERVAL="${GRAPPA_NDP_KEEPALIVE_INTERVAL:-10}"
COUNT="${GRAPPA_NDP_KEEPALIVE_COUNT:-1}"
GATEWAY_OVERRIDE="${GRAPPA_NDP_KEEPALIVE_GATEWAY:-}"

log() {
	echo "[ndp-keepalive] $*"
}

# Reap any straggler pings on stop so we do not leak children.
trap 'kill 0 2>/dev/null' TERM INT

if [ ! -r "${ENV_FILE}" ]; then
	log "env file ${ENV_FILE} not readable — exiting"
	exit 1
fi

# Read only the pool var; do not pollute the environment with secrets.
POOL=$(grep -E "^GRAPPA_OUTBOUND_V6_POOL=" "${ENV_FILE}" | tail -n1 | cut -d= -f2-)

if [ -z "${POOL}" ]; then
	log "GRAPPA_OUTBOUND_V6_POOL empty/missing in ${ENV_FILE} — nothing to keep alive, exiting"
	exit 0
fi

resolve_gateway() {
	if [ -n "${GATEWAY_OVERRIDE}" ]; then
		echo "${GATEWAY_OVERRIDE}"
		return
	fi
	route -6 -n get default 2>/dev/null | awk "/gateway:/ {print \$2; exit}"
}

if [ -n "${GATEWAY_OVERRIDE}" ]; then
	log "starting: period=${INTERVAL}s count=${COUNT} gateway=${GATEWAY_OVERRIDE} (pinned) parallel pool=${POOL}"
else
	log "starting: period=${INTERVAL}s count=${COUNT} gateway=auto parallel pool=${POOL}"
fi

while true; do
	GW=$(resolve_gateway)
	if [ -z "${GW}" ]; then
		log "no default v6 gateway — sleeping ${INTERVAL}s and retrying"
		sleep "${INTERVAL}"
		continue
	fi

	# Fire every source in parallel; each ping is single-shot and bounded.
	OLDIFS=$IFS
	IFS=","
	for SRC in ${POOL}; do
		ping -6 -c "${COUNT}" -W 2000 -S "${SRC}" "${GW}" >/dev/null 2>&1 &
	done
	IFS=$OLDIFS
	wait

	sleep "${INTERVAL}"
done
