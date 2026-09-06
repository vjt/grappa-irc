# shellcheck shell=sh
# infra/lib/deploy_common.sh — shared POSIX-sh deploy algorithm (#503).
#
# The SINGLE source of truth for the hot-vs-cold deploy ALGORITHM shared
# by every production substrate: infra/freebsd/deploy.sh (bastille jail),
# infra/linux/deploy.sh (systemd host), scripts/deploy.sh (operator
# Docker).
# Why: docs/OPERATIONS.md § "The shared deploy library (infra/lib/)" (#503).
#
# This file is SOURCED, never executed. It is strict POSIX sh — no bash
# arrays, no `[[ ]]`, no `local`, so `dash`/`sh` can run it on the jail.
# Consumers keep their own shebangs (jail = /bin/sh, linux/docker = bash)
# and may use bashisms in their OWN hooks.
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
# write.
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
#   substrate_seed            materialise versioned built-in data into the DB
#                             (both paths; MUST be idempotent; non-fatal)
#   substrate_reload          echoes /admin/reload HTTP body; nonzero=POST failed
#   substrate_cic             cic bundle build (cold only)
#   substrate_migrate         ecto migrate (cold only)
#   substrate_restart         stop/start the daemon (cold only; may exit on defer)
#   substrate_healthcheck     one /healthz probe; 0=200, nonzero=not yet AND
#                             stdout carries whatever the substrate could learn
#                             about WHY (the 503 body, the curl error) — see
#                             _deploy_healthcheck_loop
#   substrate_service_alive   0 iff the daemon/container/unit is running RIGHT
#                             NOW; asked only when the healthcheck budget ran
#                             out (#1656)
#   substrate_done_banner N   print the success line (N = retries taken);
#                             the wording is substrate-specific
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
# ── The one toggle that defaults ON ─────────────────────────────────
#   DEPLOY_FEATURE_SEED           run substrate_seed on BOTH paths (default 1)
#
# Every toggle above is a CAPABILITY a substrate may legitimately lack, so
# it defaults OFF and the consumer opts in. Seeding is a CORRECTNESS
# property (#440): it defaults ON, a substrate must opt OUT, and there is
# deliberately NO fallback substrate_seed — an undefined hook must break
# loudly in CI, not quietly seed nothing.
#
# ── Mode state exported to hooks ────────────────────────────────────
#   MODE      auto|hot|cold (resolved before any build/restart hook runs)
#   DEFER     0|1 (--defer-restart requested)
#   PREV_SHA  pre-pull HEAD (post-carry)
#   NEW_SHA   post-pull HEAD (or the token the consumer diffs `to`)

# ---- config defaults (consumer overrides before deploy_main) --------
: "${HEALTHCHECK_RETRIES:=30}"
: "${HEALTHCHECK_SLEEP:=2}"

# Per-mode healthcheck override, resolved at loop time so a consumer only
# sets what actually diverges from the shared defaults above (jail/linux
# leave these unset; Docker's hot loop is short and its cold loop long).
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
: "${DEPLOY_FEATURE_SEED:=1}"

# Set by _deploy_seed when the seed hook failed, read by the post-banner
# re-assert. Not a toggle — deploy state.
DEPLOY_SEED_FAILED=0

# Path (repo-relative) of the consumer deploy script, for the re-exec
# guard's diff match and the `exec` target. The lib appends its OWN path
# so a change to the shared algorithm re-execs too.
: "${DEPLOY_SELF_REL:=}"
DEPLOY_LIB_REL="infra/lib/deploy_common.sh"

