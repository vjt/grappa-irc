#!/bin/sh
# /usr/share/grappa/apply-upgrade.sh — apply an upgraded grappa package to the
# RUNNING service (issue 1112): hot when the release allows it, by restart
# otherwise. An upgrade needs nothing else from the operator.
#
# Called as root by the deb postinst / rpm %post when the unit is active
# (scripts/postinstall.sh), and on Arch by the alpm hook aur/grappa-apply.hook
# at the end of the transaction — the hook sits under usr/, so it also reaches
# a repackaging that drops our install scriptlet. POSIX /bin/sh.
#
#   0  the unit is not running (left as it is: its next start runs the new
#      release and migrates first, in ExecStartPre), OR the upgrade was
#      applied hot, OR it was applied by restart
#   1  a restart was needed and did not take — the ONLY failure: every hot
#      refusal is a reason to restart, never a reason to fail
#
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)", "An upgrade
# applies itself".

set -u

UNIT=grappa.service
GRAPPA=/usr/bin/grappa
ENV_FILE=/etc/grappa/grappa.env
START_ERL=/usr/lib/grappa/releases/start_erl.data
# /healthz probes after a reload or a restart, one second apart.
HEALTH_TRIES=60
# Every call that waits on the node is bounded, in seconds: the package
# manager holds its lock for as long as this script runs, and a node that
# accepts a connection and never answers would hold it forever. The reload
# migrates in-process, so it gets the budget the unit gives a migration on a
# restart (TimeoutStartSec).
RPC_TIMEOUT=60
EVAL_TIMEOUT=120
RELOAD_TIMEOUT=300
PROBE_TIMEOUT=5

# Evaluated INSIDE the running node: its own manifest, the one compiled into
# the code it runs. The is_loaded guard is not decoration — on a node that
# autoloads (interactive mode) the call would load the NEW beam the package
# just wrote, report the new manifest as the old one and turn every upgrade
# HOT. The module is named through a variable and called with apply/3, so no
# literal remote call to it is expanded — and nothing can load it — before
# the guard has run. A release boots embedded and has the module loaded at
# boot; a node without it is one older than this mechanism, and it must not
# answer.
RPC_EXPR='m = Grappa.Deploy.Manifest; if :code.is_loaded(m), do: IO.write(apply(m, :encode, [])), else: raise("Grappa.Deploy.Manifest is not loaded in the running node")'
# Evaluated by the NEW release on disk: compares the reported manifest (the
# file named in argv) with its own. Exit 0 hot, 3 cold, anything else a crash.
VERDICT_EXPR='Grappa.Deploy.Manifest.cli(System.argv())'

say() { printf 'grappa: %s\n' "$*"; }
warn() { printf 'grappa: %s\n' "$*" >&2; }

# Scratch space for the reported manifest and the reload's answer: a fresh
# directory that only root writes to and the grappa user may only traverse,
# so the release, run as grappa, reads the manifest by its path. Removed on
# every way out, a signal included.
scratch=''
cleanup() { [ -z "$scratch" ] || rm -rf "$scratch"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# The ERTS the running node executes, read off /proc/<MainPID>/exe
# (`.../erts-16.4/bin/beam.smp`, with " (deleted)" once the file is replaced
# or removed — dpkg replaces every file on every upgrade, so the suffix alone
# says nothing; the version does).
running_erts() {
	pid=$(systemctl show -p MainPID --value "$UNIT") || return 1
	case "$pid" in '' | 0 | *[!0-9]*) return 1 ;; esac
	exe=$(readlink "/proc/$pid/exe") || return 1
	case "$exe" in */erts-*/bin/*) ;; *) return 1 ;; esac
	erts=${exe%%/bin/*}
	printf '%s' "${erts##*/erts-}"
}

# The ERTS the release on disk boots: field 1 of start_erl.data, read the way
# the release's own start script reads field 2 (`cut -d' '`). Not `read`:
# `mix release` writes the file with no trailing newline, and `read` reports
# that as a failure even though it filled the variable.
release_erts() {
	erts=$(cut -d' ' -f1 "$START_ERL" 2>/dev/null) || return 1
	[ -n "$erts" ] || return 1
	printf '%s' "$erts"
}

# PORT from the env file, read and never sourced (it is root reading a file
# the grappa group can write to), bare or in quotes as systemd's
# EnvironmentFile= accepts it. The template's value when absent.
http_port() {
	port=$(sed -n "s/^[[:space:]]*PORT=[\"']\{0,1\}\([0-9][0-9]*\)[\"']\{0,1\}[[:space:]]*\$/\1/p" "$ENV_FILE" 2>/dev/null | tail -n 1)
	printf '%s' "${port:-4000}"
}

