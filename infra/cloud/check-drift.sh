#!/usr/bin/env bash
# check-drift.sh — the CI drift-guard for the #665 shared-ground layout.
#
# The design deliberately does NOT generate the provider templates from one
# source (that would be CDK/cdktf — a Node toolchain + synthesized artifacts
# committed anyway, to save ~30 lines of resource graph). Instead the two
# doors are hand-written and a CHECK keeps them honest. Every provider wrapper
# must:
#
#   (1) INVOKE the shared bootstrap `first-boot.sh` from its bootstrap block
#       (CFN `UserData:` / Terraform `user_data`), not merely mention it;
#   (2) expose the SAME knob names from infra/cloud/params.contract, each
#       `grappa-knob: <name>` marker BOUND to the parameter it annotates;
#   (3) export exactly the env vars first-boot.sh requires.
#
# All three checks read the EXECUTABLE surface, because that is the surface
# that breaks a launched stack. The first two used to be satisfied by a
# comment: the whole-file grep for `first-boot.sh` was satisfied by the four
# prose mentions that survive deleting the real UserData bootstrap, and a knob
# marker left behind by a deleted parameter passed as a detached comment. (3)
# did not exist at all, and it is the drift that actually happens — rename
# GRAPPA_DOMAIN on one side and every launched stack dies in UserData while
# both files stay individually valid. See #746.
#
# This is a guard, NOT a generator: it never edits a template, it only fails
# loud when the doors drift. It runs against whatever doors exist today
# (infra/aws/) and starts covering infra/terraform/ the day that lands — an
# absent provider directory is not drift, so it is tolerated silently.
#
# Exit 0 = every present door invokes first-boot.sh, binds every knob, and
#          hands over exactly the required env.
# Exit 1 = drift.
# Exit 2 = misuse / missing contract / missing bootstrap.
#
# Pure filesystem + grep/awk, no network, no cloud CLI — so it lives under bats
# (test/infra/cloud_drift_guard_test.bats), which proves it goes RED on drift
# by mutating the REAL shipped template, one defect at a time.
# bash, `set -euo pipefail`, shellcheck-clean.

set -euo pipefail

# Self-locate so CI can invoke it from any cwd. REPO_ROOT overridable for bats.
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${GRAPPA_REPO_ROOT:-$(cd "$SELF_DIR/../.." && pwd)}"
CONTRACT="${GRAPPA_PARAMS_CONTRACT:-$REPO_ROOT/infra/cloud/params.contract}"

# The bootstrap every door must curl-at-ref + exec.
BOOTSTRAP_NAME='first-boot.sh'
BOOTSTRAP="$REPO_ROOT/infra/cloud/$BOOTSTRAP_NAME"

# The provider doors. A glob that matches nothing (e.g. infra/terraform absent)
# contributes zero files — tolerated, not an error.
AWS_GLOB="$REPO_ROOT/infra/aws/*.yaml"
TF_GLOB="$REPO_ROOT/infra/terraform/*.tf"

say() { printf '[check-drift] %s\n' "$*"; }
fail() { printf '[check-drift] DRIFT: %s\n' "$*" >&2; drift=1; }

[ -f "$CONTRACT" ] || {
	printf '[check-drift] missing params contract: %s\n' "$CONTRACT" >&2
	exit 2
}

[ -f "$BOOTSTRAP" ] || {
	printf '[check-drift] missing shared bootstrap: %s\n' "$BOOTSTRAP" >&2
	exit 2
}

# Parse the canonical knob names from the KNOBS block (between the BEGIN/END
# markers), skipping blanks + comments.
read_knobs() {
	awk '
		/^# BEGIN KNOBS$/ { inb = 1; next }
		/^# END KNOBS$/   { inb = 0 }
		inb && $0 !~ /^#/ && NF { print $1 }
	' "$CONTRACT"
}

# The env handshake, read off the bootstrap's own code: a knob it reads with an
# EMPTY default (`GRAPPA_X="${GRAPPA_X:-}"`) is REQUIRED from the door, while a
# non-empty default is a production config default / test seam that no door
# passes. Derived from the assignment itself, never from a comment — a comment
# is the thing this guard exists to stop trusting.
# awk with a whole-line string compare, not a sed backreference: `sed -E` only
# honours \1 inside the pattern as a GNU extension, and silently matched
# nothing on BSD sed.
read_required_env() {
	awk '
		index($0, "=") {
			name = substr($0, 1, index($0, "=") - 1)
			if (name ~ /^GRAPPA_[A-Z0-9_]+$/ && $0 == name "=\"${" name ":-}\"") { print name }
		}
	' "$BOOTSTRAP" | sort -u
}

# Collect present door files across every provider glob (nullglob so an absent
# directory yields nothing rather than the literal glob string).
door_files() {
	shopt -s nullglob
	# shellcheck disable=SC2206  # word-splitting the glob into paths is intended
	local doors=($AWS_GLOB $TF_GLOB)
	shopt -u nullglob
	# Guard the empty case: `printf '%s\n' "${empty[@]}"` emits one blank line,
	# which mapfile would read as a phantom door.
	[ "${#doors[@]}" -gt 0 ] && printf '%s\n' "${doors[@]}"
}

