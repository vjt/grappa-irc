# shellcheck shell=sh
# infra/lib/cic_dist.sh — build BESIDE the served cic bundle, then swap (#1020).
#
# Every substrate used to point vite's `outDir` straight at the directory the
# running BEAM serves (`Grappa.Cic.Bundle.root/0` → Plug.Static + the SPA
# history-fallback, resolved per REQUEST). Vite empties `outDir` before it
# writes anything, so the served tree went EMPTY at the start of the build and
# stayed incomplete until it finished: for that whole window the SPA did not
# load at all, and a build that FAILED left it empty for good.
#
# `--emptyOutDir` is not the defect — the cleanup is wanted (vite emits
# content-hashed chunks; without it every deploy accretes the previous bundle's
# assets forever) and the flag is only vite's consent prompt for an out-of-root
# `outDir`. The TIMING is the defect. So: build into a sibling nobody serves,
# then rename it into place.
#
# This file is SOURCED, never executed — POSIX sh, no `local`, no bashisms, so
# the FreeBSD jail's /bin/sh build body can source it as-is (same contract as
# beam_wait.sh / deploy_common.sh).
#
# Consumers (one algorithm, no per-substrate copy):
#   - infra/freebsd/jail_cic_build.sh   npm + vite, inside `su -l grappa`
#   - infra/linux/cic_build.sh          bun + vite, via `sudo -u grappa`
#   - scripts/deploy.sh                 the compose oneshot (dev/operator)
#   - scripts/deploy-cic.sh             the compose oneshot, cic-only deploy
#   - infra/docker/deploy.sh            the compose oneshot, standalone install
#
# infra/packaging/build.sh is NOT a consumer: it already builds into a staging
# tree under `staging/usr/share/grappa/` that no server is serving. It is the
# shape this lib generalises.
#
# ## The swap, and its failure window
#
# `mv` is rename(2) — atomic per call, but there is no portable two-directory
# EXCHANGE (Linux's RENAME_EXCHANGE is not reachable from sh, and FreeBSD has
# no equivalent), so the promote is two renames:
#
#     mv <served> <served>.prev     # served path momentarily ABSENT
#     mv <staged> <served>
#
# Between them the served path does not EXIST — Plug.Static's `from:` misses
# and requests fall through to the SPA history-fallback / 404. That window is
# two syscalls wide against the whole vite build it replaces, and it is
# ENOENT rather than a half-written tree, so a client either gets the old
# bundle or the new one, never a mix of both.
#
# Die mid-swap and nothing is lost: `<served>.prev` holds the complete previous
# bundle and `<served>.next` the complete new one; whichever rename landed, the
# next run starts by clearing `.prev` and re-staging `.next`. Only a crash in
# the ~microsecond gap leaves the served path missing, and the fix is to re-run
# the build.
#
# Both paths are siblings inside `runtime/` on purpose: rename(2) cannot cross
# filesystems, and a cross-device `mv` degrades to copy-then-delete, which is
# neither atomic nor fast. A consumer that stages somewhere else loses that.

# Echo the staging path for a served bundle directory. ONE derivation, because
# every consumer needs the name twice — once to aim the builder at it, once to
# promote it — and two spellings of it is a silent no-op deploy.
cic_dist_staging() {
	if [ -z "${1:-}" ]; then
		echo "cic_dist_staging: refusing to derive a staging path from an empty served path" >&2
		return 1
	fi
	printf '%s.next\n' "$1"
}

# Prepare the staging dir the compose oneshot bind-mounts, and echo it in the
# `./`-prefixed shape compose needs (a source with no `./` or `/` is parsed as
# a NAMED VOLUME, not a host path). The dir must pre-exist or Docker creates it
# root-owned and the UID-1000 container cannot write vite's output into it.
cic_dist_docker_stage() {
	_cic_staged="$(cic_dist_staging "$1")" || return 1
	rm -rf "${_cic_staged}"
	mkdir -p "${_cic_staged}"
	printf './%s\n' "${_cic_staged}"
}

# Swap a freshly built bundle into the served path. Leaves the served tree
# UNTOUCHED on any refusal — callers run under `set -e`, so an aborted build
# never reaches here and the previous bundle keeps serving.
cic_dist_promote() {
	_cic_served="${1:-}"
	_cic_staged="${2:-}"
	if [ -z "${_cic_served}" ] || [ -z "${_cic_staged}" ]; then
		echo "cic_dist_promote: served and staged paths are both required" >&2
		return 1
	fi

	# A vite build can exit 0 having written nothing reachable (wrong outDir,
	# a plugin that swallowed its own failure). Promoting that would swap an
	# EMPTY tree into the served path — the exact outage this lib exists to
	# stop, just moved later. index.html is the one file the server must find:
	# Bundle.current_hash/0 parses it and the history-fallback serves it.
	if [ ! -f "${_cic_staged}/index.html" ]; then
		echo "cic_dist_promote: ${_cic_staged}/index.html is missing — refusing to promote a tree that is not a bundle; the previous one keeps serving" >&2
		return 1
	fi

	# `runtime/cicchetto-dist/.gitkeep` is TRACKED (it bakes the bind-mount
	# target so a fresh clone does not get it auto-created root-owned — see
	# .gitignore). It belongs to the tree that LANDS, planted BEFORE the swap
	# rather than restored after it: a post-hoc `touch` is a repair with its
	# own window, and the tracked path missing for even an instant is what
	# left a `D .gitkeep` stalling `git pull --ff-only` on a deploy once.
	touch "${_cic_staged}/.gitkeep"

	_cic_prev="${_cic_served}.prev"
	rm -rf "${_cic_prev}"
	# `mv a b` where b is an EXISTING DIRECTORY moves a INSIDE b. The served
	# path must therefore be gone — not emptied, GONE — before the second
	# rename, or the new bundle lands at <served>/<staged-basename>/ and the
	# server keeps serving the old one with no error anywhere.
	if [ -d "${_cic_served}" ]; then
		mv "${_cic_served}" "${_cic_prev}"
	fi
	mv "${_cic_staged}" "${_cic_served}"
	# Only now is the previous bundle disposable. Dropping it is what keeps
	# `--emptyOutDir`'s stale-chunk cleanup: the old content-hashed assets go
	# with the old directory instead of accreting in the served one.
	rm -rf "${_cic_prev}"
}
