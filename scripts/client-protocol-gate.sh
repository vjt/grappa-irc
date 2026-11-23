#!/usr/bin/env bash
# scripts/client-protocol-gate.sh — every client event kind has a doc entry (issue 2260).
#
# Usage:
#   scripts/client-protocol-gate.sh              # check docs/CLIENT_PROTOCOL.md
#   scripts/client-protocol-gate.sh <doc-path>   # check another copy of it
#
# The optional path is what lets `test/scripts/client_protocol_gate_test.bats`
# judge the gate against a MUTATED copy without writing to the tree — the same
# affordance `scripts/design-notes-gate.sh <base-ref>` carries. The derivation
# side is never parameterised: there is one generated artefact and pointing the
# gate at a fake one would prove nothing about this repo.
#
# WHAT IT GUARDS
#
# `docs/CLIENT_PROTOCOL.md` is the contract a third-party client author reads.
# The server pushes typed `"event"` frames whose `kind` discriminates the
# payload, and nothing tied the set of kinds it EMITS to the set the document
# ANNOUNCES. The author of Sythos met `topic_changed` and
# `channel_modes_changed` on the wire with no document naming either. The
# wire is additive-only, so a client must tolerate an unknown `kind` — but
# "tolerate" is not "discover", and an undocumented kind is a feature no
# second client can implement.
#
# WHY THE SOURCE IS THE GENERATED ARTEFACT
#
# `cicchetto/src/lib/wireTypes.ts` is emitted by `mix grappa.gen_wire_types`
# from `lib/grappa/**/*wire.ex` plus every compiled `GrappaWeb.*JSON` view
# (`json_view_modules/0`, issue 2694), and held by
# `mix grappa.gen_wire_types --check` in `scripts/check.sh` and CI. So it
# cannot drift from the typespecs behind the server's back, and reading it
# here reuses that guarantee instead of re-implementing a typespec walk.
#
# It also carries the one fact a grep over `lib/` cannot recover: the emitting
# MODULE, as a `// === Grappa.Foo.Wire ===` section marker. That is what makes
# the client/admin split derivable rather than a hand-kept list of names — see
# `web_session_severed` below.
#
# 🔴 A GREP OVER `lib/` IS THE WRONG SOURCE, MEASURED (issue 2260)
#
# The issue's own table was built with a regex over `"kind" => "…"` /
# `kind: "…"` in `lib/`, and it is wrong in both directions: it missed 22 of
# the 29 undocumented kinds, and it listed one — `parted` — that the server
# DELIBERATELY DOES NOT EMIT. `git grep -cE 'kind: :parted' -- lib` is 0; what
# the regex actually matched is prose inside comments that say the opposite
# ("there is intentionally NO `kind: "parted"` broadcast — absence is the
# signal", `session/server.ex` and `session/window_state.ex`). Documenting
# `parted` would put a lie in the protocol, against an absence the code
# declares to BE the signal. Hence: typespecs, never a text scan of sources.
#
# WHAT COUNTS AS A CLIENT KIND
#
# `lib/grappa_web/channels/user_socket.ex` routes exactly two topics:
# `grappa:user:*` to `GrappaWeb.GrappaChannel` and `grappa:admin:events` to
# `GrappaWeb.AdminChannel`. So a kind is client-facing iff its carrier can
# reach the first. `Topic.session_log/0` and `Topic.server_settings/0` are
# routed to NO channel; they are internal.
#
# The exclusions below are therefore by emitting MODULE wherever the carrier
# decides it, and by NAME only for the three `kind:` fields that are not event
# discriminators at all. Both lists FAIL CLOSED: a new `*.Wire` module is in
# scope by default and must be documented. Excluding one is a deliberate edit.
#
# WHY NOT AN ExUnit TEST
#
# `docs/` is NOT in the worktree bind-mount list (`scripts/_lib.sh`) — only
# `lib`, `test`, `config`, `cicchetto/src`, `priv/wire`, `infra`, `bin` and a
# handful of root files are. A test reading `docs/CLIENT_PROTOCOL.md` from
# inside the container would read the IMAGE's copy, i.e. MAIN's, and report a
# confident verdict about a file that is not the one under change. Verified:
# `SRC_ROOT/docs` appears 0 times in that mount array while `SRC_ROOT/CLAUDE.md`
# appears once. This gate runs on the HOST, against the worktree, like
# `scripts/design-notes-gate.sh`.
set -euo pipefail

TYPES="cicchetto/src/lib/wireTypes.ts"
DOC="${1:-docs/CLIENT_PROTOCOL.md}"

# Emitting modules whose kinds never reach a client channel.
#   *.AdminWire            — the admin REST/Channel projections
#   Grappa.AdminEvents.Wire — rides Topic.admin_events/0 → AdminChannel
#   Grappa.SessionLog.Wire  — rides Topic.session_log/0, routed to no channel
#
# NOTE `web_session_severed` exists TWICE under two different modules:
# `Grappa.AdminEvents.Wire` (admin topic) and `Grappa.RateLimit.Wire`, which
# `request_budget.ex` broadcasts on `Topic.user/1`. Excluding by module keeps
# the client one and drops the admin one. A by-name exclusion would have lost
# a kind clients really do receive — which is exactly why this list is by
# module.
#
# Matched against the module name ALONE, as an awk field — not against the
# `module<TAB>kind` line. An earlier cut of this gate anchored the alternatives
# with `^`/`$` inside a line-oriented regex, where `$` can never match after
# the module because the tab and the kind follow it; the filter silently
# excluded nothing and the gate demanded doc rows for all 29 admin kinds.
NON_CLIENT_MODULE_RE='AdminWire$|^Grappa\.AdminEvents\.Wire$|^Grappa\.SessionLog\.Wire$'

