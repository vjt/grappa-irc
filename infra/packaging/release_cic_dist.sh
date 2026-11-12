#!/usr/bin/env bash
# release_cic_dist.sh — the attested cicchetto bundle a release carries
# (issue 2642).
#
#   release_cic_dist.sh manifest <dist-dir>
#   release_cic_dist.sh pack <dist-dir> <out-dir> <version>
#
# `manifest` prints one `<sha256><two spaces><path>` line per file of a built
# cicchetto dist, the path relative to <dist-dir>, in `LC_ALL=C` order. It is
# the `sha256sum` format on purpose: `sha256sum -c` checks a tree against it
# from inside the tree, and the release job hands it to the attest action as
# `subject-checksums`.
#
# `pack` writes the two release assets into <out-dir>:
#   cicchetto-dist-<version>.tar.gz   the dist's files, extracting FLAT
#                                     (`tar -xzf … -C <dir>`), no top directory
#   cicchetto-dist-<version>.sha256   the manifest of the same tree
# and prints the attestation subjects on stdout: the manifest's lines, then the
# two assets under their asset names. One attestation then covers every served
# file by itself, so `gh attestation verify <file>` works on a file fetched
# from a running grappa, without the manifest in hand.
#
# WHY one implementation for producer and checker: the release job writes the
# manifest with `manifest`, and whatever later compares a tree against it (a
# deploy that unpacks the tarball, a check of what a server serves) should run
# the SAME verb, so the two cannot disagree on order, paths or format.
#
# The tarball is NOT reproducible and does not need to be: the claim is about
# the files, and the manifest names them. The files ARE reproducible from the
# same toolchain — see docs/OPERATIONS.md § "`release_cic_dist.sh` — the
# attested cicchetto bundle (issue 2642)".
#
# Refuses (exit 1, reason on stderr) on:
#   - a dist without index.html (not a built bundle);
#   - a dist holding anything but files and directories (a symlink would ride
#     in the tarball while the manifest of regular files left it out);
#   - a version that is not `X.Y.Z` or `X.Y.Z-<pre>` (it names the assets).
# Usage errors exit 2.
#
# Contract pinned by test/infra/release_cic_dist_test.bats.
set -euo pipefail

die_usage() {
	printf 'usage: %s manifest <dist-dir>\n' "${0##*/}" >&2
	printf '       %s pack <dist-dir> <out-dir> <version>\n' "${0##*/}" >&2
	exit 2
}

refuse() {
	printf '%s: %s\n' "${0##*/}" "$1" >&2
	exit 1
}

check_dist() {
	local dist="$1" odd
	[ -d "$dist" ] || die_usage
	[ -f "$dist/index.html" ] || refuse "${dist} has no index.html — not a built cicchetto dist"
	odd="$(find "$dist" ! -type f ! -type d -print)"
	[ -z "$odd" ] || refuse "${dist} holds something that is neither a file nor a directory: ${odd%%$'\n'*}"
}

manifest() {
	local dist="$1" path
	check_dist "$dist"
	(
		cd "$dist"
		find . -type f -print | LC_ALL=C sort | while IFS= read -r path; do
			sha256sum -- "${path#./}"
		done
	)
}

pack() {
	local dist="$1" out="$2" version="$3" name
	[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
		refuse "version '${version}' is neither X.Y.Z nor X.Y.Z-<pre>"
	name="cicchetto-dist-${version}"
	mkdir -p "$out"
	manifest "$dist" > "$out/$name.sha256"
	tar -C "$dist" -czf "$out/$name.tar.gz" .
	cat "$out/$name.sha256"
	(cd "$out" && sha256sum -- "$name.tar.gz" "$name.sha256")
}

case "${1:-}" in
manifest)
	[ "$#" -eq 2 ] || die_usage
	manifest "$2"
	;;
pack)
	[ "$#" -eq 4 ] || die_usage
	pack "$2" "$3" "$4"
	;;
*)
	die_usage
	;;
esac
