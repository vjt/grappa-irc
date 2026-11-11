#!/usr/bin/env bash
# build.sh — assemble the grappa .deb/.rpm from a mix release + the
# cicchetto SPA dist, via nfpm.
#
# Run on a Debian/glibc host with the Elixir 1.19 / OTP 28 toolchain + bun
# on PATH: the release CI runner (setup-beam), or the official
# `elixir:1.19-otp-28` image for a local isolated build. NOT the alpine dev
# image — musl ERTS will not run on a glibc target. See
# infra/packaging/README.md for the one-liner docker invocation.
#
# Env knobs (all optional):
#   GRAPPA_VERSION    package version (default: the repo-root VERSION file)
#   GRAPPA_PKG_ARCH   deb-style arch (default: dpkg --print-architecture /
#                     uname map). nfpm translates it per format (amd64 ->
#                     x86_64 for rpm), so the SAME value drives both.
#   GRAPPA_PKG_FORMAT deb | rpm — the nfpm output format (default: deb).
#                     Build each format on its OWN distro: the bundled ERTS
#                     + shottino link the build host's glibc/libssl.
#   OUT_DIR           where the BOUNCER package lands (default: <repo>/dist)
#   SHOTTINO_OUT_DIR  where the STANDALONE CLIENT package lands
#                     (default: <repo>/dist-shottino). One directory per
#                     artifact — see the client-package section below.
#   NFPM_BIN          path to nfpm (default: on PATH, else downloaded pinned)
#   SKIP_RELEASE=1    reuse an existing _build/prod/rel/grappa
#   SKIP_CIC=1        reuse an existing staged cicchetto-dist
#   SKIP_SHOTTINO=1   skip the terminal-client build AND its package

set -euo pipefail

NFPM_VERSION="2.43.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PKG_DIR="${SCRIPT_DIR}"
STAGING="${PKG_DIR}/staging"
SHOTTINO_STAGING="${PKG_DIR}/staging-shottino"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/dist}"
# One directory per artifact. In #1447 slice A this split was a GATE — the
# workflow's upload steps are PATH-scoped globs, so a package written outside
# `dist/` could not reach the release while the bouncer still owned
# /usr/bin/shottino and the two could not be co-installed.
#
# Slice B dropped the file from the bouncer, so the pair is co-installable and
# the client package IS published — from its own upload step, reading this
# directory. The split stays because it keeps publication EXPLICIT: a new
# package is published when someone writes its upload step, never because a
# glob over a shared directory quietly widened.
SHOTTINO_OUT_DIR="${SHOTTINO_OUT_DIR:-${REPO_ROOT}/dist-shottino}"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# ── Version ────────────────────────────────────────────────────────────────
# Single source of truth: the repo-root VERSION file, read via version.sh.
# The env override is for a one-off build of a pinned version.
if [ -z "${GRAPPA_VERSION:-}" ]; then
	GRAPPA_VERSION="$("${SCRIPT_DIR}/version.sh")" || die "could not read the VERSION file — set GRAPPA_VERSION"
fi
export GRAPPA_VERSION

# #1773 — the git facts behind the credit roll (sha, date, per-author commit
# counts), which the cic build cannot read for itself. No env override and no
# die: the payload is derived, never hand-set, and an absent repo is reported
# honestly rather than failing a package build (see credits.sh).
GRAPPA_CREDITS="$("${SCRIPT_DIR}/credits.sh")"
export GRAPPA_CREDITS

# The client keeps its OWN version line (frontends/shottino/version.h) — two
# artifacts, two cadences (#1447). Same script, different component, so the
# "which file carries which number" answer stays in one place.
if [ -z "${SHOTTINO_VERSION:-}" ]; then
	SHOTTINO_VERSION="$("${SCRIPT_DIR}/version.sh" shottino)" || die "could not read frontends/shottino/version.h — set SHOTTINO_VERSION"
fi
export SHOTTINO_VERSION

