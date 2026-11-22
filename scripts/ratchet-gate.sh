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
# "Before" is the parent commit's value. When the parent does not carry the
# key — the pin, or only that line, was removed earlier on the branch — it is
# the MERGE BASE's value instead, so deleting the record and re-creating it
# higher is a raise like any other (cross review of PR 2701, F1).
#
# Exempt, on purpose: a key the base does not carry either (a new boundary,
# or every key of the commit that seeds the pin: there is no "before") and a
# value that falls. The mix task already refuses a record left above the
# build, so lowering needs no prose.
#
# THE RANGE
#
# merge-base(<base-ref>, HEAD)..HEAD, merge commits skipped. On a pull_request
# run that is the PR's commits. On a push run origin/main IS the pushed tip,
# so CI passes the push event's `before` SHA instead and the range is the
# commits that push added (.github/workflows/ci.yml).
#
# WHY A SEPARATE SCRIPT AND NOT PART OF THE MIX TASK
#
# The pairing needs history, and `mix grappa.ratchet` is offline by
# construction, like `mix grappa.wire_pin`. The shape of this script is
# scripts/design-notes-gate.sh's: same base-ref argument, same refusal to pass
# when the base does not resolve.
#
# Exit 0 = every raise in range is paired. "No raise at all" and an empty
# range ("0 commit(s)") are both reported as observed. Exit 1 = an unpaired
# raise, or a base the gate cannot reach: a ref that does not resolve, an
# EMPTY argument (never silently replaced by origin/main) or the all-zeros
# SHA a push event carries when it creates a ref. A gate that cannot reach its
# base FAILS; it never passes vacuously.

set -euo pipefail

# No colon: an EMPTY argument stays empty and is refused below. `${1:-…}`
# would turn it into origin/main, and on a push run that judges zero commits.
BASE_REF="${1-origin/main}"
PIN="priv/ratchet/ratchet.pin"
NOTES="docs/DESIGN_NOTES.md"

die() {
	printf 'ratchet-gate: cannot reach its base: %s\n' "$*" >&2
	exit 1
}

cd "$(git rev-parse --show-toplevel)"

case "$BASE_REF" in
"") die "the base ref is EMPTY. Pass nothing for origin/main; an empty argument is a caller that lost its value (in CI, an unset github.event.before)." ;;
*[!0]*) ;;
*) die "'$BASE_REF' is the all-zeros SHA, which a push event carries when it CREATES a ref: there is no before to judge against." ;;
esac
git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null ||
	die "'$BASE_REF' does not resolve to a commit here. In CI that is a shallow checkout (actions/checkout needs fetch-depth: 0) or, on a push, a 'before' that a force-push left unreachable."
base="$(git merge-base "$BASE_REF" HEAD)" ||
	die "no merge base between '$BASE_REF' and HEAD"

commits=0
raises=0
unpaired=0
base_pin="$(mktemp)"
before="$(mktemp)"
after="$(mktemp)"
trap 'rm -f "$base_pin" "$before" "$after"' EXIT

if git cat-file -e "$base:$PIN" 2>/dev/null; then
	git show "$base:$PIN" >"$base_pin"
	base_seen="the record there"
else
	base_seen="no record there"
fi

# Keys whose value went UP: "key old new" per line. "old" is the parent's
# value, or the base's when the parent lacks the key; a key neither carries
# is new.
rises() {
	awk '
		/^#/ || NF == 0 { next }
		FILENAME == ARGV[1] { base[$1] = $3; next }
		FILENAME == ARGV[2] { old[$1] = $3; next }
		{ if ($1 in old) o = old[$1]; else if ($1 in base) o = base[$1]; else next }
		$3 + 0 > o + 0 { print $1, o, $3 }
	' "$base_pin" "$1" "$2"
}

while read -r c; do
	[ -n "$c" ] || continue
	commits=$((commits + 1))
	git cat-file -e "$c:$PIN" 2>/dev/null || continue # removed here: nothing grew
	if git cat-file -e "$c^:$PIN" 2>/dev/null; then
		git show "$c^:$PIN" >"$before"
	else
		: >"$before" # seeded or re-created here: every key falls back to the base
	fi
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

printf 'ratchet-gate: %d commit(s) since merge base %s (%s); %d raise(s) of a recorded value; %d without a DESIGN_NOTES line naming the key.\n' \
	"$commits" "$(git rev-parse --short "$base")" "$base_seen" "$raises" "$unpaired"

if [ "$unpaired" -gt 0 ]; then
	printf '\nEach raise above needs, in ITS OWN commit, a line added to %s that names\n' "$NOTES"
	printf 'the key in backticks and says why it had to grow (issue 2690). Amend or\n'
	printf 'fixup that commit; a note in a later commit does not pair.\n'
	exit 1
fi
