#!/bin/sh
# Background NDP keepalive — pings the v6 gateway from every source
# address in GRAPPA_OUTBOUND_V6_POOL on a fixed interval so the
# upstream router's NDP table never expires a pool entry.
#
# Why: m42's upstream router ages NDP entries aggressively. A source
# address that hasn't sent a packet recently goes stale; the next
# outbound connect from it drops at the first hop until neighbor
# solicitation resolves. Touching each source every 10s with a short
# burst keeps the entry warm at L2 — the burst survives single-packet
# loss so one dropped solicitation doesn't let an entry age out.
#
# Gateway resolution order:
#   1. GRAPPA_NDP_KEEPALIVE_GATEWAY env var (operator-pinned, e.g.
#      "fe80::1%vtnet0") — required for shared-IP bastille jails
#      where `route get default` returns nothing because the host
#      owns routing.
#   2. `route -6 -n get default` — works on hosts and VNET jails.
#
# Invoked by /usr/local/etc/rc.d/grappa_ndp_keepalive via daemon(8).
# Sources GRAPPA_OUTBOUND_V6_POOL from /usr/local/etc/grappa/grappa.env.

set -u

ENV_FILE="${GRAPPA_ENV_FILE:-/usr/local/etc/grappa/grappa.env}"
INTERVAL="${GRAPPA_NDP_KEEPALIVE_INTERVAL:-10}"
COUNT="${GRAPPA_NDP_KEEPALIVE_COUNT:-3}"
GATEWAY_OVERRIDE="${GRAPPA_NDP_KEEPALIVE_GATEWAY:-}"

log() {
	echo "[ndp-keepalive] $*"
}

if [ ! -r "${ENV_FILE}" ]; then
	log "env file ${ENV_FILE} not readable — exiting"
	exit 1
fi

# Read only the pool var; don't pollute the environment with secrets.
POOL=$(grep -E '^GRAPPA_OUTBOUND_V6_POOL=' "${ENV_FILE}" | tail -n1 | cut -d= -f2-)

if [ -z "${POOL}" ]; then
	log "GRAPPA_OUTBOUND_V6_POOL empty/missing in ${ENV_FILE} — nothing to keep alive, exiting"
	exit 0
fi

resolve_gateway() {
	if [ -n "${GATEWAY_OVERRIDE}" ]; then
		echo "${GATEWAY_OVERRIDE}"
		return
	fi
	# `route -6 -n get default` is the FreeBSD-idiomatic way; on a
	# v6-only default route the gateway line is the link-local hop.
	# Returns empty inside shared-IP jails (use the override there).
	route -6 -n get default 2>/dev/null | awk '/gateway:/ {print $2; exit}'
}

if [ -n "${GATEWAY_OVERRIDE}" ]; then
	log "starting: interval=${INTERVAL}s count=${COUNT} gateway=${GATEWAY_OVERRIDE} (pinned) pool=${POOL}"
else
	log "starting: interval=${INTERVAL}s count=${COUNT} gateway=auto pool=${POOL}"
fi

while true; do
	GW=$(resolve_gateway)
	if [ -z "${GW}" ]; then
		log "no default v6 gateway — sleeping ${INTERVAL}s and retrying"
		sleep "${INTERVAL}"
		continue
	fi

	OLDIFS=$IFS
	IFS=','
	for SRC in ${POOL}; do
		# ping(8) on FreeBSD 13+ handles both families; -6 forces v6,
		# -S sets source address, -c ${COUNT} sends a short burst,
		# -i 0.5 spaces them half a second apart (sub-second needs
		# root — daemon(8) runs us as root), -W 2000ms bounds the
		# per-packet wait. Output silenced — we only care about
		# generating the NDP exchange, not measuring RTT.
		ping -6 -S "${SRC}" -c "${COUNT}" -i 0.5 -W 2000 "${GW}" >/dev/null 2>&1 || \
			log "ping burst from ${SRC} to ${GW} failed (rc=$?)"
	done
	IFS=$OLDIFS

	sleep "${INTERVAL}"
done