# ── Architecture ───────────────────────────────────────────────────────────
if [ -z "${GRAPPA_PKG_ARCH:-}" ]; then
	if command -v dpkg >/dev/null 2>&1; then
		GRAPPA_PKG_ARCH="$(dpkg --print-architecture)"
	else
		case "$(uname -m)" in
		x86_64) GRAPPA_PKG_ARCH="amd64" ;;
		aarch64 | arm64) GRAPPA_PKG_ARCH="arm64" ;;
		*) die "unknown arch $(uname -m) — set GRAPPA_PKG_ARCH" ;;
		esac
	fi
fi
export GRAPPA_PKG_ARCH

# ── Package format ───────────────────────────────────────────────────────────
# deb (default) or rpm; also the output file extension. Rejected here so a
# typo fails at the boundary, not with an opaque nfpm error.
GRAPPA_PKG_FORMAT="${GRAPPA_PKG_FORMAT:-deb}"
case "${GRAPPA_PKG_FORMAT}" in
deb | rpm) ;;
*) die "GRAPPA_PKG_FORMAT must be deb or rpm, got '${GRAPPA_PKG_FORMAT}'" ;;
esac

say "building grappa ${GRAPPA_VERSION} (${GRAPPA_PKG_ARCH}, ${GRAPPA_PKG_FORMAT})"

# ── mix release ────────────────────────────────────────────────────────────
if [ "${SKIP_RELEASE:-}" != "1" ]; then
	command -v mix >/dev/null 2>&1 || die "mix not on PATH — run inside the elixir:1.19-otp-28 image or a setup-beam runner"
	say "mix deps.get + release (MIX_ENV=prod)"
	(
		cd "${REPO_ROOT}"
		mix local.hex --force
		mix local.rebar --force
		mix deps.get --only prod
		MIX_ENV=prod mix compile --warnings-as-errors
		MIX_ENV=prod mix release --overwrite
	)
fi
REL_DIR="${REPO_ROOT}/_build/prod/rel/grappa"
[ -x "${REL_DIR}/bin/grappa" ] || die "release not found at ${REL_DIR} (SKIP_RELEASE without a prior build?)"

# ── cicchetto dist ─────────────────────────────────────────────────────────
DIST_STAGE="${STAGING}/usr/share/grappa/cicchetto-dist"
if [ "${SKIP_CIC:-}" != "1" ]; then
	command -v bun >/dev/null 2>&1 || die "bun not on PATH — needed for the cicchetto build"
	say "bun install + build (outDir=${DIST_STAGE})"
	rm -rf "${DIST_STAGE}"
	mkdir -p "${DIST_STAGE}"
	(
		cd "${REPO_ROOT}/cicchetto"
		bun install --frozen-lockfile
		bun run build -- --outDir "${DIST_STAGE}" --emptyOutDir
	)
fi
[ -f "${DIST_STAGE}/index.html" ] || die "cicchetto dist missing index.html at ${DIST_STAGE}"

# ── Stage the release ──────────────────────────────────────────────────────
say "staging release → ${STAGING}/usr/lib/grappa"
rm -rf "${STAGING}/usr/lib/grappa"
mkdir -p "${STAGING}/usr/lib/grappa"
cp -a "${REL_DIR}/." "${STAGING}/usr/lib/grappa/"

