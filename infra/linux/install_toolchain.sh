#!/usr/bin/env bash
# Install asdf + the Elixir/Erlang toolchain pinned in .tool-versions,
# plus bun (for cic_build.sh — not packaged for Debian/Ubuntu apt), as
# the grappa user. Run as root (this script sudo's into grappa for
# every step).
#
# Why asdf over distro packages or raw kerl: Debian/Ubuntu apt repos
# don't reliably carry the exact pinned elixir 1.19.5-otp-28 / erlang
# 28.5 from .tool-versions — a drifted version here silently diverges
# from what CI (erlef/setup-beam, same pin) and the FreeBSD jail
# (also pinned) actually run. The repo already ships .tool-versions in
# asdf's native format, so a bare `asdf install` inside the checkout
# installs everything it lists with zero extra config — one pin, every
# consumer reads it. asdf over raw kerl specifically because kerl would
# need a second, hand-maintained version pin instead of reading the
# one that's already checked in.
#
# asdf itself ships as a single Go binary since v0.16 (no more
# git-clone-the-repo-and-source-a-shell-function) — this downloads the
# latest release binary + shims, verified against the published md5.
# Installed into ~grappa's scope, not system-wide — builds run as
# grappa (isolation-without-root).
#
# Erlang is built from source (no prebuilt asdf-erlang binary for an
# arbitrary pin) — expect ~10-20 minutes on first run. This is a
# one-time cost, not a bug; install.sh warns the operator before
# calling this.
#
# Usage: infra/linux/install_toolchain.sh [repo_root]
# Idempotent — skips the asdf binary download if already present,
# `asdf install` itself skips already-installed pinned versions.

set -euo pipefail

REPO_ROOT="${1:-/home/grappa/grappa}"
GRAPPA_USER="${GRAPPA_USER:-grappa}"
GRAPPA_HOME="$(getent passwd "${GRAPPA_USER}" | cut -d: -f6)"
ASDF_BIN_DIR="${GRAPPA_HOME}/.local/bin"

run_as_grappa() {
	sudo -u "${GRAPPA_USER}" -H bash -c "$1"
}

# PATH exported for every run_as_grappa call below: the asdf binary
# itself, plus its shims dir (where `asdf install` links tool
# executables — this is what makes `mix`/`elixir`/`erl` resolve once
# installed).
asdf_path_export="export PATH=\"${ASDF_BIN_DIR}:\${HOME}/.asdf/shims:\${PATH}\""

if [ ! -x "${ASDF_BIN_DIR}/asdf" ]; then
	echo "[install_toolchain] downloading asdf (latest release)"
	arch="$(uname -m)"
	case "${arch}" in
		x86_64) asdf_arch=amd64 ;;
		aarch64) asdf_arch=arm64 ;;
		*) echo "[install_toolchain] ERROR: unsupported arch ${arch}" >&2; exit 1 ;;
	esac

	version="$(curl -fsS https://api.github.com/repos/asdf-vm/asdf/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)"
	if [ -z "${version}" ]; then
		echo "[install_toolchain] ERROR: could not determine latest asdf version from the GitHub API" >&2
		exit 1
	fi

	tmp_dir="$(mktemp -d)"
	trap 'rm -rf "${tmp_dir}"' EXIT
	archive="asdf-${version}-linux-${asdf_arch}.tar.gz"
	curl -fsSL -o "${tmp_dir}/${archive}" "https://github.com/asdf-vm/asdf/releases/download/${version}/${archive}"
	curl -fsSL -o "${tmp_dir}/${archive}.md5" "https://github.com/asdf-vm/asdf/releases/download/${version}/${archive}.md5"
	# asdf's .md5 sidecar is a bare hash with no filename (not the
	# "HASH  filename" format `md5sum -c` expects) — compare directly.
	expected_md5="$(tr -d ' \n' < "${tmp_dir}/${archive}.md5")"
	actual_md5="$(md5sum "${tmp_dir}/${archive}" | awk '{print $1}')"
	if [ "${expected_md5}" != "${actual_md5}" ]; then
		echo "[install_toolchain] ERROR: md5 mismatch for ${archive} (expected ${expected_md5}, got ${actual_md5})" >&2
		exit 1
	fi
	tar -xzf "${tmp_dir}/${archive}" -C "${tmp_dir}"

	run_as_grappa "mkdir -p '${ASDF_BIN_DIR}'"
	install -o "${GRAPPA_USER}" -g "${GRAPPA_USER}" -m 0755 "${tmp_dir}/asdf" "${ASDF_BIN_DIR}/asdf"
	echo "[install_toolchain] installed asdf ${version} -> ${ASDF_BIN_DIR}/asdf"
else
	echo "[install_toolchain] asdf already present at ${ASDF_BIN_DIR}/asdf"
fi

echo "[install_toolchain] ensuring erlang + elixir asdf plugins"
run_as_grappa "${asdf_path_export}; asdf plugin add erlang 2>/dev/null || true; asdf plugin add elixir 2>/dev/null || true"

echo "[install_toolchain] asdf install (reads .tool-versions — can take 10-20 min for erlang, building from source)"
# KERL_CONFIGURE_OPTIONS: headless host, skip wx/observer's X11/GTK
# dependency chain and the debugger/javac interop — none of it is
# used (scripts/observer.sh-equivalent tooling is observer_cli, not
# OTP's :wx-based observer).
run_as_grappa "
	${asdf_path_export}
	export KERL_CONFIGURE_OPTIONS='--without-wx --without-javac --without-debugger --without-observer'
	cd '${REPO_ROOT}'
	asdf install
"

if [ ! -x "${ASDF_BIN_DIR}/bun" ]; then
	echo "[install_toolchain] downloading bun (latest release) — needed for cic_build.sh, not on Debian apt"
	arch="$(uname -m)"
	case "${arch}" in
		x86_64) bun_arch=x64 ;;
		aarch64) bun_arch=aarch64 ;;
		*) echo "[install_toolchain] ERROR: unsupported arch ${arch}" >&2; exit 1 ;;
	esac

	tmp_dir="$(mktemp -d)"
	trap 'rm -rf "${tmp_dir}"' EXIT
	archive="bun-linux-${bun_arch}.zip"
	curl -fsSL -o "${tmp_dir}/${archive}" "https://github.com/oven-sh/bun/releases/latest/download/${archive}"
	curl -fsSL -o "${tmp_dir}/SHASUMS256.txt" "https://github.com/oven-sh/bun/releases/latest/download/SHASUMS256.txt"
	( cd "${tmp_dir}" && sha256sum -c <(grep " ${archive}\$" SHASUMS256.txt) )
	unzip -q "${tmp_dir}/${archive}" -d "${tmp_dir}"

	run_as_grappa "mkdir -p '${ASDF_BIN_DIR}'"
	install -o "${GRAPPA_USER}" -g "${GRAPPA_USER}" -m 0755 "${tmp_dir}/bun-linux-${bun_arch}/bun" "${ASDF_BIN_DIR}/bun"
	echo "[install_toolchain] installed bun -> ${ASDF_BIN_DIR}/bun"
else
	echo "[install_toolchain] bun already present at ${ASDF_BIN_DIR}/bun"
fi

echo "[install_toolchain] done — versions in ${REPO_ROOT}:"
run_as_grappa "${asdf_path_export}; cd '${REPO_ROOT}'; asdf current"
run_as_grappa "${asdf_path_export}; bun --version"
