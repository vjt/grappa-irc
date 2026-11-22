#!/usr/bin/env bash
# scripts/ratchet-gate.sh — the git half of the issue 2690 ratchet.
#
# Usage:
#   scripts/ratchet-gate.sh            # check against origin/main
#   scripts/ratchet-gate.sh <base-ref> # check against another base
#
# WHAT IT GUARDS
#
# priv/ratchet/ratchet.pin records Session.Server's state-key count, its
# handle_call/handle_info clause counts and every boundary's `deps:` count.
# `mix grappa.ratchet --check` fails when the build disagrees with the record,
# so growth means rewriting the record. That alone would make growth a
# one-command chore, so a raise also needs a reason: a commit that RAISES a
# recorded value must, in the SAME commit, add a line to docs/DESIGN_NOTES.md
# that names the key in backticks — e.g. `deps:Grappa.Session`. This script
# checks that pairing, commit by commit, over the commits the branch adds.
#
# Backticks are required, not decoration: they are what keeps
# `deps:Grappa.Accounts.User` from pairing a raise of `deps:Grappa.Accounts`.
#
# Exempt, on purpose: the commit that creates the pin (there is no "before"),
# a key that is NEW in a commit (a new boundary has nothing to grow from) and
# a value that falls. The mix task already refuses a record left above the
# build, so lowering needs no prose.
#
# WHY A SEPARATE SCRIPT AND NOT PART OF THE MIX TASK
#
# The pairing needs history, and `mix grappa.ratchet` is offline by
# construction, like `mix grappa.wire_pin`. The shape of this script is
# scripts/design-notes-gate.sh's: same base-ref argument, same refusal to pass
# when the base does not resolve.
#
# Exit 0 = every raise in range is paired (including "no raise at all", which
# is reported as observed). Exit 1 = an unpaired raise, or the base ref cannot
# be resolved. A gate that cannot reach its base FAILS; it never passes
# vacuously.

set -euo pipefail

BASE_REF="${1:-origin/main}"
PIN="priv/ratchet/ratchet.pin"
NOTES="docs/DESIGN_NOTES.md"

die() {
	printf 'ratchet-gate: %s\n' "$*" >&2
	exit 1
}

cd "$(git rev-parse --show-toplevel)"

git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null ||
	die "base ref '$BASE_REF' does not resolve. In CI this means the checkout is shallow — actions/checkout needs fetch-depth: 0."
base="$(git merge-base "$BASE_REF" HEAD)" ||
	die "no merge base between '$BASE_REF' and HEAD"

# Keys present on both sides whose value went UP: "key old new" per line.
rises() {
	awk '
		/^#/ || NF == 0 { next }
		NR == FNR { old[$1] = $3; next }
		($1 in old) && ($3 + 0 > old[$1] + 0) { print $1, old[$1], $3 }
	' "$1" "$2"
}

commits=0
raises=0
unpaired=0
before="$(mktemp)"
after="$(mktemp)"
trap 'rm -f "$before" "$after"' EXIT

while read -r c; do
	[ -n "$c" ] || continue
	commits=$((commits + 1))
	git cat-file -e "$c:$PIN" 2>/dev/null || continue
	git cat-file -e "$c^:$PIN" 2>/dev/null || continue # the seed: no before
	git show "$c^:$PIN" >"$before"
	git show "$c:$PIN" >"$after"
	risen="$(rises "$before" "$after")"
	[ -n "$risen" ] || continue
	added="$(git show --format= --unified=0 "$c" -- "$NOTES" | sed -n '/^+++ /d; s/^+//p')"
	while read -r key old new; do
		raises=$((raises + 1))
		if ! printf '%s\n' "$added" | grep -qF -- "\`$key\`"; then
			unpaired=$((unpaired + 1))
			printf 'UNPAIRED  %s  %s  %s  %s -> %s\n' \
				"$(git rev-parse --short "$c")" "$(git log -1 --format=%s "$c")" "\`$key\`" "$old" "$new"
		fi
	done <<<"$risen"
done <<<"$(git rev-list --reverse --no-merges "$base..HEAD")"

printf 'ratchet-gate: %d commit(s) since merge base %s; %d raise(s) of a recorded value; %d without a DESIGN_NOTES line naming the key.\n' \
	"$commits" "$(git rev-parse --short "$base")" "$raises" "$unpaired"

if [ "$unpaired" -gt 0 ]; then
	printf '\nEach raise above needs, in ITS OWN commit, a line added to %s that names\n' "$NOTES"
	printf 'the key in backticks and says why it had to grow (issue 2690). Amend or\n'
	printf 'fixup that commit; a note in a later commit does not pair.\n'
	exit 1
fi