healthy() {
	i=0
	while [ "$i" -lt "$HEALTH_TRIES" ]; do
		curl -fsS --connect-timeout 2 --max-time "$PROBE_TIMEOUT" -o /dev/null \
			"http://127.0.0.1:$PORT/healthz" 2>/dev/null && return 0
		i=$((i + 1))
		sleep 1
	done
	return 1
}

# Non-fatal, as on every substrate (#1167, #440): the gallery is cosmetic and
# the upsert converges on the next run.
seed() {
	if ! "$GRAPPA" seed-themes; then
		warn "built-in theme seeding FAILED (see error above). The upgrade is"
		warn "applied; the theme gallery may be stale. Retry with: sudo grappa seed-themes"
	fi
}

# The restart path, and the end of the script either way.
restart() {
	reason="$1"
	say "applying the upgrade by RESTART: $reason"
	systemctl daemon-reload || warn "systemctl daemon-reload failed — restarting anyway"
	# A unit past its StartLimitBurst refuses `restart` until this clears it.
	systemctl reset-failed "$UNIT" 2>/dev/null || true
	if ! systemctl restart "$UNIT"; then
		fail "systemctl restart $UNIT failed" "$reason"
	fi
	if ! healthy; then
		fail "the service did not answer /healthz within ${HEALTH_TRIES}s of the restart" "$reason"
	fi
	seed
	say "applied by RESTART: $reason"
	exit 0
}

fail() {
	warn "the upgrade was NOT applied: $1."
	warn "        It needed a restart because: $2"
	warn "        The new package is installed; the service is now: $(systemctl is-active "$UNIT" 2>/dev/null)."
	warn "        The restart migrates the database first (ExecStartPre), so a failed"
	warn "        migration shows up in: journalctl -u grappa -b"
	warn "        Fix the cause, then retry with: sudo systemctl restart grappa"
	exit 1
}

if ! systemctl is-active --quiet "$UNIT"; then
	say "$UNIT is not running — nothing to apply. Its next start runs the new release, migrating first."
	exit 0
fi

PORT=$(http_port)

# 1. The ERTS mine. A node left running from a removed ERTS directory halts the
#    first time it relaunches a helper program, so when the ERTS moved nothing
#    here talks to the node: no rpc, no HTTP. Restart first.
old=$(running_erts) || restart "the running node's ERTS could not be read"
new=$(release_erts) || restart "the new release's ERTS could not be read from $START_ERL"
[ "$old" = "$new" ] || restart "the ERTS moved ($old -> $new)"

# 2. The verdict: the manifest the running node was built from, against the
#    one the new release carries.
scratch=$(mktemp -d /run/grappa-upgrade.XXXXXX) || restart "could not create a scratch directory under /run"
chmod 0711 "$scratch"
manifest="$scratch/manifest"
timeout "$RPC_TIMEOUT" "$GRAPPA" rpc "$RPC_EXPR" >"$manifest"
rc=$?
if [ "$rc" -eq 124 ]; then
	restart "the running node did not report its manifest within ${RPC_TIMEOUT}s"
elif [ "$rc" -ne 0 ] || [ ! -s "$manifest" ]; then
	restart "the running node did not report its manifest (a release older than issue 1112 cannot)"
fi
# Read by the release as the grappa user.
chmod 0644 "$manifest"
verdict=$(timeout "$EVAL_TIMEOUT" "$GRAPPA" eval "$VERDICT_EXPR" "$manifest" 2>&1)
rc=$?
case "$rc" in
0) ;;
3) restart "$verdict" ;;
*) restart "verdict unavailable (the comparison exited $rc): $verdict" ;;
esac

# 3. HOT. The body and the code are both captured — `curl -f` would throw away
#    the body that says why a reload was refused. HTTP 200 is not success on
#    its own: the endpoint reports per-module failures in-band.
body="$scratch/reload-body"
code=$(curl -sS --max-time "$RELOAD_TIMEOUT" -o "$body" -w '%{http_code}' -X POST \
	"http://127.0.0.1:$PORT/admin/reload") || code="no answer"
answer=$(cat "$body")
case "$code:$answer" in
200:*'"failed":[]'*) ;;
*) restart "the hot reload was refused (HTTP $code): $answer" ;;
esac
healthy || restart "the service did not answer /healthz within ${HEALTH_TRIES}s of the hot reload"
# A hot reload leaves the browsers on the old bundle; this tells them. A cold
# start needs no call: the join reply carries the new bundle's hash.
curl -fsS --max-time "$PROBE_TIMEOUT" -o /dev/null -X POST "http://127.0.0.1:$PORT/admin/cic-bundle-changed" ||
	warn "could not notify the browsers of the new web bundle; they pick it up on their next reload"
seed
say "applied HOT: $answer"
exit 0
