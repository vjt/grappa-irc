# shellcheck shell=sh
# infra/lib/deploy_common.sh — shared POSIX-sh deploy algorithm (#503).
#
# The SINGLE source of truth for the hot-vs-cold deploy ALGORITHM shared
# by every production substrate: infra/freebsd/deploy.sh (bastille jail),
# infra/linux/deploy.sh (systemd host), scripts/deploy.sh (operator
# Docker). Extracted to KILL copy-paste drift — the 2026-06-11 outage
# root cause was three near-identical deploy scripts drifting apart
# (defects #7/#8/#9, all "fixed in one script, still live in another").
#
# This file is SOURCED, never executed. It is strict POSIX sh — no bash
# arrays, no `[[ ]]`, no `local`. Consumers keep their own shebangs
# (jail = /bin/sh, linux/docker = bash) and may use bashisms in their
# OWN hooks; the shared algorithm below stays POSIX so `dash`/`sh` can
# run it on the jail.
#
# ── Contract ────────────────────────────────────────────────────────
# A consumer script:
#   1. sets config vars (REPO_ROOT, HEALTHCHECK_*, DEPLOY_SELF_REL, …)
#   2. flips the feature toggles it wants ON (see below)
#   3. defines the substrate hooks (see below)
#   4. sources this file
#   5. calls `deploy_main "$@"`
#
# The lib OWNS (substrate-independent): flag parse, DEPLOY_PREV_SHA carry
# across re-exec, the re-exec guard, the marker base-select + validate,
# the nothing-to-do predicate, the preflight verdict→mode mapping, the
# reload "failed":[] honesty check, the healthcheck loop, and the marker
# write. Every one of those is a documented invariant that previously
# lived — and drifted — per script.
#
# The consumer OWNS (substrate hooks — the 20% that genuinely differ):
#   substrate_pull            sets PREV_SHA + NEW_SHA globals (git pull)
#   substrate_read_marker     echoes runtime/last-deployed-sha (or empty)
#   substrate_write_marker    writes NEW_SHA to runtime/last-deployed-sha
#   substrate_commit_exists S returns 0 iff S names a commit in the repo
#   substrate_changed_files A B  echoes `git diff --name-only A..B`
#   substrate_preflight F T   runs the Preflight oneshot; exit 0=hot 3=cold
#   substrate_build           deps/compile/release, or image build
#   substrate_reconcile       install out-of-repo artifacts (both paths; opt-in
#                             via DEPLOY_FEATURE_RECONCILE; MUST be idempotent)
#   substrate_reload          echoes /admin/reload HTTP body; nonzero=POST failed
#   substrate_cic             cic bundle build (cold only)
#   substrate_migrate         ecto migrate (cold only)
#   substrate_restart         stop/start the daemon (cold only; may exit on defer)
#   substrate_healthcheck     one /healthz probe; 0=200, nonzero=not yet
#   substrate_done_banner N   print the success line (N = retries taken); the
#                             wording is substrate-specific (sessions preserved
#                             vs container recreated vs daemon respawned)
#
# ── Feature toggles (consumer sets to 1 to enable; default OFF) ──────
#   DEPLOY_FEATURE_FORCE_FLAGS    accept --force-hot / --force-cold
#   DEPLOY_FEATURE_DEFER          accept --defer-restart (cold-only)
#   DEPLOY_FEATURE_NOTHING_TO_DO  marker-gated nothing-to-do fast path
#   DEPLOY_FEATURE_REEXEC         self-modifying-script re-exec guard
#   DEPLOY_FEATURE_MARKER         read/write runtime/last-deployed-sha
#   DEPLOY_FEATURE_PREV_SHA_CARRY carry DEPLOY_PREV_SHA across re-exec
#   DEPLOY_FEATURE_RECONCILE      run substrate_reconcile on BOTH paths
#
# ── Mode state exported to hooks ────────────────────────────────────
#   MODE      auto|hot|cold (resolved before any build/restart hook runs)
#   DEFER     0|1 (--defer-restart requested)
#   PREV_SHA  pre-pull HEAD (post-carry)
#   NEW_SHA   post-pull HEAD (or the token the consumer diffs `to`)

# ---- config defaults (consumer overrides before deploy_main) --------
: "${HEALTHCHECK_RETRIES:=30}"
: "${HEALTHCHECK_SLEEP:=2}"

