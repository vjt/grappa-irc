#!/usr/bin/env bash
# scripts/wasm.sh — rebuild the vodozemac binding cicchetto vendors (issue 2430).
#
# Usage:
#   scripts/wasm.sh           rebuild, and replace cicchetto/src/lib/e2e/vodozemac/
#   scripts/wasm.sh --check   rebuild into a scratch dir; exit 1 if the vendored copy differs
#
# The binding's source is cicchetto/wasm/vodozemac-binding/ (Rust, with its
# Cargo.lock); what cicchetto imports is the wasm-bindgen output committed
# under cicchetto/src/lib/e2e/vodozemac/, so a cic build needs no Rust. The
# `wasm` workflow runs `--check`: the committed bytes must be exactly what the
# committed source builds.
#
# The build runs in a digest-pinned rust image, never on a host toolchain,
# whose version would leak into the bytes. Everything that decides the output
# is pinned: the image (rustc), the PLATFORM it runs as, Cargo.lock (every
# crate), and wasm-bindgen-cli, built from crates.io at the version Cargo.lock
# holds for the wasm-bindgen crate (the two must match). The platform is part
# of the toolchain although the target is wasm32 on any host: measured, the
# same image and source build a raw wasm 566 bytes apart on arm64 and amd64
# (code layout, not paths; each host rebuilds its own bytes exactly). So the
# build always runs as linux/amd64, natively on the CI runner and emulated on
# an arm64 laptop. The one host path that could leak in, the crate's own, is
# remapped. No wasm-opt: it saved 5% (298,772 → 284,001 bytes on the probe)
# for a second tool to pin.
#
# Exit 0 = built (or, with --check, identical). Exit 1 = a build failure or,
# with --check, drift.

set -euo pipefail

# rust, digest-pinned; the tag stays for readability. Refresh on an intentional
# bump (then rebuild, and commit the new artefact with it):
#   docker buildx imagetools inspect rust:X.Y.Z-slim --format '{{.Manifest.Digest}}'
readonly RUST_IMAGE="rust:1.99.1-slim@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d"
readonly PLATFORM=linux/amd64
readonly WASM_BINDGEN_VERSION=0.2.129
readonly CRATE=cicchetto/wasm/vodozemac-binding
readonly VENDORED=cicchetto/src/lib/e2e/vodozemac

check=0
case "${1:-}" in
"") ;;
--check) check=1 ;;
*)
	echo "usage: scripts/wasm.sh [--check]" >&2
	exit 2
	;;
esac

# Inside the container, from /src.
build() {
	local locked work=/tmp/vodozemac-binding
	locked=$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/version = |"/, ""); print }' "$CRATE/Cargo.lock")
	if [ "$locked" != "$WASM_BINDGEN_VERSION" ]; then
		echo "wasm.sh: Cargo.lock locks wasm-bindgen '$locked', the CLI is $WASM_BINDGEN_VERSION; they must match" >&2
		exit 1
	fi

	rm -rf "$work"
	rustup target add wasm32-unknown-unknown
	cargo install --quiet --locked --root "$work/tools" --version "=$WASM_BINDGEN_VERSION" wasm-bindgen-cli

	CARGO_TARGET_DIR="$work/target" RUSTFLAGS="--remap-path-prefix=$PWD/$CRATE=/vodozemac-binding" \
		cargo build --manifest-path "$CRATE/Cargo.toml" --release --locked --target wasm32-unknown-unknown

	"$work/tools/bin/wasm-bindgen" --target web --out-name vodozemac_binding --out-dir "$work/pkg" \
		"$work/target/wasm32-unknown-unknown/release/vodozemac_binding.wasm"

	if [ "$check" = 1 ]; then
		if ! diff -r "$work/pkg" "$VENDORED"; then
			echo "wasm.sh: $VENDORED is not what $CRATE builds; run scripts/wasm.sh and commit the result" >&2
			exit 1
		fi
		echo "wasm.sh: $VENDORED is what $CRATE builds."
	else
		rm -rf "$VENDORED"
		mkdir -p "$(dirname "$VENDORED")"
		cp -R "$work/pkg" "$VENDORED"
		echo "wasm.sh: wrote $VENDORED"
	fi
}

if [ "${GRAPPA_WASM_IN_CONTAINER:-}" = 1 ]; then
	build
	exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
	echo "wasm.sh: docker is required (the toolchain is a pinned container)" >&2
	exit 1
fi

SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker run --rm --platform "$PLATFORM" -e GRAPPA_WASM_IN_CONTAINER=1 -v "$SRC_ROOT:/src" -w /src "$RUST_IMAGE" \
	bash scripts/wasm.sh "$@"
