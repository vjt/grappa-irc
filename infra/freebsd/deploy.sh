#!/bin/sh
# Grappa native FreeBSD deploy — preflight-driven hot-vs-cold dispatcher.
#
# Run inside the jail as ROOT (the rc.d restart on the cold path needs it):
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh --force-hot
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh --force-cold
#
# Mirror of `scripts/deploy.sh` for the Docker substrate, sharing the
# `Grappa.Deploy.Preflight` classifier (single source of truth for which
# diffs are hot-safe — see `lib/grappa/deploy/preflight.ex`).
#
# Hot path (default when preflight returns HOT):
#   git pull → mix compile → mix release --overwrite → POST /admin/reload
#   Sessions preserved (Session.Server, IRC.Client, etc keep state via
#   Erlang's 2-version code-loading guarantee). NO service restart.
#
# Cold path (preflight returns COLD or --force-cold):
#   git pull → mix compile → mix release --overwrite → vite build →
#   migrate → service grappa restart → healthcheck loop.
#   Sessions reset. ~10-30s downtime depending on Bootstrap connect time.
#
# Cic bundle is rebuilt on COLD only; on HOT, server-side reload doesn't
# need the new bundle (cic deploys are orthogonal — use deploy-cic.sh
# equivalent or the operator can vite-build + jail_cic_build.sh
# separately).
#
# The script runs as root but delegates every build step to
# `su -l grappa -c '...'` so artifacts stay owned by the grappa user.
#
# Exit codes: 0 ok, non-zero on any failure (set -e).

set -eu

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4000/healthz}"
HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-30}"
HEALTHCHECK_SLEEP="${HEALTHCHECK_SLEEP:-2}"
RELOAD_URL="${RELOAD_URL:-http://127.0.0.1:4000/admin/reload}"

mode=auto
case "${1:-}" in
	--force-hot)  mode=hot ;;
	--force-cold) mode=cold ;;
	"")           mode=auto ;;
	*)
		echo "usage: $0 [--force-hot|--force-cold]" >&2
		exit 64
		;;
esac

# All build steps run as the grappa user. `su -l grappa -c` strips
# the environment (login shell), so MIX_OS_CONCURRENCY_LOCK and PATH
# must be re-set inside each invocation. PATH includes the Erlang
# bin dir explicitly so `mix` is found without depending on the
# grappa user's .profile.
run_as_grappa() {
	cmd="$1"
	su -l grappa -c "
		set -eu
		export PATH=/usr/local/lib/erlang28/bin:\$PATH
		export MIX_OS_CONCURRENCY_LOCK=0
		export MIX_ENV=prod
		cd '${REPO_ROOT}'
		${cmd}
	"
}

echo "[deploy] git pull --ff-only"
# Capture the pre-pull SHA so preflight can diff against the new HEAD
# regardless of how many commits ago the last deploy was. Read as the
# grappa user — root can't `git rev-parse` in a grappa-owned dir
# without `git config --global --add safe.directory ...`, which we'd
# rather not require host-wide. `run_as_grappa` already cd's to REPO_ROOT.
prev_sha=$(run_as_grappa 'git rev-parse HEAD' | tail -1)
run_as_grappa 'git pull --ff-only && git log --oneline -3'
new_sha=$(run_as_grappa 'git rev-parse HEAD' | tail -1)

if [ "${prev_sha}" = "${new_sha}" ]; then
	echo "[deploy] no commits since last HEAD (${prev_sha}) — nothing to do"
	exit 0
fi

