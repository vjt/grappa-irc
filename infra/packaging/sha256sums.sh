#!/usr/bin/env bash
# sha256sums.sh — the SHA256SUMS file attached to every release (issue 2570).
#
#   sha256sums.sh <assets-dir> < <listing>
#
# <listing> is the release's asset list as the GitHub API returns it AFTER the
# upload, one `<name><TAB><digest>` line per asset, the digest spelled the way
# the API spells it (`sha256:<64 hex>`). stdout is a SHA256SUMS in the
# `sha256sum` format (`<hex><two spaces><name>`), sorted by name, so a packager
# runs `sha256sum -c --ignore-missing SHA256SUMS` over whatever subset they
# downloaded.
#
# WHY the names come from the API and not from the files this run built: a
# packager downloads the PUBLISHED name, and GitHub renames on upload. Measured
# on the releases themselves: the bouncer's `.SRCINFO` is published as
# `default.SRCINFO` (v1.6.2), and on a pre-release the `~` nfpm writes becomes
# `.` (v1.3.0-rc2 carries `grappa_1.3.0.rc2_amd64.deb`). A file written from
# local names would fail `sha256sum -c` on exactly those assets.
#
# WHY the local files still matter: the digest is GitHub's own record, so sums
# read from it alone would only show that GitHub agrees with itself. Every file
# this run attached — `release_assets.sh found`, the set the publish job
# uploads — must hash to a digest the release holds, or the release does not
# carry what CI built and the script refuses.
#
# Coverage is EVERYTHING on the release except SHA256SUMS itself: assets no
# expected kind names, and assets an earlier run attached that this one did
# not rebuild (a repair whose leg failed). The file
# describes what can be downloaded; which assets are part of the contract is
# PACKAGING.md's call, not this script's.
#
# Refuses (exit 1, reason on stderr) on:
#   - a listing line with no name, or a digest missing / not `sha256:<64 hex>`;
#   - a listing holding nothing but SHA256SUMS;
#   - an assets dir holding no attached file to check against the release;
#   - an attached file whose sha256 matches no digest on the release.
# Usage errors exit 2.
#
# Contract pinned by test/infra/release_sha256sums_test.bats.
set -euo pipefail

die_usage() {
	printf 'usage: %s <assets-dir> < <name TAB digest listing>\n' "${0##*/}" >&2
	exit 2
}

refuse() {
	printf 'sha256sums.sh: %s\n' "$1" >&2
	exit 1
}

[ "$#" -eq 1 ] || die_usage
dir="$1"
[ -d "$dir" ] || die_usage
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The published side. SHA256SUMS is skipped by name: a repair dispatch or a
# re-run finds the previous run's copy on the release, and a file listing its
# own (stale) digest could never verify.
sums=""
while IFS=$'\t' read -r name digest; do
	[ -n "$name" ] || refuse 'a listing line carries no asset name'
	[ "$name" != SHA256SUMS ] || continue
	hex="${digest#sha256:}"
	if [ "$hex" = "$digest" ] || ! [[ "$hex" =~ ^[0-9a-f]{64}$ ]]; then
		refuse "asset ${name} has no sha256 digest on the release (got '${digest}')"
	fi
	sums+="${hex}  ${name}"$'\n'
done
[ -n "$sums" ] || refuse 'the release lists no asset besides SHA256SUMS — nothing to sum'

# The built side. Captured rather than read through a process substitution, so
# a failing `found` stops the script instead of turning the check vacuous.
attached="$("$here/release_assets.sh" found "$dir")"
[ -n "$attached" ] || refuse "no attached file under ${dir} to check against the release"
while IFS= read -r file; do
	hex="$(sha256sum "$file")"
	hex="${hex%% *}"
	grep -q "^${hex}  " <<<"$sums" ||
		refuse "${file#"$dir"/} (sha256 ${hex}) matches no asset on the release — the release does not hold what this run built"
done <<<"$attached"

printf '%s' "$sums" | LC_ALL=C sort -k2
