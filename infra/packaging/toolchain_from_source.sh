#!/usr/bin/env bash
# toolchain_from_source.sh — build the Erlang/OTP + Elixir pair that
# .tool-versions pins, from source, into PREFIX (issue 2669).
#
# The .rpm bundles the ERTS it is built with, so that ERTS has to link the
# glibc and OpenSSL of the Fedora it is built on (#438). That rules out
# setup-beam, whose OTP is built on Ubuntu. Until 1.6.5 the rpm job used
# Fedora's own erlang + elixir. That stopped working when hackney 4.11
# (issue 2649) brought in quic 2.x, which needs OTP 27 or later: Fedora 43
# and 44 both ship erlang 26.2.5.21. So the rpm job builds THIS pair inside
# its pinned Fedora container. The deb job's setup-beam reads the same
# .tool-versions, so both packages are built with the same OTP and Elixir.
#
# Usage: infra/packaging/toolchain_from_source.sh PREFIX
#   Run from the repo root: it reads ./.tool-versions. Afterwards
#   PREFIX/bin holds erl, elixir and mix; put it first on PATH.
#   Build deps (Fedora names): gcc gcc-c++ make perl ncurses-devel
#   openssl-devel tar gzip, plus a curl. gcc-c++ is needed for the JIT.
#
# Integrity: the OTP tarball is checked against the SHA256.txt published in
# the same GitHub release, and the script stops before building if it does not
# match or is not listed. That catches a corrupt or truncated download. It does
# NOT protect against a compromised release, because both files come from the
# same place. Elixir publishes no checksum for its source archive, so that one
# is fetched over HTTPS from the tag and not checked.
#
# Run in CI by release.yml's rpm job, which takes this file from the
# DISPATCHED ref (a repair builds a tag cut before this file existed) and
# caches PREFIX per arch. Locally: infra/packaging/README.md § "Building the
# `.rpm`".

set -euo pipefail

die() {
	printf 'toolchain_from_source: %s\n' "$*" >&2
	exit 1
}

[ $# -eq 1 ] || die "usage: $0 PREFIX"
prefix="$1"

[ -f .tool-versions ] || die "no .tool-versions in $(pwd) — run from the repo root"
otp="$(awk '$1 == "erlang" { print $2 }' .tool-versions)"
elixir_pin="$(awk '$1 == "elixir" { print $2 }' .tool-versions)"
elixir="${elixir_pin%-otp-*}"
[ -n "$otp" ] || die ".tool-versions pins no erlang version"
[ -n "$elixir" ] || die ".tool-versions pins no elixir version"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

printf 'toolchain_from_source: OTP %s + Elixir %s -> %s\n' "$otp" "$elixir" "$prefix"

# ── Erlang/OTP ──────────────────────────────────────────────────────────────
otp_url="https://github.com/erlang/otp/releases/download/OTP-${otp}"
tarball="otp_src_${otp}.tar.gz"
curl -fsSL --retry 3 -o "$work/$tarball" "$otp_url/$tarball"
curl -fsSL --retry 3 -o "$work/SHA256.txt" "$otp_url/SHA256.txt"
# Exact match on the file name, not a grep: a missing line must fail here
# rather than leave sha256sum with nothing to check.
awk -v f="$tarball" '$2 == f' "$work/SHA256.txt" > "$work/otp.sha256"
[ -s "$work/otp.sha256" ] || die "SHA256.txt of OTP-${otp} does not list ${tarball}"
(cd "$work" && sha256sum -c otp.sha256) || die "${tarball} does not match the SHA256.txt of OTP-${otp}"

tar -xzf "$work/$tarball" -C "$work"
(
	cd "$work/otp_src_${otp}"
	# Build every OTP application but the GUI and Java ones: the same flags as
	# infra/linux/install_toolchain.sh, for the reason in docs/OPERATIONS.md
	# § "The toolchain pin is the repo's pin, never the distro's".
	./configure --prefix="$prefix" \
		--without-wx --without-javac --without-debugger --without-observer
	make -j"$(nproc)"
	make install
)

# What was built, read off the install: the version it reports, and a running
# crypto + ssl (configure leaves both out quietly when the OpenSSL headers are
# missing, and mix release would then fail far from here).
built_otp="$(cat "$prefix/lib/erlang/releases/${otp%%.*}/OTP_VERSION")"
[ "$built_otp" = "$otp" ] || die "built OTP reports '$built_otp', expected '$otp'"
"$prefix/bin/erl" -noshell -eval \
	'{ok, _} = application:ensure_all_started(ssl), io:format("toolchain_from_source: OTP ~s, ~s emulator, ssl started~n", [erlang:system_info(otp_release), erlang:system_info(emu_flavor)]), halt().'

# ── Elixir ──────────────────────────────────────────────────────────────────
curl -fsSL --retry 3 -o "$work/elixir.tar.gz" \
	"https://github.com/elixir-lang/elixir/archive/refs/tags/v${elixir}.tar.gz"
tar -xzf "$work/elixir.tar.gz" -C "$work"
PATH="$prefix/bin:$PATH" make -C "$work/elixir-${elixir}" PREFIX="$prefix" install

# System.version/0, not --short-version: that one is a string echoed by the
# shell script, and would answer without a single compiled module.
built_elixir="$(PATH="$prefix/bin:$PATH" elixir -e 'IO.puts(System.version())')"
[ "$built_elixir" = "$elixir" ] || die "built Elixir reports '$built_elixir', expected '$elixir'"
printf 'toolchain_from_source: done — OTP %s + Elixir %s in %s\n' "$built_otp" "$built_elixir" "$prefix"
