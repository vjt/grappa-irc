#!/usr/bin/env bash
# scripts/shellcheck.sh — the shell lint gate, over a DERIVED file set.
#
# Usage:
#   scripts/shellcheck.sh          # lint everything, exit non-zero on a finding
#   scripts/shellcheck.sh --list   # print the derived set and exit
#
# #441 — the gate this replaces was a HAND-WRITTEN list of eleven paths in
# ci.yml. A hand list is not a gate, it is a snapshot: `infra/linux/install.sh`
# — the file whose defects filed this issue — was never on it, and `bin/` was
# not linted at all. The next script added would have been uncovered for the
# same reason the last one was. So the set is DERIVED: every shell script under
# the roots below is linted because it IS one, not because someone remembered.
#
# Membership rule, deliberately mechanical: a regular file under `bin/`,
# `infra/`, or `scripts/` that either ends in `.sh` or opens with a shell
# shebang. That picks up the extensionless scripts a `*.sh` glob misses
# (`bin/grappa`, `infra/freebsd/bin/grappa-source-alias`, the
# `infra/freebsd/rc.d/grappa` service) and skips the non-shell files that live
# alongside them (nginx.conf, PKGBUILD, the pacman scriptlet — no shebang,
# sourced by pacman, not a shell program we ship).
#
# No per-file dialect table: every script already declares its own dialect,
# via its shebang or (for the two sourced libs, which have none) a
# `# shellcheck shell=` directive on line 1. shellcheck reads both. A table
# here would be a second place for that to drift.
#
# `-x` (follow `source`) is on for everything: the repo's scripts are thin
# consumers of `scripts/_lib.sh` and `infra/lib/deploy_common.sh`, and without
# following them shellcheck cannot see `set -euo pipefail` and reports the
# whole codebase's `cd "$REPO_ROOT"` as unguarded. Following needs a
# `# shellcheck source=<repo-relative path>` directive at each `.` line whose
# argument is computed (`. "$(dirname "$0")/_lib.sh"`) — those are part of the
# gate, not decoration.
#
# The linter is a digest-pinned container, NOT the host binary, for the same
# reason the base images are pinned (#103): shellcheck's findings change
# between minors, so a laptop on 0.9 and a runner on whatever ubuntu-latest
# ships that month disagree about what "clean" means — and the laptop's green
# is the one you trust before pushing. One image, one verdict, both sides.
#
# Exit 0 = every derived script is clean. Exit 1 = a finding (or docker
# missing — a gate that silently skips itself is worse than no gate).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# koalaman/shellcheck, digest-pinned (#103 supply-chain posture; the tag stays
# for human readability). Refresh on an intentional bump:
#   docker buildx imagetools inspect koalaman/shellcheck:vX.Y \
#     --format '{{.Manifest.Digest}}'
readonly SHELLCHECK_IMAGE="koalaman/shellcheck:v0.10.0@sha256:2097951f02e735b613f4a34de20c40f937a6c8f18ecb170612c88c34517221fb"

readonly LINT_ROOTS=(bin infra scripts)

# A shell script by extension, or by shebang for the extensionless ones.
is_shell_script() {
	local path="$1" first_line
	case "$path" in
	*.sh) return 0 ;;
	esac
	# A binary or empty file simply has no shell shebang to read.
	IFS= read -r first_line < "$path" 2>/dev/null || return 1
	[[ $first_line =~ ^#!.*[[:space:]/](sh|bash|dash|ksh)([[:space:]]|$) ]]
}

derive_set() {
	local path
	while IFS= read -r path; do
		if is_shell_script "$path"; then printf '%s\n' "$path"; fi
	done < <(find "${LINT_ROOTS[@]}" -type f | sort)
}

mapfile -t SCRIPTS < <(derive_set)

if [ "${#SCRIPTS[@]}" -eq 0 ]; then
	echo "shellcheck.sh: derived an EMPTY file set — the roots moved, or find failed" >&2
	exit 1
fi

if [ "${1:-}" = "--list" ]; then
	printf '%s\n' "${SCRIPTS[@]}"
	exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
	echo "shellcheck.sh: docker is required (the linter is a pinned container)" >&2
	exit 1
fi

echo "shellcheck.sh: linting ${#SCRIPTS[@]} derived shell scripts under ${LINT_ROOTS[*]}"
docker run --rm -v "$REPO_ROOT:/mnt" -w /mnt "$SHELLCHECK_IMAGE" -x "${SCRIPTS[@]}"
