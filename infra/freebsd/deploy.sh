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
ENV_FILE="${ENV_FILE:-/usr/local/etc/grappa/grappa.env}"
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

# On re-exec (below), the pre-pull SHA from the FIRST invocation rides
# in via DEPLOY_PREV_SHA — the re-exec'd run re-pulls a no-op, so its
# own rev-parse-before-pull equals new_sha and the nothing-to-do check
# would wrongly exit 0, silently skipping the whole deploy.
prev_sha="${DEPLOY_PREV_SHA:-${prev_sha}}"

# Nothing-to-do requires ALL of: auto mode, no new commits, AND the
# last deploy completed (marker written as the final step of both
# paths below). "No new commits" alone is a lie when the previous
# deploy died mid-flight — live-repro 2026-06-10: a deploy was killed
# between `mix release` and the reload POST (SIGPIPE on the operator's
# ssh), leaving fresh beams on disk and a stale BEAM live; every
# re-run then exited "nothing to do" because the pull was a no-op, and
# prod had to be recovered by hand (rpc purge + load). And an explicit
# --force-* is an operator order, not a heuristic input — the fast
# path swallowing --force-cold left prod un-restarted on 2026-06-11
# (defect #8). Fast paths state what they OBSERVED: same HEAD +
# completed marker (+ which flag overrode), not "no work".
last_deployed=$(run_as_grappa "cat runtime/last-deployed-sha 2>/dev/null || true" | tail -1)

if [ "${prev_sha}" = "${new_sha}" ] && [ "${last_deployed}" = "${new_sha}" ]; then
	if [ "${mode}" = "auto" ]; then
		echo "[deploy] same HEAD (${new_sha}) + completed-deploy marker match — nothing to do"
		exit 0
	fi
	echo "[deploy] same HEAD (${new_sha}) + completed-deploy marker match, but --force-${mode} overrides — proceeding"
elif [ "${prev_sha}" = "${new_sha}" ]; then
	echo "[deploy] HEAD unchanged (${new_sha}) but last COMPLETED server deploy is '${last_deployed:-none}' — driving the gap (cic deploys advance HEAD without applying server changes; or a prior deploy died mid-flight)"
fi

# Self-modifying-deploy-script trap (live-repro 2026-05-31):
# git pull replaces files by rename, so the running /bin/sh keeps
# executing the PRE-PULL bytes from the old inode — every fix to the
# deploy pipeline silently no-ops on the first deploy that ships it.
# Re-exec ourselves so the NEW script bytes run for everything
# downstream of git-pull. Guard via DEPLOY_REEXECED env so we only
# re-exec once (otherwise infinite loop).
#
# Detection is by DIFF RANGE, not file comparison: the previous
# `cmp -s "${REPO_ROOT}/infra/freebsd/deploy.sh" "$0"` guard compared
# the post-pull file against itself ($0 IS the repo path under the
# documented bastille invocation) and could never fire (found in the
# 2026-06-10 substrate-preflight review).
if [ -z "${DEPLOY_REEXECED:-}" ] \
	&& run_as_grappa "git diff --name-only '${prev_sha}..${new_sha}'" | grep -qx 'infra/freebsd/deploy.sh'; then
	echo "[deploy] deploy.sh changed in ${prev_sha}..${new_sha} — re-exec to load new bytes"
	export DEPLOY_REEXECED=1
	export DEPLOY_PREV_SHA="${prev_sha}"
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
	# Preflight base: the last COMPLETED server deploy, not the
	# pre-pull HEAD. jail_deploy_cic.sh also git-pulls, so every cic
	# deploy advances the jail HEAD without applying server changes —
	# a pre-pull-HEAD base silently drops any server-side commit that
	# landed between two cic deploys (defect #7, live-repro
	# 2026-06-11: the runtime.exs COLD change vanished from the range,
	# the deploy went honestly-HOT over the wrong range, ~15 min
	# outage followed). The re-exec guard above deliberately KEEPS the
	# pre-pull HEAD: it answers "did THIS run's pull change the bytes
	# I am executing?" — running-bytes staleness, to which the marker
	# is irrelevant (a deploy.sh change pulled in by an earlier cic
	# deploy is already the file we were invoked from).
	preflight_base="${prev_sha}"
	if [ -n "${last_deployed}" ]; then
		# A garbage marker (truncated write, rewritten history) must
		# abort LOUDLY here with a fix-it hint — fed to git diff it
		# would crash the preflight oneshot with an opaque exit 1.
		# Deliberately NOT a silent fallback to prev_sha: that would
		# re-open the exact range hole this base exists to close.
		if run_as_grappa "git cat-file -e '${last_deployed}^{commit}'" 2>/dev/null; then
			preflight_base="${last_deployed}"
		else
			echo "[deploy] ERROR: runtime/last-deployed-sha contains '${last_deployed}' — not a commit in this repo" >&2
			echo "[deploy]   fix the marker (write the last deployed sha to runtime/last-deployed-sha) or rerun with an explicit --force-hot/--force-cold" >&2
			exit 1
		fi
	fi
	echo "[deploy] preflight: classifying ${preflight_base}..${new_sha}"
	# `mix run` under MIX_ENV=prod evaluates config/runtime.exs, which
	# raises on missing DATABASE_PATH & co. — the daemon gets those
	# from the env file via rc.d, but `su -l` login shells do not.
	# Source it the same way jail_release.sh does (set -a exports
	# every assignment), and refuse to run blind: an unreadable env
	# file would crash the oneshot, and a crash must never decide a
	# deploy mode (found live 2026-06-10 — the env-less preflight
	# exited 1 on every run, indistinguishable from a COLD verdict).
	if [ ! -r "${ENV_FILE}" ]; then
		echo "[deploy] ERROR: env file ${ENV_FILE} not readable — cannot run preflight" >&2
		exit 1
	fi
	preflight_rc=0
	run_as_grappa "set -a; . '${ENV_FILE}'; set +a; mix run --no-start -e 'Grappa.Deploy.Preflight.cli([\"${preflight_base}\", \"${new_sha}\", \"jail\"])'" || preflight_rc=$?
	case "${preflight_rc}" in
		0) mode=hot ;;
		3) mode=cold ;;
		*)
			# Mix crash (1), usage error (2), or anything else that is
			# not a verdict. Falling through to COLD would convert a
			# miswired call into a silent session-dropping restart on
			# every future deploy — the exact incident class the
			# substrate arg exists to kill.
			echo "[deploy] ERROR: preflight exited ${preflight_rc} (crash/usage, not a verdict) — aborting" >&2
			exit "${preflight_rc}"
			;;
	esac
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
		# HTTP 200 is NOT success — the endpoint reports per-module
		# failures in-band (e.g. :old_code_in_use when a process still
		# runs a prior hot-reload's old code; live-repro 2026-06-10 as
		# :not_purged). Declaring "✓ complete" over a failed reload
		# leaves prod silently running stale code.
		case "${response}" in
		*'"failed":[]'*) ;;
		*)
			echo "[deploy] ERROR: reload reported per-module failures (see response above)" >&2
			echo "[deploy]   old code in use? retry once processes settle, or schedule a cold window" >&2
			exit 1
			;;
		esac
		echo "[deploy] healthcheck loop (${HEALTHCHECK_URL})"
		i=0
		while [ "${i}" -lt "${HEALTHCHECK_RETRIES}" ]; do
			if curl -fsS -o /dev/null "${HEALTHCHECK_URL}"; then
				run_as_grappa "printf '%s\n' '${new_sha}' > runtime/last-deployed-sha"
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