# ── shottino (terminal client) ─────────────────────────────────────────────
# The C client ships as its OWN package (#1447), built here rather than
# elsewhere so it links the BUILD host's ncurses/openssl exactly like the ERTS
# payload does — same host, same glibc floor, one build per format.
# Unless SKIP_SHOTTINO=1, a build failure FAILS the package build: a package
# that silently ships without a binary it advertises is worse than one that
# refuses to build.
SHOTTINO_BIN="${SHOTTINO_STAGING}/usr/bin/shottino"
if [ "${SKIP_SHOTTINO:-}" != "1" ]; then
	say "building shottino → ${SHOTTINO_BIN}"
	(
		cd "${REPO_ROOT}"
		# configure probes ncursesw, openssl, the feature macros and cargo,
		# and writes frontends/shottino/config.mk (untracked, gitignored —
		# the tree stays clean). Fails loudly on a missing dep.
		./configure --prefix=/usr
		make -C frontends/shottino clean
		make -C frontends/shottino
	)
	mkdir -p "${SHOTTINO_STAGING}/usr/bin"
	install -m 0755 "${REPO_ROOT}/frontends/shottino/shottino" "${SHOTTINO_BIN}"
	# Prove the staged artifact RUNS before packaging it. `--help` needs no
	# server, terminal or config, so it exercises the dynamic links for real.
	"${SHOTTINO_BIN}" --help >/dev/null 2>&1 || die "staged shottino does not run (link error?)"
	[ -x "${SHOTTINO_BIN}" ] || die "shottino missing at ${SHOTTINO_BIN}"
	# The measured size of the shipped binary, on the build host that produced
	# it. `wc -c` because BSD stat and GNU stat disagree on flags and this
	# script runs on both. Printed rather than written down anywhere: a number
	# in prose goes stale silently, a number in the build log is always the one
	# from that build.
	say "shottino binary: $(wc -c <"${SHOTTINO_BIN}" | tr -d ' ') bytes ($(uname -s) $(uname -m))"
fi

# ── nfpm ───────────────────────────────────────────────────────────────────
nfpm_bin="${NFPM_BIN:-}"
if [ -z "${nfpm_bin}" ]; then
	if command -v nfpm >/dev/null 2>&1; then
		nfpm_bin="nfpm"
	else
		say "nfpm not found — downloading pinned v${NFPM_VERSION}"
		tmp="$(mktemp -d)"
		trap 'rm -rf "${tmp}"' EXIT
		case "${GRAPPA_PKG_ARCH}" in
		amd64) nfpm_arch="x86_64" ;;
		arm64) nfpm_arch="arm64" ;;
		*) die "no nfpm download mapping for ${GRAPPA_PKG_ARCH}" ;;
		esac
		url="https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}/nfpm_${NFPM_VERSION}_Linux_${nfpm_arch}.tar.gz"
		curl -fsSL "${url}" | tar -xz -C "${tmp}" nfpm
		nfpm_bin="${tmp}/nfpm"
	fi
fi

mkdir -p "${OUT_DIR}"
say "nfpm package (${GRAPPA_PKG_FORMAT}) → ${OUT_DIR}"
(
	cd "${PKG_DIR}"
	"${nfpm_bin}" package -f nfpm.yaml -p "${GRAPPA_PKG_FORMAT}" -t "${OUT_DIR}"
)

say "done — package(s) in ${OUT_DIR}:"
ls -la "${OUT_DIR}"/*."${GRAPPA_PKG_FORMAT}"

# ── nfpm, the standalone client ────────────────────────────────────────────
# Second config, same binary, same format flag — a second package is a second
# yaml, not a new toolchain. Skipped in lockstep with the client BUILD: without
# a staged binary there is nothing to package.
if [ "${SKIP_SHOTTINO:-}" != "1" ]; then
	mkdir -p "${SHOTTINO_OUT_DIR}"
	say "nfpm package shottino ${SHOTTINO_VERSION} (${GRAPPA_PKG_FORMAT}) → ${SHOTTINO_OUT_DIR}"
	(
		cd "${PKG_DIR}"
		"${nfpm_bin}" package -f nfpm-shottino.yaml -p "${GRAPPA_PKG_FORMAT}" -t "${SHOTTINO_OUT_DIR}"
	)
	say "done — client package(s) in ${SHOTTINO_OUT_DIR}:"
	ls -la "${SHOTTINO_OUT_DIR}"/*."${GRAPPA_PKG_FORMAT}"
fi