# `kind:` fields that discriminate a SHAPE, not an event. Each names the type
# it belongs to, because the name alone does not tell you:
#   channel — `kind: "channel" | "query"` on a Scrollback archive entry
#   user    — `kind: "user" | "visitor"` on NetworksWireNetworkWithNickJson,
#   visitor   and on the MeJSON / AuthJSON subject envelopes
NON_EVENT_KINDS='channel user visitor'

# A kind that must never exist. Guards against a derivation so broad it
# swallows anything (a regex collapsing to `.*`, an awk field mix-up).
NEG_CONTROL='zzz_not_a_kind_9f3'

# A kind that must always exist: emitted since the window-state work, named in
# CLAUDE.md as one of the three terminal window events. Guards against a
# derivation that silently yields nothing — the failure mode where a gate
# reports "0 undocumented" because it parsed no input at all.
POS_CONTROL='joined'

die() {
	printf 'client-protocol-gate: %s\n' "$*" >&2
	exit 1
}

[ -f "$TYPES" ] || die "missing $TYPES — run from the repo root"
[ -f "$DOC" ] || die "missing $DOC — run from the repo root"

# --- derive the client event kinds -----------------------------------------
#
# Track the current `// === Module ===` section and emit `module<TAB>kind` for
# every `kind: "literal"` field. The `^[[:space:]]*` anchor is load-bearing:
# unanchored, `kind: "` also matches `subject_kind: "user"`, which put `user`
# in the set through a field that is not `kind` at all.
kinds="$(
	awk -v skipmod="$NON_CLIENT_MODULE_RE" '
		/^\/\/ === / { s = $0; sub(/^\/\/ === /, "", s); sub(/ ===$/, "", s); next }
		/^[[:space:]]*kind: "[a-z0-9_]+"/ {
			if (s == "" || s ~ skipmod) next
			k = $0
			sub(/^[[:space:]]*kind: "/, "", k)
			sub(/".*$/, "", k)
			print k
		}
	' "$TYPES" | sort -u
)"

for skip in $NON_EVENT_KINDS; do
	kinds="$(printf '%s\n' "$kinds" | grep -vx "$skip" || true)"
done

count="$(printf '%s\n' "$kinds" | grep -c . || true)"

# --- controls, BEFORE any number is believed or printed ---------------------
#
# Each of these failing means the DERIVATION is broken, not that the doc is.
# They run first and `die` so the gate can never report a reassuring count it
# did not actually compute.
sections="$(grep -cE '^// === ' "$TYPES" || true)"
[ "$sections" -ge 20 ] ||
	die "parsed only $sections module sections from $TYPES — the section marker format changed; the kind derivation is not trustworthy"

printf '%s\n' "$kinds" | grep -qx "$POS_CONTROL" ||
	die "positive control failed: '$POS_CONTROL' is not in the derived client set — the derivation is broken, refusing to report a count"

if printf '%s\n' "$kinds" | grep -qx "$NEG_CONTROL"; then
	die "negative control failed: invented kind '$NEG_CONTROL' is in the derived set — the derivation is too broad"
fi

[ "$count" -ge 40 ] ||
	die "derived only $count client kinds — expected at least 40; the derivation is not trustworthy"

# The doc-side shape must exist before a per-kind verdict means anything. A
# missing inventory table would otherwise read as "every kind undocumented",
# which is true but names the wrong defect.
# A literal ERE handed to grep: the backticks and the `$` anchor must reach it
# unexpanded. Double quotes here would let the shell read the backticks as
# command substitution and eat the anchor, and the gate would stop matching the
# header it exists to find — a check that passes because it no longer measures.
# shellcheck disable=SC2016
grep -qE '^\| `kind` \| topic \| what it is \|$' "$DOC" ||
	die "no inventory table header in $DOC — expected a row '| \`kind\` | topic | what it is |'"

# --- the verdict ------------------------------------------------------------
#
# 🔴 The assert is anchored to the TABLE ROW, never to the kind's name
# appearing in the file. The subject of this gate is a document that discusses
# its own vocabulary: `docs/CLIENT_PROTOCOL.md` says "unlike `topic_changed`,
# …" in prose, and a substring test would accept that as documentation and
# report a kind as covered when it has no entry. A row is a commitment; a
# mention is not.
missing=''
for k in $kinds; do
	if ! grep -qE "^\| \`${k}\` \|" "$DOC"; then
		missing="${missing}${k}"$'\n'
	fi
done

if [ -n "$missing" ]; then
	printf 'client-protocol-gate: %s client event kind(s) have no entry in %s:\n' \
		"$(printf '%s' "$missing" | grep -c .)" "$DOC"
	printf '%s' "$missing" | sed 's/^/  - /'
	# A printf FORMAT string, not a template: the backticks are literal output
	# showing the row shape the operator has to add. Nothing in it is meant to
	# expand, and double quotes would hand the backticks to the shell.
	# shellcheck disable=SC2016
	printf '\nEach needs a row `| `<kind>` | <topic> | <what it is> |` in the event kind\ninventory. A mention in prose does not count: this gate reads rows.\n'
	exit 1
fi

printf 'client-protocol-gate: all %s client event kinds have an entry in %s.\n' "$count" "$DOC"
