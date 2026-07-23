#!/usr/bin/env bash
# Trimmed port of infra/freebsd/jail_beam_wait.sh for the Linux/systemd
# substrate.
#
# On FreeBSD this was the PRIMARY stop/start sync mechanism because
# rc.d's `service grappa stop` is asynchronous (defect #9, 2026-06-11
# outage: a restart raced the still-draining old node into an epmd
# name collision). On Linux, `ExecStart=.../bin/grappa start` runs the
# release in the FOREGROUND under systemd `Type=exec` — systemd tracks
# that PID directly and `systemctl stop`/`restart` natively block until
# it exits (bounded by TimeoutStopSec). That closes the defect #9 race
# at the root cause, so this script is no longer load-bearing for the
# stop path.
#
# It's kept for two narrower purposes:
#   - `wait-name-free` wired into grappa.service as ExecStartPre — a
#     defense-in-depth guard against a restart-cycling edge case
#     where epmd hasn't yet reacted to a just-exited node.
#   - `wait-stopped` kept as a standalone operator tool for manually
#     troubleshooting a stuck stop (not invoked by any script here).
#
# Verbs (all args required — no defaults):
#   wait-stopped <node> <timeout>    Block until beam.smp has exited
#                                    AND epmd no longer lists <node>.
#                                    Escalates: SIGKILL the BEAM after
#                                    <timeout>s; restart epmd if the
#                                    name is still listed <timeout>s
#                                    after the BEAM is gone.
#   wait-name-free <node> <timeout>  Block until epmd no longer lists
#                                    <node>. NO escalation — the
#                                    registered name may belong to a
#                                    still-draining old node that must
#                                    not be shot.
#
# Exit codes: 0 condition met, 1 timeout (after escalation for
# wait-stopped), 64 usage.

set -euo pipefail

if ! command -v epmd >/dev/null 2>&1; then
	echo "[beam-wait] WARNING: epmd binary not found on PATH — name-release checks degraded to BEAM-exit only" >&2
fi

# `epmd -names` exits non-zero when no epmd is running — no daemon, no
# registrations, name trivially free.
name_registered() {
	local out
	out=$(epmd -names 2>/dev/null) || return 1
	printf '%s\n' "${out}" | grep -q "^name $1 at "
}

# Single-tenant host assumption carried over from FreeBSD: the only
# BEAM expected on this host is grappa's, so matching on the emulator
# binary name is unambiguous.
beam_alive() {
	pgrep -q beam.smp 2>/dev/null
}

wait_stopped() {
	local node="$1" timeout="$2" i=0

	while beam_alive; do
		if [ "${i}" -ge "${timeout}" ]; then
			echo "[beam-wait] WARNING: BEAM still alive ${timeout}s after stop — SIGKILL" >&2
			pkill -9 beam.smp 2>/dev/null || true
			sleep 1
			break
		fi
		i=$((i + 1))
		sleep 1
	done

	i=0
	while name_registered "${node}"; do
		if [ "${i}" -ge "${timeout}" ]; then
			echo "[beam-wait] WARNING: epmd still lists '${node}' ${timeout}s after BEAM exit — restarting epmd" >&2
			pkill epmd 2>/dev/null || true
			sleep 1
			break
		fi
		i=$((i + 1))
		sleep 1
	done

	if beam_alive || name_registered "${node}"; then
		echo "[beam-wait] ERROR: BEAM or epmd name '${node}' still present after escalation — manual intervention needed (pgrep beam.smp; epmd -names)" >&2
		return 1
	fi
}

wait_name_free() {
	local node="$1" timeout="$2" i=0

	while name_registered "${node}"; do
		if [ "${i}" -ge "${timeout}" ]; then
			echo "[beam-wait] ERROR: epmd name '${node}' still registered after ${timeout}s — an old node is still draining or stuck; wait for it (epmd -names) and retry" >&2
			return 1
		fi
		i=$((i + 1))
		sleep 1
	done
}

usage() {
	echo "usage: $0 wait-stopped|wait-name-free <node> <timeout-seconds>" >&2
	exit 64
}

[ $# -eq 3 ] || usage

case "$1" in
	wait-stopped) wait_stopped "$2" "$3" ;;
	wait-name-free) wait_name_free "$2" "$3" ;;
	*) usage ;;
esac