# Self-modifying-deploy-script trap (live-repro 2026-05-31):
# `/bin/sh` may buffer the script file (read-ahead). If THIS deploy
# updates `infra/freebsd/deploy.sh` itself (via git pull above), the
# running shell continues executing the PRE-PULL bytes — every fix to
# the deploy pipeline silently no-ops on the first deploy that ships
# it. Re-exec ourselves so the NEW script bytes run for everything
# downstream of git-pull. Guard via DEPLOY_REEXECED env so we only
# re-exec once (otherwise infinite loop).
if [ -z "${DEPLOY_REEXECED:-}" ] && ! cmp -s "${REPO_ROOT}/infra/freebsd/deploy.sh" "$0" 2>/dev/null; then
	echo "[deploy] deploy.sh changed during git-pull — re-exec to load new bytes"
	export DEPLOY_REEXECED=1
	exec "${REPO_ROOT}/infra/freebsd/deploy.sh" "$@"
fi

# ---- Preflight (auto mode only; explicit --force-* skips) ----
#
# Source of truth: `lib/grappa/deploy/preflight.ex` (the Elixir module
# also drives scripts/deploy.sh on the Docker substrate). The shell side
# is a thin invoker — every classification rule lives in Elixir so
# substrate-specific deploy scripts cannot drift from each other.
#
# `mix run --no-start -e '...'` boots the BEAM without starting the
# application (so the preflight check doesn't accidentally talk to the
# live DB or take the supervision tree out from under the running
# release). ~2-3s of mix-boot cost is dwarfed by the multi-minute
# mix release --overwrite that follows in the cold path; for hot paths
# the cost is the worst-case overhead vs the saved restart downtime.
if [ "${mode}" = "auto" ]; then
	echo "[deploy] preflight: classifying ${prev_sha}..${new_sha}"
	if run_as_grappa "mix run --no-start -e 'Grappa.Deploy.Preflight.cli([\"${prev_sha}\", \"${new_sha}\"])'"; then
		mode=hot
	else
		mode=cold
	fi
elif [ "${mode}" = "hot" ]; then
	echo "[deploy] --force-hot: skipping preflight"
elif [ "${mode}" = "cold" ]; then
	echo "[deploy] --force-cold: skipping preflight"
fi

echo
echo "[deploy] ==> mode: ${mode}"
echo

echo "[deploy] mix deps.get --only prod"
run_as_grappa 'mix deps.get --only prod'

echo "[deploy] mix compile --warnings-as-errors"
run_as_grappa 'mix compile --warnings-as-errors'

# mix release --overwrite is REQUIRED in BOTH paths. The release puts
# fresh .beam in `_build/prod/rel/grappa/lib/grappa-X.Y/ebin/` which is
# exactly the directory the live daemon's `code:get_path/0` includes.
# Without this step the running BEAM would never see the new .beam even
# if POST /admin/reload runs — see `feedback_hot_deploy_silent_noop_prod`
# for the live-repro debugging.
echo "[deploy] mix release --overwrite"
run_as_grappa 'mix release --overwrite'

if [ "${mode}" = "hot" ]; then
	# Hot path: tell the live BEAM to walk :code.modified_modules/0
	# and reload via :code.load_file/1. The release rebuild above
	# already wrote the new .beam to the daemon's code path; this is
	# just the "now load them" signal. Live sessions keep state
	# (Erlang's 2-version code-loading guarantee).
	echo "[deploy] POST ${RELOAD_URL}"
	if response=$(curl -fsS -X POST "${RELOAD_URL}"); then
		echo "[deploy] reload response: ${response}"
		echo "[deploy] healthcheck loop (${HEALTHCHECK_URL})"
		i=0
		while [ "${i}" -lt "${HEALTHCHECK_RETRIES}" ]; do
			if curl -fsS -o /dev/null "${HEALTHCHECK_URL}"; then
				echo "[deploy] ✓ hot deploy complete (sessions preserved, daemon pid unchanged) after ${i} retries"
				exit 0
			fi
			i=$((i + 1))
			sleep "${HEALTHCHECK_SLEEP}"
		done
		echo "[deploy] ERROR: healthcheck never returned 200 after $((HEALTHCHECK_RETRIES * HEALTHCHECK_SLEEP))s post-reload"
		exit 1
	else
		echo "[deploy] ERROR: POST /admin/reload failed — daemon may be down or unreachable"
		exit 1
	fi