# Argument(s) the re-exec guard must PREPEND when it re-invokes the
# consumer script. Empty for a verb-less consumer (jail/linux/operator
# docker), so re-exec replays the argv verbatim. A verb-dispatched
# consumer (infra/docker/deploy.sh `update …`) sets its verb here — else
# the guard drops the verb and the re-exec'd run falls through to a usage
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
# HEAD. A present-but-garbage marker aborts LOUDLY here rather than
# falling back to prev_sha.
# Why: docs/OPERATIONS.md § "The shared deploy library (infra/lib/)" (defect #7).
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
# (marker == HEAD). "No new commits" alone is not enough, and an explicit
# --force-* is an operator order, not a heuristic input.
# Why: docs/OPERATIONS.md § "The shared deploy library (infra/lib/)" (defect #8).
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
# Re-exec so the POST-pull bytes run, when the pull's DIFF RANGE touched
# the consumer script OR this shared lib. Keyed on the PRE-PULL range
# (prev..new), NOT the marker range — the question is "did THIS pull
# change the bytes I am running?".
# Why: docs/OPERATIONS.md § "The shared deploy library (infra/lib/)".
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
#
# The probe's output is CAPTURED, not discarded (#1656). /healthz answers a
# non-200 with a body naming the failing check (`ready` / `repo` / `ets`) and
# its reason, and a connection error carries curl's own diagnosis — that is
# the only evidence of WHY a deploy went red, and it used to go to
# /dev/null 30 times in a row. The last answer is printed once, in the
# failure arm, where the operator is already reading.
_deploy_healthcheck_loop() {
	retries="$1"
	sleep_s="$2"
	deploy_log "healthcheck loop ($retries x ${sleep_s}s)"
	i=0
	hc_answer=""
	while [ "$i" -lt "$retries" ]; do
		if hc_answer=$(substrate_healthcheck 2>&1); then
			if [ "$DEPLOY_FEATURE_MARKER" = 1 ]; then
				substrate_write_marker
			fi
			substrate_done_banner "$i"
			_deploy_seed_reassert
			exit 0
		fi
		i=$((i + 1))
		sleep "$sleep_s"
	done
	deploy_error "healthcheck never returned 200 after $((retries * sleep_s))s"
	if [ -n "$hc_answer" ]; then
		printf '[deploy]   last /healthz answer: %s\n' "$hc_answer" >&2
	fi
	_deploy_report_liveness
	exit 1
}

# ---- liveness report on an exhausted healthcheck budget (#1656) ------
# "The healthcheck failed" and "production is DOWN" are different
# emergencies, and until now they printed the same sentence. Measured: the
# v1.3.0 cold deploy on m42 (2026-08-21) exited `healthcheck never returned
# 200 after 60s` while the node had already terminated — an operator who did
# not go and look at the jail was holding a message about the wrong problem.
#
# This REPORTS, it never acts. Restarting production is the operator's
# decision: a deploy that restarts what it just failed to health-check can
# drive a crash-loop straight back into the outage it is standing in.
: "${DEPLOY_RESTART_HINT:=the service manager on this substrate}"

_deploy_report_liveness() {
	# A consumer that predates this hook must not be read as "the daemon is
	# dead" — an undefined function returns 127, which would fire the loudest
	# alarm we own on no evidence at all. `infra/docker/get.sh` mirrors the lib
	# and the consumer separately, so old-consumer/new-lib is reachable.
	if ! command -v substrate_service_alive >/dev/null 2>&1; then
		deploy_error "this substrate defines no substrate_service_alive hook — whether the daemon survived is UNKNOWN. Check it by hand before walking away."
		return 0
	fi

	if substrate_service_alive; then
		deploy_error "the daemon is still RUNNING — it is up but not answering a healthy /healthz. Production is serving; read the answer above before touching anything."
	else
		deploy_error "the daemon is GONE — PRODUCTION IS DOWN. The healthcheck failure above is the symptom; this is the emergency."
		printf '[deploy]   nothing was restarted — that is your call, not the deploy'"'"'s. Bring it back with: %s\n' "${DEPLOY_RESTART_HINT}" >&2
	fi
}

# ---- seed (versioned built-in data) ---------------------------------
# Materialise the versioned built-in data (the theme gallery) into the DB
# on EVERY deploy, BOTH paths. The hook must be idempotent.
# Why: docs/OPERATIONS.md § "The shared deploy library (infra/lib/)" (#440).
#
# The label is shared (one seed set, substrate-independent); only the
# retry command differs per substrate, so only that is a consumer knob.
: "${DEPLOY_SEED_LABEL:=the built-in theme gallery}"
: "${DEPLOY_SEED_RETRY_HINT:=the grappa.seed_themes task on this substrate}"

# NON-FATAL, deliberately: aborting here would leave a migrated DB and no
# restart. Not a silent swallow either — the upsert converges, so the NEXT
# deploy re-runs the seed and heals it.
_deploy_seed() {
	[ "$DEPLOY_FEATURE_SEED" = 1 ] || return 0
	deploy_log "seeding ${DEPLOY_SEED_LABEL} (idempotent)"
	if ! substrate_seed; then
		DEPLOY_SEED_FAILED=1
		deploy_error "seeding failed — ${DEPLOY_SEED_LABEL} was NOT materialised. The deploy continues (the box is healthy; the gallery may be missing or stale)."
		printf '[deploy]   retry with: %s\n' "${DEPLOY_SEED_RETRY_HINT}" >&2
	fi
}

