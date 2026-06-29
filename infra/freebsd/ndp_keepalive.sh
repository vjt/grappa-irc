#!/bin/sh
# Background NDP keepalive — every PERIOD seconds, fires one ICMPv6 packet
# from EVERY source address in GRAPPA_OUTBOUND_V6_POOL to BOTH the v6 gateway
# (inside) AND a set of external anchors (outside), IN PARALLEL.
#
# Why two targets:
#   - GATEWAY (link-local, e.g. fe80::1): keeps the upstream router's
#     link-layer neighbour cache entry for each of our source addresses warm,
#     so the next outbound packet does not stall on neighbour solicitation.
#   - EXTERNAL ANCHORS (global, e.g. 2606:4700:4700::1111): real end-to-end
#     round-trips that keep the upstream router's FORWARDING path for our
#     global source addresses warm. Pinging only the link-local gateway does
#     NOT exercise this; on hosters that do not preserve NDP/forwarding state
#     for idle source addresses, freshly-active /128s drop external packets
#     until traffic warms the path. Anchors fix that.
#
# Design (robust, pool-size-independent):
#   - Per cycle, spawn one single-shot `ping -c COUNT` per (source, target) in
#     the BACKGROUND, then `wait`. No long-lived children, no PID bookkeeping.
#   - Per-IP refresh period = PERIOD, independent of pool size.
#   - A single dropped packet just waits one more PERIOD; no count>1 /
#     sub-second spacing needed, so this does NOT require root.
#   - trap reaps stragglers on stop.
#
# Gateway resolution: GRAPPA_NDP_KEEPALIVE_GATEWAY override (required in
# shared-IP bastille jails where `route get default` is empty), else
# `route -6 -n get default`.
#
# Invoked by /usr/local/etc/rc.d/grappa_ndp_keepalive via daemon(8).
# Sources GRAPPA_OUTBOUND_V6_POOL from /usr/local/etc/grappa/grappa.env.

set -u

ENV_FILE="${GRAPPA_ENV_FILE:-/usr/local/etc/grappa/grappa.env}"
INTERVAL="${GRAPPA_NDP_KEEPALIVE_INTERVAL:-10}"
COUNT="${GRAPPA_NDP_KEEPALIVE_COUNT:-1}"
GATEWAY_OVERRIDE="${GRAPPA_NDP_KEEPALIVE_GATEWAY:-}"
# Comma-separated external anchors (global v6). Real round-trips keep the
# upstream forwarding path warm for each source. Override via env if needed.
EXT_ANCHORS="${GRAPPA_NDP_KEEPALIVE_EXT_ANCHORS:-2606:4700:4700::1111,2001:4860:4860::8888}"

log() {
	echo "[ndp-keepalive] $*"
}

trap 'kill 0 2>/dev/null' TERM INT

if [ ! -r "${ENV_FILE}" ]; then
	log "env file ${ENV_FILE} not readable — exiting"
	exit 1
fi

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

log "starting: period=${INTERVAL}s count=${COUNT} parallel gateway=${GATEWAY_OVERRIDE:-auto} ext_anchors=${EXT_ANCHORS} pool=${POOL}"

while true; do
	GW=$(resolve_gateway)
	if [ -z "${GW}" ]; then
		log "no default v6 gateway — sleeping ${INTERVAL}s and retrying"
		sleep "${INTERVAL}"
		continue
	fi

	OLDIFS=$IFS
	IFS=","
	for SRC in ${POOL}; do
		# inside: warm the link-layer neighbour entry at the gateway
		ping -6 -c "${COUNT}" -W 2000 -S "${SRC}" "${GW}" >/dev/null 2>&1 &
		# outside: warm the upstream forwarding path for this global source
		for A in ${EXT_ANCHORS}; do
			ping -6 -c "${COUNT}" -W 2000 -S "${SRC}" "${A}" >/dev/null 2>&1 &
		done
	done
	IFS=$OLDIFS
	wait

	sleep "${INTERVAL}"
done