fi

# ---- Cold path ----

# cic bundle — vite build via npm. Required after a fresh `git clone`
# (runtime/cicchetto-dist/ is gitkeep-only) and on every deploy that
# touched cicchetto/src/. The nginx symlink /usr/local/www/cic →
# runtime/cicchetto-dist/ is set up once by jail_install_nginx.sh;
# an empty dist here makes nginx loop on `try_files $uri /index.html`
# (the "rewrite or internal redirection cycle" 500). Belt-and-braces:
# even when nothing in cicchetto/src/ changed, `npm run build` is fast
# (~40ms incremental). HOT path skips this — module reload doesn't need
# new cic; cic deploys are orthogonal (see jail_deploy_cic.sh).
#
# Shared with jail_cic_build.sh — one code path for the vite build +
# outDir, so an outDir tweak doesn't have to be applied in two places.
echo "[deploy] vite build (cicchetto bundle)"
"${REPO_ROOT}/infra/freebsd/jail_cic_build.sh"

echo "[deploy] Grappa.Release.migrate()"
# Delegate to jail_release.sh which has the canonical
# source-env-then-exec-bin/grappa flow (used by all other operator
# verbs against the live BEAM). One code path for the release entry
# point; deploy.sh does NOT re-implement env sourcing inline.
"${REPO_ROOT}/infra/freebsd/jail_release.sh" eval 'Grappa.Release.migrate()'

echo "[deploy] service grappa restart"
# epmd is started by the old BEAM but NOT killed on rc.d stop —
# next start sees `name grappa@grappa already in use` and refuses.
# Hard-kill epmd between stop and start to force a clean re-register.
#
# `service grappa stop` is ASYNCHRONOUS — it signals the BEAM daemon
# and returns immediately. The BEAM takes a few seconds to fully exit
# (drain sockets, run terminate callbacks, flush Logger). If we
# pkill epmd while the old BEAM is still alive, the BEAM may respawn
# epmd, and the new `service grappa start` then races against the
# still-registered old `grappa@grappa` node name → "name in use"
# refusal → BEAM crashes → deploy fails (live-repro 2026-05-31:
# deploy.sh ran stop+pkill+sleep1+start, then new BEAM crashed at
# 15:12:02 with "Protocol 'inet_tcp': the name grappa@grappa seems
# to be in use by another Erlang node" because the old BEAM was
# still alive + still registered when the new one tried to claim
# the same short-name).
#
# Wait-loop on the BEAM pid: poll until pgrep returns no match (or
# 20s timeout, then SIGKILL as a last resort). Only THEN pkill epmd
# + start fresh.
service grappa stop || true
i=0
while pgrep -q beam.smp 2>/dev/null; do
	if [ "${i}" -ge 20 ]; then
		echo "[deploy] WARNING: old BEAM didn't exit in 20s — SIGKILL"
		pkill -9 beam.smp 2>/dev/null || true
		sleep 1
		break
	fi
	i=$((i + 1))
	sleep 1
done
pkill epmd 2>/dev/null || true
sleep 1
service grappa start

echo "[deploy] healthcheck loop (${HEALTHCHECK_URL})"
i=0
while [ "${i}" -lt "${HEALTHCHECK_RETRIES}" ]; do
	if curl -fsS -o /dev/null "${HEALTHCHECK_URL}"; then
		echo "[deploy] ✓ cold deploy complete (sessions reset, daemon respawned) after ${i} retries"
		exit 0
	fi
	i=$((i + 1))
	sleep "${HEALTHCHECK_SLEEP}"
done

echo "[deploy] ERROR: healthcheck never returned 200 after $((HEALTHCHECK_RETRIES * HEALTHCHECK_SLEEP))s"
exit 1