# Re-assert after the ✓ banner, gated on the OUTCOME: the last thing on
# the operator's screen must not be an unqualified success line when
# something did not get applied.
_deploy_seed_reassert() {
	[ "$DEPLOY_SEED_FAILED" = 1 ] || return 0
	deploy_error "reminder: ${DEPLOY_SEED_LABEL} was NOT seeded during this deploy — retry with: ${DEPLOY_SEED_RETRY_HINT}"
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
		# Every substrate_reload uses `curl -f`, which discards the
		# response body on a non-2xx — so this branch knows the POST
		# failed and NOTHING about why. Name both live causes.
		deploy_error "POST /admin/reload failed"
		printf '[deploy]   the daemon is down/unreachable, OR it refused the hot reload\n' >&2
		# Since #1348 a 409 has two causes and they need OPPOSITE moves,
		# so naming only the first sends the operator to restart
		# production for a defect a restart walks straight back into.
		printf '[deploy]   HTTP 409, cause 1: a pending migration is CONTRACT → run a cold deploy\n' >&2
		printf '[deploy]   HTTP 409, cause 2: two files claim one migration version — a\n' >&2
		printf '[deploy]   cold deploy will not help, the duplicate must be resolved in the repo\n' >&2
		# Since #1850 a third cause, and it is the one that used to be
		# SILENT: on a release substrate the beams just built are in
		# lib/grappa-<new>/ebin while the daemon still reads its boot
		# directory, so the reload would have loaded nothing and said so
		# in a shape indistinguishable from "nothing to do".
		printf '[deploy]   HTTP 409, cause 3: the daemon reads lib/grappa-<booted>/ebin and this\n' >&2
		printf '[deploy]   build wrote lib/grappa-<new>/ebin (a VERSION bump) → run a cold deploy\n' >&2
		exit 1
	fi

	# AFTER the reload: since #41 the hot path is not migration-free —
	# POST /admin/reload applies pending expand migrations and only THEN
	# loads modules, so a seed before it would run against the
	# PRE-migration schema. After the reload-honesty check too: a reload
	# that did not take must not be seeded into.
	_deploy_seed

	_deploy_healthcheck_loop "$(_deploy_hot_retries)" "$(_deploy_hot_sleep)"
}

# ---- cold path ------------------------------------------------------
_deploy_cold() {
	substrate_cic
	substrate_migrate
	# AFTER the migrator: a built-in whose payload needs a column added in
	# the same deploy would crash a seed that ran ahead of the schema.
	# BEFORE the restart: --defer-restart stops in substrate_restart, and a
	# staged deploy must stage a seeded DB too.
	_deploy_seed
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

	# #1851 — every substrate_pull spells this `git pull --ff-only
	# --recurse-submodules=on-demand`, and the flag is load-bearing.
	#
	# A bare `--ff-only` advances the SUPERPROJECT and leaves every submodule
	# working tree exactly where it was, so a single gitlink bump dirties a
	# deploy checkout PERMANENTLY — nothing downstream ever syncs it back.
	# `Grappa.Version.GitProbe` snapshots `git status --porcelain` at compile
	# time, so that stale gitlink turned three consecutive prod releases into
	# the unreleased form (`1.4.0-596d5ea0`, `1.4.1-997711ac`,
	# `1.5.0-35e9fca6`) and left #391's "this build is NOT the tag" signal
	# permanently on, discriminating nothing.
	#
	# `=on-demand` and NOT a bare `--recurse-submodules`, measured: the bare
	# form is `=yes`, which fetches every submodule on EVERY pull, so a box
	# that cannot reach the submodule remote goes from "deploys fine until
	# the gitlink moves" to "never deploys". `on-demand` IS git's own fetch
	# default, so the FETCH half of the pull is byte-for-byte what it already
	# does and only the CHECKOUT half is new — the flag cannot introduce a
	# failure the current pull does not already have (measured: with the
	# submodule remote unreachable and its objects absent, both spellings
	# exit 1 with the same "Errors during submodule fetch" and leave the
	# superproject un-advanced).
	#
	# It is also a no-op on a checkout that never initialised the submodule,
	# which is what a plain `git clone` leaves behind — so it does NOT drag a
	# test-only testnet onto a production box that does not have one.
	deploy_log "git pull --ff-only --recurse-submodules=on-demand"
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

	# Install the artifacts the substrate keeps OUTSIDE the repo (privilege
	# wrappers and the config they read) on BOTH paths, after the build and
	# before either the reload or the restart, so the new code never meets
	# the old artifact. Classification cannot do it: it only sees changed
	# PATHS. The hook must be idempotent: it runs every deploy.
	# Why: docs/OPERATIONS.md § "The shared deploy library (infra/lib/)" (#646).
	if [ "$DEPLOY_FEATURE_RECONCILE" = 1 ]; then
		substrate_reconcile
	fi

	if [ "$MODE" = hot ]; then
		_deploy_hot
	else
		_deploy_cold
	fi
}
