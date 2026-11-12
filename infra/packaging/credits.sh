#!/bin/sh
# credits.sh — echo the build's git credits payload, as ONE line of JSON.
#
#   {"sha":"a453325e","date":"2026-08-25T18:04:11+02:00",
#    "contributors":[{"name":"…","nick":"…","commits":903},…]}
#
# Sibling of version.sh, and deliberately shaped like it: the cic build runs
# in containers that mount ONLY ./cicchetto (cicchetto/vite.config.ts:30-39),
# so the repo root — and therefore git — is out of reach in there. Every
# cic-build entrypoint already derives GRAPPA_VERSION from version.sh and
# exports it before the container starts; this script is the second half of
# that same channel, for the three facts a credit roll needs and a browser
# cannot have (#1773). A `git shortlog` inside vite.config.ts would find no
# repo and bake an EMPTY roll, silently, on every containerised build.
#
# POSIX sh, NOT bash, for the same reason version.sh is: the FreeBSD jail
# build (infra/freebsd/jail_cic_build.sh) runs /bin/sh with no bash port and
# calls this to derive the payload. Always EXECUTED (never sourced), so `$0`
# locates the script.
#
# ── Why this NEVER fails, unlike the GRAPPA_VERSION throw in vite.config.ts ──
#
# Two of the launchers that must call it have no `.git` BY CONSTRUCTION, and
# both are RELEASE builds:
#
#   * infra/packaging/aur/PKGBUILD builds from the tag's source TARBALL —
#     release.yml asserts that shape outright ("tarball → no .git → bare");
#   * Dockerfile.release .dockerignore's `.git`, which is exactly why the
#     comment in it says Grappa.Version "takes its no-git path".
#
# So a hard failure on a missing repo would break precisely the two builds
# that ship. This script instead reports the absence honestly — `sha:null`,
# `date:null`, `contributors:[]` — which is the SAME posture
# `Grappa.Version.verify_build_sha/2` already takes, where a positively
# identified no-git build is `{:skip, :no_git}` and only a BROKEN snapshot is
# an error. The loud half stays where it belongs: vite still refuses to build
# when GRAPPA_CREDITS is UNSET, because that means a wrapper forgot to plumb
# it, which is the failure the throw exists to catch.
#
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
set -eu

# No `dirname --` / `cd --`: BSD dirname (the FreeBSD jail) doesn't accept the
# end-of-options `--`, and $0 is always an invoked path (never starts with -).
#
# `CDPATH= cd` is an env-prefixed command (clear CDPATH for this cd only, so a
# user's CDPATH cannot teleport it and mis-root the repo), not a botched
# assignment — hence the SC1007 disable.
# shellcheck disable=SC1007
SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1007
REPO_ROOT="$(CDPATH= cd "${SCRIPT_DIR}/../.." && pwd)"

sha=""
date=""
shortlog=""
shallow=""

# `.git` is a directory in a normal checkout and a FILE in a `git worktree`
# (it points at the shared gitdir); either is a source build. Absent entirely
# is a release tarball / package. Tested explicitly rather than letting git
# walk upwards: a checkout extracted INSIDE some other repo must report its
# own absence, not that repo's history.
if [ -e "${REPO_ROOT}/.git" ]; then
	# Every probe degrades to empty on failure and none of them aborts the
	# script — same contract as Grappa.Version.GitProbe, and for the same
	# reason: a missing git binary, an unborn HEAD or a refused checkout
	# (git's "dubious ownership") must yield a smaller payload, never a
	# broken build.
	# A FIXED width (issue 2642): a bare `--short` is sized from the clone's
	# object count (9 hex today, 10 from 2^18 objects, measured), and this
	# value is baked into the bundle, whose bytes the release attests and
	# anyone may rebuild. Nine is today's auto width, so today's bytes stay.
	sha="$(git -C "${REPO_ROOT}" rev-parse --short=9 HEAD 2>/dev/null || true)"
	date="$(git -C "${REPO_ROOT}" log -1 --format=%cI 2>/dev/null || true)"
	# 🔴 A SHALLOW clone is the one case where a probe can answer CONFIDENTLY
	# WRONG rather than emptily, so it is the one case that gets a gate
	# (issue 1773). `sha` and `date` above are exact in a shallow repo — HEAD
	# is HEAD — but `shortlog` aggregates over HISTORY, and a truncated
	# history is not a smaller answer, it is a false one: it credits the whole
	# project to whoever authored the commits that happened to be fetched.
	# Measured on this repo's CI, where `actions/checkout` defaults to
	# `fetch-depth: 1`: every green `integration` run baked
	# `[{"name":"Marcello Barnaba","commits":1}]` for an author with 5667, and
	# nothing was ever red, because a wrong roll has the same shape as a right
	# one. Withholding the list is what makes the truncation VISIBLE — the
	# consumer that refuses an empty roll (cicchetto/e2e's #1773 spec) then
	# catches the shallow wrapper instead of rendering its lie.
	#
	# Only the aggregate is withheld. Reporting sha/date as null too would
	# claim the build has no history at all, which is the AUR/tarball case and
	# a different fact.
	#
	# An older git has no `--is-shallow-repository` (2.15+) and leaves this
	# empty, which reads as not-shallow and preserves the previous behaviour
	# exactly — the gate can only ever be absent, never inverted.
	shallow="$(git -C "${REPO_ROOT}" rev-parse --is-shallow-repository 2>/dev/null || true)"
	if [ "${shallow}" != "true" ]; then
		# `--no-merges` so a merge does not credit the merger with the work of
		# whoever authored the branch; HEAD is named explicitly so shortlog
		# reads the revision instead of waiting on stdin.
		shortlog="$(git -C "${REPO_ROOT}" shortlog -sn --no-merges HEAD 2>/dev/null || true)"
	fi
