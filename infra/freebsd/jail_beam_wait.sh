#!/bin/sh
# Synchronize on BEAM shutdown / epmd name release — the shared
# stop/start race killer for defect #9 (2026-06-11 prod outage: a
# `service grappa restart` started the new BEAM while the old node was
# still draining WS connections; the new node died at boot with
# "the name grappa@grappa seems to be in use by another Erlang node"
# and rc.d walked away silent).
#
# Two call sites, one implementation:
#   - infra/freebsd/rc.d/grappa     grappa_stop (wait-stopped) and
#                                   grappa_start (wait-name-free)
#   - infra/freebsd/deploy.sh       cold path, after `service grappa
#                                   stop` (covers transition deploys
#                                   that stopped via a previously
#                                   installed, still-async wrapper)
#
# Verbs (all args required — no defaults):
#   wait-stopped <node> <timeout>    Block until beam.smp has exited
#                                    AND epmd no longer lists <node>.
#                                    Escalates: SIGKILL the BEAM after
#                                    <timeout>s; restart epmd if the
#                                    name is still listed <timeout>s
#                                    after the BEAM is gone (safe ONLY
#                                    then — pkill'ing epmd under a
#                                    live BEAM makes the BEAM respawn
#                                    it and re-races the registration,
#                                    live-repro 2026-05-31).
#   wait-name-free <node> <timeout>  Block until epmd no longer lists
#                                    <node>. NO escalation — used as
#                                    the pre-start guard, where the
#                                    registered name may belong to a
#                                    still-draining old node that must
#                                    not be shot.
#
# Exit codes: 0 condition met, 1 timeout (after escalation for
# wait-stopped), 64 usage.

set -eu

# epmd ships with the pkg-installed Erlang; rc(8) and root shells don't
# have /usr/local paths (same pin as deploy.sh's run_as_grappa). If the
# pkg moves (erlang29) the binary silently vanishes from PATH and every
# name_registered() check would read as "free" — warn loudly instead of
# degrading the wait to BEAM-exit-only without a trace.
PATH="/usr/local/lib/erlang28/bin:${PATH}"
if ! command -v epmd >/dev/null 2>&1; then
	echo "[beam-wait] WARNING: epmd binary not found on PATH (erlang pkg moved?) — name-release checks degraded to BEAM-exit only" >&2
fi

# `epmd -names` exits non-zero when no epmd is running — no daemon, no
# registrations, name trivially free.
name_registered() {
	out=$(epmd -names 2>/dev/null) || return 1
	printf '%s\n' "${out}" | grep -q "^name $1 at "
}

# Single-tenant jail: the only BEAM that ever runs here is grappa's, so
# matching on the emulator binary name is unambiguous (and survives pid
# file staleness, which a crashed run_erl leaves behind).
beam_alive() {
	pgrep -q beam.smp 2>/dev/null
}

wait_stopped() {
	node="$1"
	timeout="$2"

	i=0
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
			# BEAM confirmed gone yet epmd still lists the name — a
			# stale registration. Restarting epmd is safe now: no BEAM
			# is alive to respawn it mid-kill, and the next `bin/grappa
			# daemon` spawns a fresh one.
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
	node="$1"
	timeout="$2"

	i=0
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
