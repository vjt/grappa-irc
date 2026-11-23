#!/usr/bin/env bash
# scripts/protocol-bump-gate.sh — a branch that claims a protocol number claims
# main's NEXT one (issue 2695).
#
# Usage:
#   scripts/protocol-bump-gate.sh            # judge HEAD against origin/main
#   scripts/protocol-bump-gate.sh <base-ref> # against another base
#
# WHAT IT GUARDS
#
# priv/wire/shape.pin holds two facts, `protocol_version` and the
# `shape_digest` taken at it, and `mix grappa.wire_pin --check` keeps them
# honest against the tree. What that gate cannot see is OTHER branches: the
# number is claimed at write time against a main that moves, so two branches
# cut from N both claim N+1, each one right against its own base. Until now
# the guard was a ritual ("checked for a collision before claiming N", 32
# times in lib/grappa/protocol.ex).
#
# The rule: when the pin's facts at HEAD differ from the facts at
# merge-base(<base-ref>, HEAD), HEAD's protocol_version must be EXACTLY the
# base TIP's + 1. A branch whose facts are unchanged claims no number and
# passes, however far main has moved.
#
# WHY TWO REFS
#
# The merge base answers "did this branch claim a number". Judged at the tip
# instead, a branch that never touched the pin would go red the moment main
# bumped. The TIP answers "which number is next". At the merge base both
# colliding branches are a correct +1; the collision does not exist there.
# design-notes-gate.sh checks marker uniqueness at the tip for the same reason
# (#1428).
#
# "Exactly +1" makes a skip and two numbers on one branch red alike. A digest
# move under a still number is red whatever caused it: the gate cannot tell a
# coverage change from a shape change, and neither can wire_pin. Both are the
# provisional defaults of issue 2695; see DESIGN_NOTES.
#
# WHAT IT CANNOT SEE
#
# - A stale green. A pull_request run judges main as it was when the run
#   started, and main requires no status checks, so a branch that went green
#   before another bump landed can still merge. The push run on main, judged
#   from the push's `before`, is then the first red: after the fact.
# - An absorbed bump. A bump that leaves the digest still (15 of the 74 pin
#   commits on main at the time of writing) is absorbed by a rebase onto
#   another branch's identical `protocol_version` edit: git sees the same
#   change on both sides, the branch's pin stops moving, and it claims
#   nothing. Two changes collapse into one number with no text left to judge.
#
# Pure git + text, no mix: the pin carries both facts as text, and its
# agreement with the build is wire_pin's job in the same CI job. The base-ref
# refusals are scripts/ratchet-gate.sh's, for the same push-event reasons.
#
# Exit 0 = no claim, or a claim of exactly tip + 1, each reported as observed.
# Exit 1 = any other claim, or a base or pin the gate cannot read. It never
# passes vacuously.

set -euo pipefail

# No colon: an EMPTY argument stays empty and is refused below. `${1:-…}`
# would turn it into origin/main, and on a push run that judges nothing.
BASE_REF="${1-origin/main}"
PIN="priv/wire/shape.pin"

die() {
	printf 'protocol-bump-gate: %s\n' "$*" >&2
	exit 1
}

cd "$(git rev-parse --show-toplevel)"

case "$BASE_REF" in
"") die "cannot reach its base: the base ref is EMPTY. Pass nothing for origin/main; an empty argument is a caller that lost its value (in CI, an unset github.event.before)." ;;
*[!0]*) ;;
*) die "cannot reach its base: '$BASE_REF' is the all-zeros SHA, which a push event carries when it CREATES a ref: there is no before to judge against." ;;
esac
tip="$(git rev-parse --verify --quiet "${BASE_REF}^{commit}")" ||
	die "cannot reach its base: '$BASE_REF' does not resolve to a commit here. In CI that is a shallow checkout (actions/checkout needs fetch-depth: 0) or, on a push, a 'before' that a force-push left unreachable."
base="$(git merge-base "$tip" HEAD)" ||
	die "cannot reach its base: no merge base between '$BASE_REF' and HEAD"

short() { git rev-parse --short "$1"; }

# facts <rev> → "<protocol_version> <shape_digest>". Exactly one of each, or
# the gate refuses: a pin it cannot parse is not a pin that claims nothing.
facts() {
	local text v d
	text="$(git show "$1:$PIN" 2>/dev/null)" || die "no $PIN at $(short "$1")"
	v="$(sed -n 's/^protocol_version = \([1-9][0-9]*\)$/\1/p' <<<"$text")"
	d="$(sed -n 's/^shape_digest = \(sha256:[0-9a-f]\{64\}\)$/\1/p' <<<"$text")"
	case "$v $d" in
	*$'\n'* | " "* | *" ") die "$PIN at $(short "$1") does not carry exactly one protocol_version and one shape_digest" ;;
	esac
	printf '%s %s\n' "$v" "$d"
}

# Assigned before `read`: a failing substitution inside a here-string would
# hand `read` an empty line and `set -e` would never see the failure.
base_facts="$(facts "$base")"
head_facts="$(facts HEAD)"
tip_facts="$(facts "$tip")"
read -r base_v _ <<<"$base_facts"
read -r head_v _ <<<"$head_facts"
read -r tip_v _ <<<"$tip_facts"

if [ "$head_facts" = "$base_facts" ]; then
	printf 'protocol-bump-gate: the pin is unchanged since merge base %s (protocol %s): this branch claims no number. %s (%s) is at protocol %s.\n' \
		"$(short "$base")" "$base_v" "$BASE_REF" "$(short "$tip")" "$tip_v"
	exit 0
fi

next=$((tip_v + 1))
if [ "$head_v" -eq "$next" ]; then
	printf 'protocol-bump-gate: this branch claims protocol %s (merge base %s had %s), and %s (%s) is at %s: %s is the next number.\n' \
		"$head_v" "$(short "$base")" "$base_v" "$BASE_REF" "$(short "$tip")" "$tip_v" "$head_v"
	exit 0
fi

printf 'protocol-bump-gate: this branch claims protocol %s, but %s (%s) is at %s, so the next number is %s.\n' \
	"$head_v" "$BASE_REF" "$(short "$tip")" "$tip_v" "$next"
if [ "$head_v" -eq "$tip_v" ]; then
	printf '\n%s is already taken on %s: another branch landed it first, or the digest moved under a still number.\n' "$head_v" "$BASE_REF"
elif [ "$head_v" -gt "$next" ]; then
	printf '\nThat skips %s. One branch claims exactly one number, the next one.\n' "$next"
else
	printf '\nThat is behind %s.\n' "$BASE_REF"
fi
printf 'Rebase onto %s, set @protocol_version (and every site that mirrors it, listed above\n' "$BASE_REF"
printf '`version/0` in lib/grappa/protocol.ex) to %s, run `mix grappa.wire_pin --update`, commit.\n' "$next"
exit 1
