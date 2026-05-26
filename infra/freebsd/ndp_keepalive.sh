#!/bin/sh
# Background NDP keepalive — pings the default v6 gateway from every
# source address in GRAPPA_OUTBOUND_V6_POOL on a fixed interval so the
# hoster's NDP table never expires a pool entry.
#
# Why: m42's upstream router ages NDP entries aggressively. A source
# address that hasn't sent a packet recently goes stale; the next
# outbound connect from it drops at the first hop until neighbor
# solicitation resolves. Touching each source every 30s keeps the
# entry warm at L2.
#
# Pings the default v6 gateway (link-local first hop) rather than a
# remote target — zero external dependency and exactly the entry that
# expires.
#
# Invoked by /usr/local/etc/rc.d/grappa-ndp-keepalive via daemon(8).
# Sources GRAPPA_OUTBOUND_V6_POOL from /usr/local/etc/grappa/grappa.env.

set -u

ENV_FILE="${GRAPPA_ENV_FILE:-/usr/local/etc/grappa/grappa.env}"
INTERVAL="${GRAPPA_NDP_KEEPALIVE_INTERVAL:-30}"

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
	# `route -6 -n get default` is the FreeBSD-idiomatic way; on a
	# v6-only default route the gateway line is the link-local hop.
	route -6 -n get default 2>/dev/null | awk '/gateway:/ {print $2; exit}'
}

log "starting: interval=${INTERVAL}s pool=${POOL}"

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
		# -S sets source address, -c 1 sends one packet, -W 2000ms
		# bounds the wait. Output silenced — we only care about
		# generating the NDP exchange, not measuring RTT.
		ping -6 -S "${SRC}" -c 1 -W 2000 "${GW}" >/dev/null 2>&1 || \
			log "ping from ${SRC} to ${GW} failed (rc=$?)"
	done
	IFS=$OLDIFS

	sleep "${INTERVAL}"
done