# Per-mode healthcheck override (Docker's hot loop is fast/short, its
# cold loop long — jail/linux leave these unset and fall back to the
# shared defaults above). Resolved at loop time so a consumer only sets
# what actually diverges.
_deploy_hot_retries()  { printf '%s' "${HOT_HEALTHCHECK_RETRIES:-$HEALTHCHECK_RETRIES}"; }
_deploy_hot_sleep()    { printf '%s' "${HOT_HEALTHCHECK_SLEEP:-$HEALTHCHECK_SLEEP}"; }
_deploy_cold_retries() { printf '%s' "${COLD_HEALTHCHECK_RETRIES:-$HEALTHCHECK_RETRIES}"; }
_deploy_cold_sleep()   { printf '%s' "${COLD_HEALTHCHECK_SLEEP:-$HEALTHCHECK_SLEEP}"; }

: "${DEPLOY_FEATURE_FORCE_FLAGS:=0}"
: "${DEPLOY_FEATURE_DEFER:=0}"
: "${DEPLOY_FEATURE_NOTHING_TO_DO:=0}"
: "${DEPLOY_FEATURE_REEXEC:=0}"
: "${DEPLOY_FEATURE_MARKER:=0}"
: "${DEPLOY_FEATURE_PREV_SHA_CARRY:=0}"
: "${DEPLOY_FEATURE_RECONCILE:=0}"

# Path (repo-relative) of the consumer deploy script, for the re-exec
# guard's diff match and the `exec` target. The lib appends its OWN path
# so a change to the shared algorithm re-execs too (behavior-preserving:
# the extracted bytes must reload exactly as the inlined bytes did).
: "${DEPLOY_SELF_REL:=}"
DEPLOY_LIB_REL="infra/lib/deploy_common.sh"

# Argument(s) the re-exec guard must PREPEND when it re-invokes the
# consumer script. Empty for a verb-less consumer (jail/linux/operator
# docker: `deploy.sh --force-hot`), so re-exec replays the argv verbatim.
# A verb-dispatched consumer (infra/docker/deploy.sh `update …`) sets this
# to its verb so re-exec replays `deploy.sh update …` — else the guard
# would drop the verb and the re-exec'd run would fall through to a usage
# error. Word-split on purpose (a single verb token).
: "${DEPLOY_REEXEC_PREFIX:=}"

# ---- logging --------------------------------------------------------
deploy_log()   { printf '[deploy] %s\n' "$*"; }
deploy_error() { printf '[deploy] ERROR: %s\n' "$*" >&2; }

deploy_usage() {
	printf 'usage: %s %s\n' "$0" "${DEPLOY_USAGE:-[--force-hot|--force-cold]}" >&2
	exit 64
}

_deploy_defer_hot_error() {
	printf 'usage: --defer-restart is only valid on the cold path (not with a hot deploy)\n' >&2
	exit 64
}

# ---- flag parse -----------------------------------------------------
# Sets MODE + DEFER. Toggle-gated: a flag the consumer did not enable is
# an unknown flag → usage error, same as garbage.
_deploy_parse_flags() {
	MODE=auto
	DEFER=0
	while [ $# -gt 0 ]; do
		case "$1" in
			--force-hot)
				[ "$DEPLOY_FEATURE_FORCE_FLAGS" = 1 ] || deploy_usage
				MODE=hot
				;;
			--force-cold)
				[ "$DEPLOY_FEATURE_FORCE_FLAGS" = 1 ] || deploy_usage
				MODE=cold
				;;
			--defer-restart)
				[ "$DEPLOY_FEATURE_DEFER" = 1 ] || deploy_usage
				DEFER=1
				;;
			*) deploy_usage ;;
		esac
		shift
	done
}

# ---- marker validate (shape + real commit) --------------------------
_deploy_marker_valid() {
	m="$1"
	[ "${#m}" -eq 40 ] || return 1
	case "$m" in
		*[!0-9a-f]*) return 1 ;;
	esac
	substrate_commit_exists "$m"
}

# Echo the preflight range base: the marker when valid, else the pre-pull
# HEAD. A present-but-garbage marker aborts LOUDLY here — a silent
# fallback to prev_sha would re-open the range hole the marker closes
# (defect #7), and feeding garbage to `git diff` would crash the oneshot
# with an opaque exit 1 the verdict case-statement can't interpret.
_deploy_preflight_base() {
	base="$PREV_SHA"
	if [ "$DEPLOY_FEATURE_MARKER" = 1 ] && [ -n "$LAST_DEPLOYED" ]; then
		if _deploy_marker_valid "$LAST_DEPLOYED"; then
			base="$LAST_DEPLOYED"
		else
			deploy_error "runtime/last-deployed-sha contains '$LAST_DEPLOYED' — not a full sha of a commit in this repo"
			printf '[deploy]   fix the marker (write the last deployed sha) or rerun with an explicit --force-hot/--force-cold\n' >&2
			exit 1
		fi
	fi
	printf '%s' "$base"
}