fi

# The nick table (#1927) — `<author name>\t<handle>`, documented in its own
# header. OPTIONAL by construction: a tree without it, or one where it cannot
# be read, yields every contributor with `nick:null` and the roll falls back to
# bare names. Same posture as every probe above — degrade, never abort.
NICKS="${SCRIPT_DIR}/contributors"
[ -r "${NICKS}" ] || NICKS=/dev/null

# ONE awk run builds the whole payload: the nick table comes in as the first
# operand, the contributor rows on stdin, the two scalars on -v. LC_ALL=C keeps
# substr/length byte-oriented, so a multi-byte name is copied through byte by
# byte and reassembles exactly — awk never reorders what it concatenates.
#
# The two inputs are told apart by the `pass=` assignments BETWEEN the operands
# (POSIX: command-line assignments take effect in operand order), not by the
# usual `NR == FNR` idiom — that one silently misreads the second file as the
# first whenever the first is EMPTY, which here is the everyday case of a
# missing table (/dev/null) and would parse the shortlog as nick mappings.
printf '%s' "${shortlog}" | LC_ALL=C awk -v sha="${sha}" -v head_date="${date}" '
	# JSON string literal. Character-by-character rather than gsub: the
	# replacement text of gsub gives `\` and `&` their own meanings, which is
	# how an escaper comes to corrupt exactly the input it exists for.
	function jsonstr(s,   out, i, c) {
		out = "\""
		for (i = 1; i <= length(s); i++) {
			c = substr(s, i, 1)
			if (c == "\\") {
				out = out "\\\\"
			} else if (c == "\"") {
				out = out "\\\""
			} else if (c < " ") {
				# git forbids CR/LF in an author name, so this is
				# unreachable in practice — but the payload has to be
				# parseable by construction, not by trust.
				out = out " "
			} else {
				out = out c
			}
		}
		return out "\""
	}

	function jsonornull(s) {
		return s == "" ? "null" : jsonstr(s)
	}

	# Blanks around either field (and a CR, if the table was ever edited on
	# Windows) would otherwise become part of the key or of the nick — an
	# invisible edit that silently stops matching, or ships a handle with a
	# space in it. git strips leading and trailing blanks from an author name
	# itself, so nothing legitimate is lost here.
	function trim(s) {
		sub(/^[ \t\r]+/, "", s)
		sub(/[ \t\r]+$/, "", s)
		return s
	}

	function nickof(name) {
		return (name in nick) ? jsonstr(nick[name]) : "null"
	}

	# First operand: the nick table. `<author name>\t<handle>`, `#` comments and
	# blank lines skipped. A malformed line is dropped rather than guessed at —
	# a typo must cost one missing nick, not a broken payload.
	pass == 1 {
		if ($0 ~ /^[ \t]*(#|$)/) {
			next
		}
		tab = index($0, "\t")
		if (tab == 0) {
			next
		}
		nick[trim(substr($0, 1, tab - 1))] = trim(substr($0, tab + 1))
		next
	}

	{
		# `shortlog -sn` emits "<count>\t<name>"; a line without the tab is
		# not a contributor row and is dropped rather than guessed at.
		tab = index($0, "\t")
		if (tab == 0) {
			next
		}
		name = substr($0, tab + 1)
		# Bots are dropped where the list is BORN, not hidden in the renderer:
		# what the roll will never show has no business travelling in the
		# bundle. `[bot]` is the suffix GitHub gives every App identity, so
		# dependabot[bot] (#1927, the one that outranked half the humans by
		# commit count) and its future siblings go the same way. A human whose
		# name genuinely ends in "[bot]" does not exist; a bot we DO want to
		# credit — vjt-claude — commits under a plain name and is unaffected.
		if (length(name) > 5 && substr(name, length(name) - 4) == "[bot]") {
			next
		}
		if (n > 0) {
			rows = rows ","
		}
		rows = rows "{\"name\":" jsonstr(name) ",\"nick\":" nickof(name) \
			",\"commits\":" ($1 + 0) "}"
		n++
	}

	END {
		printf "{\"sha\":%s,\"date\":%s,\"contributors\":[%s]}\n",
			jsonornull(sha), jsonornull(head_date), rows
	}
' pass=1 "${NICKS}" pass=2 -