echo "[deploy] service grappa stop"
# The rc.d wrapper's stop is synchronous since defect #9 (2026-06-11
# outage): it blocks until the BEAM has exited AND epmd released the
# node name (jail_beam_wait.sh — the full stop/start race lore lives
# there). Re-assert both conditions here anyway: the rc.d refresh
# below runs BETWEEN stop and start, so any deploy that ships an rc.d
# fix stops through the PREVIOUSLY INSTALLED wrapper — possibly one
# that still returns mid-drain — and a timed-out wrapper wait must
# never race the start. Same helper, second call site; instant when
# the wrapper already waited.
service grappa stop || true
"${REPO_ROOT}/infra/freebsd/jail_beam_wait.sh" wait-stopped grappa 20

# rc.d wrappers: refresh from the repo BETWEEN stop and start, so the
# OLD daemon was stopped through the wrapper that started it and the
# new daemon boots through the NEW wrapper. Delegates to
# jail_install_rcd.sh — the existing idempotent installer (one code
# path, same convention as the jail_cic_build.sh + jail_release.sh
# delegations above); it refreshes BOTH wrappers (grappa +
# grappa_ndp_keepalive) and leaves existing rc.conf.d files alone.
# An rc.d/grappa diff classifies COLD on the jail (Preflight class
# :rc_d), so this is what makes a shipped wrapper change actually
# take effect — replaces the manual cp+restart step that bit on
# 2026-06-10 (rc(8) PATH fix shipped in the repo, prod kept 422ing
# until the wrapper was hand-copied). Runs as root: rc.d scripts are
# root:wheel 0555, the build user can't write there.
echo "[deploy] refresh rc.d wrappers (jail_install_rcd.sh)"
"${REPO_ROOT}/infra/freebsd/jail_install_rcd.sh"

service grappa start

echo "[deploy] healthcheck loop (${HEALTHCHECK_URL})"
i=0
while [ "${i}" -lt "${HEALTHCHECK_RETRIES}" ]; do
	if curl -fsS -o /dev/null "${HEALTHCHECK_URL}"; then
		run_as_grappa "printf '%s\n' '${new_sha}' > runtime/last-deployed-sha"
		echo "[deploy] ✓ cold deploy complete (sessions reset, daemon respawned) after ${i} retries"
		exit 0
	fi
	i=$((i + 1))
	sleep "${HEALTHCHECK_SLEEP}"
done

echo "[deploy] ERROR: healthcheck never returned 200 after $((HEALTHCHECK_RETRIES * HEALTHCHECK_SLEEP))s"
exit 1