# ---- nothing-to-do (marker-gated) -----------------------------------
# Exits 0 ONLY when auto + no new commits + the last deploy COMPLETED
# (marker == HEAD). "No new commits" alone lies when a prior deploy died
# mid-flight (defect #8), and an explicit --force-* is an operator order,
# not a heuristic input. Fast paths state what they OBSERVED.
_deploy_nothing_to_do() {
	if [ "$PREV_SHA" = "$NEW_SHA" ] && [ "$LAST_DEPLOYED" = "$NEW_SHA" ]; then
		if [ "$MODE" = auto ]; then
			deploy_log "same HEAD ($NEW_SHA) + completed-deploy marker match — nothing to do"
			exit 0
		fi
		deploy_log "same HEAD ($NEW_SHA) + completed-deploy marker match, but --force-$MODE overrides — proceeding"
	elif [ "$PREV_SHA" = "$NEW_SHA" ]; then
		deploy_log "HEAD unchanged ($NEW_SHA) but last COMPLETED server deploy is '${LAST_DEPLOYED:-none}' — driving the gap (a cic-only deploy advances HEAD without applying server changes; or a prior deploy died mid-flight)"
	fi
}

# ---- re-exec guard (self-modifying script) --------------------------
# git pull replaces files by rename, so the running interpreter keeps
# executing PRE-PULL bytes from the old inode — a fix to the deploy
# pipeline would silently no-op on the first deploy that ships it
# (live-repro 2026-05-31). Re-exec so the NEW bytes run downstream of
# the pull. Detection is by DIFF RANGE touching the consumer script OR
# this shared lib. Keyed on the PRE-PULL range (prev..new), NOT the
# marker range — this answers "did THIS pull change the bytes I am
# running?", to which the marker is irrelevant.
_deploy_reexec_guard() {
	[ -z "${DEPLOY_REEXECED:-}" ] || return 0
	changed=$(substrate_changed_files "$PREV_SHA" "$NEW_SHA")
	case "
$changed
" in
		*"
$DEPLOY_SELF_REL
"*|*"
$DEPLOY_LIB_REL
"*)
			deploy_log "deploy code changed in $PREV_SHA..$NEW_SHA — re-exec to load new bytes"
			DEPLOY_REEXECED=1
			export DEPLOY_REEXECED
			if [ "$DEPLOY_FEATURE_PREV_SHA_CARRY" = 1 ]; then
				DEPLOY_PREV_SHA="$PREV_SHA"
				export DEPLOY_PREV_SHA
			fi
			# shellcheck disable=SC2086  # DEPLOY_REEXEC_PREFIX is an intentional verb prefix (empty → verbatim replay)
			exec "$REPO_ROOT/$DEPLOY_SELF_REL" $DEPLOY_REEXEC_PREFIX "$@"
			;;
	esac
}

# ---- preflight verdict → mode ---------------------------------------
_deploy_resolve_mode() {
	if [ "$MODE" != auto ]; then
		deploy_log "--force-$MODE: skipping preflight"
		return 0
	fi
	base=$(_deploy_preflight_base)
	deploy_log "preflight: classifying $base..$NEW_SHA"
	rc=0
	substrate_preflight "$base" "$NEW_SHA" || rc=$?
	case "$rc" in
		0) MODE=hot ;;
		3) MODE=cold ;;
		*)
			# Not a verdict (mix crash 1, usage 2, …). Falling through to
			# cold silently converts a miswired call into "always restart";
			# to hot, into "never restart". Neither is a valid guess.
			deploy_error "preflight exited $rc (crash/usage, not a verdict) — aborting"
			exit "$rc"
			;;
	esac
}

