#!/usr/bin/env bash
# scripts/posix-parse.sh — the POSIX-sh PARSE gate, over a DERIVED file set.
#
# Usage:
#   scripts/posix-parse.sh          # parse everything, exit non-zero on a finding
#   scripts/posix-parse.sh --list   # print the derived set and exit
#
# A DIFFERENT property from scripts/shellcheck.sh, with a different tool:
# that gate lints, `dash -n` parses. Files that run under the FreeBSD jail's
# /bin/sh must stay strict POSIX, and a reintroduced bashism in one of them
# must fail here rather than silently break a jail deploy — the copy-paste
# drift class #503 exists to kill.
#
# The file set is DERIVED, never hand-listed (#1377 D-S4). The hand list this
# replaced named five paths and covered five of the twenty-eight files that
# declare the sh dialect — including only one of the three POSIX libs under
# infra/lib/ that docs/OPERATIONS.md calls out, and none of the twelve
# infra/freebsd/jail_*.sh rails.
#
# Membership rule, deliberately mechanical: a regular file under `bin/`,
# `infra/` or `scripts/` whose FIRST LINE declares the sh (or dash) dialect —
# a `#!/bin/sh`-family shebang, or the `# shellcheck shell=sh` directive the
# sourced libs use in place of a shebang. That is the same question the
# scripts each already answer for shellcheck; this gate just reads the answer
# instead of keeping a second copy of it. A file that says nothing about its
# dialect is not swept in: `dash -n` on a bash script reports syntax errors
# for valid code, and the pressure would be to shrink the set.
#
# What this catches, measured: GRAMMAR. `arr=(a b c)` and `<<<` are syntax
# errors to dash; `[[ 1 == 1 ]]` and `local x` are NOT — they parse as
# ordinary commands and only fail when they RUN. shellcheck's sh dialect
# (SC3xxx) is what covers that half, over the same files, which is why the
# two gates are complementary rather than one being a superset.
#
# Exit 0 = every derived script parses. Exit 1 = a parse error, or dash
# missing (a gate that silently skips itself is worse than no gate).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

readonly PARSE_ROOTS=(bin infra scripts)

# Line 1 declares the sh dialect: shebang, or shellcheck directive.
is_sh_dialect() {
	local first_line
	# A binary or empty file simply has no first line to read.
	IFS= read -r first_line < "$1" 2>/dev/null || return 1
	[[ $first_line =~ ^#!.*[[:space:]/](sh|dash)([[:space:]]|$) ]] && return 0
	[[ $first_line =~ ^#[[:space:]]*shellcheck([[:space:]]|.*[[:space:]])shell=(sh|dash)([[:space:]]|$) ]]
}

derive_set() {
	local path
	while IFS= read -r path; do
		if is_sh_dialect "$path"; then printf '%s\n' "$path"; fi
	done < <(find "${PARSE_ROOTS[@]}" -type f | sort)
}

mapfile -t SCRIPTS < <(derive_set)

if [ "${#SCRIPTS[@]}" -eq 0 ]; then
	echo "posix-parse.sh: derived an EMPTY file set — the roots moved, or find failed" >&2
	exit 1
fi

if [ "${1:-}" = "--list" ]; then
	printf '%s\n' "${SCRIPTS[@]}"
	exit 0
fi

if ! command -v dash >/dev/null 2>&1; then
	echo "posix-parse.sh: dash is required (it is the POSIX sh this gate parses with)" >&2
	exit 1
fi

echo "posix-parse.sh: dash -n over ${#SCRIPTS[@]} derived sh-dialect scripts under ${PARSE_ROOTS[*]}"

# Parse every file before reporting: one bashism must not hide the next.
# `dash -n` names the offending file itself, on stderr.
failed=0
for script in "${SCRIPTS[@]}"; do
	dash -n "$script" || failed=$((failed + 1))
done

if [ "$failed" -ne 0 ]; then
	echo "posix-parse.sh: $failed file(s) are NOT POSIX sh — see the dash errors above" >&2
	exit 1
fi
