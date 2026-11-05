#!/usr/bin/env bash
# deb_floor_proof.sh — install AND boot the built .deb pair on a stock Debian
# image, the oldest Debian the .deb supports (#2553).
#
# Usage: deb_floor_proof.sh <image> <grappa.deb> <shottino.deb>
#
# WHY A SECOND INSTALL, when release.yml's deb job already installs both
# packages on the runner: that install proves the package on the host that
# BUILT it, which is the one host a glibc mismatch can never show up on. The
# bundled ERTS and shottino link the glibc of whatever runner builds them, and
# the runner moved: `ubuntu-latest` went 24.04 -> 26.04 between v1.6.0 and
# v1.6.1, the amd64 beam.smp started requiring GLIBC_2.43, and Debian trixie
# (2.41) could no longer run it. The runner install stayed green for both.
#
# WHAT IS ASSERTED — each one runs something against the IMAGE's libraries:
#   * the install itself: postinst runs `grappa migrate`, which starts the
#     bundled beam.smp and loads the exqlite NIF, so a binary linked past the
#     image's glibc fails the package configuration right here;
#   * a fresh `grappa eval` that loads the crypto NIF against the image's
#     libcrypto and prints a digest checked against coreutils' sha256sum;
#   * `shottino --help`, which resolves the client's libc, libncursesw, libssl.
#
# Needs nothing on the host but docker. The container runs docker's default
# platform for the host; to prove a foreign-arch package locally, export
# DOCKER_DEFAULT_PLATFORM (e.g. linux/amd64).
set -euo pipefail

die() { printf 'deb_floor_proof: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 3 ] || die "usage: deb_floor_proof.sh <image> <grappa.deb> <shottino.deb>"
image="$1"
shift
for pkg in "$@"; do
	[ -f "$pkg" ] || die "no such package: '$pkg'"
done
command -v docker >/dev/null 2>&1 || die "docker not found"

# A directory of its own, mode 0755, so apt's unprivileged _apt user can read
# the packages and the log carries no "unsandboxed" notice to read past.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
chmod 0755 "$stage"
cp "$@" "$stage/"

# The in-container script travels as an ARGUMENT, never on stdin. A script
# that bash reads from a pipe shares that pipe with every child it starts, and
# the postinst boots the BEAM twice: anything that drains stdin would swallow
# the checks below and leave a green that ran none of them. No -i either, so
# the container's stdin is empty.
IFS= read -r -d '' script <<'EOF' || true
. /etc/os-release
echo "floor: ${PRETTY_NAME}, $(ldd --version | head -n1)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# Depends only. The Recommends (nginx, ffmpeg, exiftool) are Debian's own
# builds of Debian's own packages and pull ~300 of them; the subject here is
# the payload WE built, and everything it links comes in through Depends.
apt-get install -y -q --no-install-recommends /pkg/*.deb || {
	echo "::error::the packages did not install on the floor image — postinst boots the bundled BEAM, see its error above"
	exit 1
}

want="grappa-floor=$(printf '' | sha256sum | cut -d' ' -f1)"
grappa eval 'IO.puts("grappa-floor=" <> Base.encode16(:crypto.hash(:sha256, ""), case: :lower))' > /tmp/eval.txt || {
	echo "::error::grappa eval failed on the floor image"
	cat /tmp/eval.txt
	exit 1
}
got="$(grep '^grappa-floor=' /tmp/eval.txt | tail -n1 | tr -d '\r' || true)"
echo "beam on the floor: '${got}' (want '${want}')"
[ "$got" = "$want" ] || {
	echo "::error::the packaged BEAM did not report the expected digest on the floor image"
	cat /tmp/eval.txt
	exit 1
}

shottino --help > /tmp/shottino-help.txt || {
	echo "::error::shottino --help failed on the floor image"
	cat /tmp/shottino-help.txt
	exit 1
}
grep -q '^usage: ' /tmp/shottino-help.txt || {
	echo "::error::shottino --help produced no usage output on the floor image"
	cat /tmp/shottino-help.txt
	exit 1
}
echo "shottino on the floor: $(head -n1 /tmp/shottino-help.txt)"
EOF

docker run --rm -v "$stage:/pkg:ro" "$image" bash -euo pipefail -c "$script"