# The body of a door's bootstrap block — CFN `UserData:` or Terraform
# `user_data = <<-EOT` — delimited by indentation: everything indented DEEPER
# than the key, up to the first line that is not. This is the door's executable
# surface; prose elsewhere in the file is not part of it.
door_bootstrap_block() {
	awk '
		{
			match($0, /^[ \t]*/)
			ind = RLENGTH
			if (inb) {
				if ($0 ~ /^[ \t]*$/) next
				if (ind > base) { print; next }
				inb = 0
			}
			if ($0 ~ /^[ \t]*(UserData:|user_data[ \t]*=)/) { base = ind; inb = 1 }
		}
	' "$1"
}

# Its executable lines only — a comment inside UserData is still prose.
door_bootstrap_code() {
	door_bootstrap_block "$1" | grep -vE '^[ \t]*#' || true
}

# The env vars a door hands the bootstrap: the GRAPPA_* names it assigns inside
# its bootstrap block.
door_exported_env() {
	door_bootstrap_code "$1" \
		| sed -E -n 's/^[ \t]*(export[ \t]+)?(GRAPPA_[A-Z0-9_]+)=.*/\2/p' \
		| sort -u
}

# The knob names whose marker is BOUND to a declaration: the first non-blank,
# non-comment line after the marker — before the next marker — is the parameter
# the marker annotates. A marker whose parameter was deleted is left dangling
# and is NOT reported, so the caller sees it as a missing knob. A marker written
# as a trailing comment on the declaration itself counts as bound.
door_bound_knobs() {
	awk '
		/grappa-knob:/ {
			match($0, /grappa-knob:[ \t]*[A-Za-z0-9_]+/)
			knob = substr($0, RSTART, RLENGTH)
			sub(/grappa-knob:[ \t]*/, "", knob)
			# Anything other than the comment opener before the marker means the
			# declaration IS this line.
			if (substr($0, 1, RSTART - 1) ~ /[^ \t#\/]/) { print knob; pending = ""; next }
			pending = knob
			next
		}
		pending != "" && $0 !~ /^[ \t]*$/ && $0 !~ /^[ \t]*#/ {
			print pending
			pending = ""
		}
	' "$1"
}

mapfile -t KNOBS < <(read_knobs)
[ "${#KNOBS[@]}" -gt 0 ] || {
	printf '[check-drift] no knobs parsed from %s (empty KNOBS block?)\n' "$CONTRACT" >&2
	exit 2
}

mapfile -t REQUIRED_ENV < <(read_required_env)
[ "${#REQUIRED_ENV[@]}" -gt 0 ] || {
	# shellcheck disable=SC2016  # the un-expanded ${...} IS the shape being asked for
	printf '[check-drift] no required env parsed from %s (expected GRAPPA_X="${GRAPPA_X:-}")\n' "$BOOTSTRAP" >&2
	exit 2
}

mapfile -t DOORS < <(door_files)
if [ "${#DOORS[@]}" -eq 0 ]; then
	# No provider template exists yet — nothing to guard, not a failure.
	say "no provider doors found (infra/aws, infra/terraform) — nothing to check"
	exit 0
fi

required_list="$(printf '%s\n' "${REQUIRED_ENV[@]}")"

drift=0
for door in "${DOORS[@]}"; do
	say "checking $door"

	# (1) the door INVOKES the shared bootstrap from its bootstrap block.
	block="$(door_bootstrap_code "$door")"
	if [ -z "$block" ]; then
		fail "$door has no UserData:/user_data bootstrap block (it must curl+exec $BOOTSTRAP_NAME, not inline it)"
	elif ! printf '%s\n' "$block" | grep -q "$BOOTSTRAP_NAME"; then
		fail "$door does not invoke $BOOTSTRAP_NAME from its bootstrap block (a prose mention elsewhere in the file is not a bootstrap)"
	fi

	# (2) every knob marker is present AND bound to the parameter it annotates.
	bound="$(door_bound_knobs "$door")"
	for knob in "${KNOBS[@]}"; do
		if ! grep -qE "grappa-knob:[[:space:]]*${knob}([[:space:]]|$)" "$door"; then
			fail "$door is missing knob marker 'grappa-knob: ${knob}'"
		elif ! printf '%s\n' "$bound" | grep -qx "$knob"; then
			fail "$door has a dangling 'grappa-knob: ${knob}' marker — no parameter follows it (deleted parameter, orphaned comment)"
		fi
	done

	# (3) the env handshake: the door exports exactly what the bootstrap requires.
	exported="$(door_exported_env "$door")"
	while read -r missing; do
		[ -n "$missing" ] || continue
		fail "$door never exports ${missing}, which $BOOTSTRAP_NAME requires — every stack launched from this door dies in its bootstrap"
	done < <(comm -23 <(printf '%s\n' "$required_list") <(printf '%s\n' "$exported"))
	while read -r extra; do
		[ -n "$extra" ] || continue
		fail "$door exports ${extra}, which $BOOTSTRAP_NAME does not require — a renamed or stale knob the bootstrap will ignore"
	done < <(comm -13 <(printf '%s\n' "$required_list") <(printf '%s\n' "$exported"))
done

if [ "$drift" -ne 0 ]; then
	printf '[check-drift] FAILED — the provider doors drifted from the shared contract.\n' >&2
	exit 1
fi

say "OK — all ${#DOORS[@]} door(s) invoke $BOOTSTRAP_NAME, bind all ${#KNOBS[@]} knobs and export all ${#REQUIRED_ENV[@]} required env vars"
exit 0