# ---- healthcheck loop (owns marker write on first 200) --------------
# $1 retries, $2 sleep. Writes the completed-deploy marker on the first
# 200 (gated on the MARKER feature) — the marker is the "deploy fully
# applied" barrier, so it is written LAST, after the app answers.
_deploy_healthcheck_loop() {
	retries="$1"
	sleep_s="$2"
	deploy_log "healthcheck loop ($retries x ${sleep_s}s)"
	i=0
	while [ "$i" -lt "$retries" ]; do
		if substrate_healthcheck; then
			if [ "$DEPLOY_FEATURE_MARKER" = 1 ]; then
				substrate_write_marker
			fi
			# Substrate-specific success wording (sessions preserved vs
			# container recreated vs daemon respawned) — the consumer owns
			# it; $1 = retries taken.
			substrate_done_banner "$i"
			exit 0
		fi
		i=$((i + 1))
		sleep "$sleep_s"
	done
	deploy_error "healthcheck never returned 200 after $((retries * sleep_s))s"
	exit 1
}

# ---- hot path -------------------------------------------------------
_deploy_hot() {
	if response=$(substrate_reload); then
		deploy_log "reload response: $response"
		# HTTP 200 is NOT success — the endpoint reports per-module
		# failures IN-BAND. Declaring "✓ complete" over a failed reload
		# leaves prod silently on stale code.
		case "$response" in
			*'"failed":[]'*) ;;
			*)
				deploy_error "reload reported per-module failures (see response above)"
				printf '[deploy]   old code in use? retry once processes settle, or run a cold deploy\n' >&2
				exit 1
				;;
		esac
	else
		deploy_error "POST /admin/reload failed — daemon may be down or unreachable"
		exit 1
	fi
	_deploy_healthcheck_loop "$(_deploy_hot_retries)" "$(_deploy_hot_sleep)"
}

# ---- cold path ------------------------------------------------------
_deploy_cold() {
	substrate_cic
	substrate_migrate
	# substrate_restart may `exit 0` on --defer-restart (staged, not
	# started) — in which case the marker is deliberately NOT written.
	substrate_restart
	_deploy_healthcheck_loop "$(_deploy_cold_retries)" "$(_deploy_cold_sleep)"
}

# ---- orchestrator ---------------------------------------------------
deploy_main() {
	_deploy_parse_flags "$@"

	# --defer-restart needs a stop; a hot deploy has none. Catch the
	# statically-known case (--force-hot) before any side effect; the
	# auto→hot case is caught again after preflight resolves the mode.
	if [ "$DEFER" = 1 ] && [ "$MODE" = hot ]; then
		_deploy_defer_hot_error
	fi

	deploy_log "git pull --ff-only"
	substrate_pull

	if [ "$DEPLOY_FEATURE_PREV_SHA_CARRY" = 1 ]; then
		# On re-exec the pre-pull SHA from the FIRST invocation rides in
		# via DEPLOY_PREV_SHA — the re-exec'd run re-pulls a no-op, so its
		# own prev==new and the nothing-to-do check would wrongly exit 0.
		PREV_SHA="${DEPLOY_PREV_SHA:-$PREV_SHA}"
	fi

	LAST_DEPLOYED=""
	if [ "$DEPLOY_FEATURE_MARKER" = 1 ]; then
		LAST_DEPLOYED=$(substrate_read_marker)
	fi

	if [ "$DEPLOY_FEATURE_NOTHING_TO_DO" = 1 ]; then
		_deploy_nothing_to_do
	fi

	if [ "$DEPLOY_FEATURE_REEXEC" = 1 ]; then
		_deploy_reexec_guard "$@"
	fi

	_deploy_resolve_mode

	# auto→hot + --defer-restart: same invariant as the top guard, now
	# that preflight has resolved the mode.
	if [ "$DEFER" = 1 ] && [ "$MODE" = hot ]; then
		_deploy_defer_hot_error
	fi

	echo
	deploy_log "==> mode: $MODE"
	echo

	substrate_build

	# Artifacts the substrate installs OUTSIDE the repo (privilege
	# wrappers and the config they read) drift from the checkout unless
	# something reconciles them. Classification cannot do it: it only sees
	# changed PATHS, so it misses a config rendered from the DB, and it
	# would charge a session-dropping cold restart just to copy a file
	# (#646 — shipping #610 left the old wrapper installed and disarmed
	# mode 2 in prod). So it runs on BOTH paths, after the build and
	# before either the reload or the restart, so the new code never meets
	# the old artifact. The hook must be idempotent: it runs every deploy.
	if [ "$DEPLOY_FEATURE_RECONCILE" = 1 ]; then
		substrate_reconcile
	fi

	if [ "$MODE" = hot ]; then
		_deploy_hot
	else
		_deploy_cold
	fi
}
