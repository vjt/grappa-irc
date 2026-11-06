#!/usr/bin/env bash
# scripts/shottino-cargo.sh — `cargo`, for a host that has none.
#
# shottino's E2E crypto is vodozemac, through a small Rust staticlib
# (frontends/shottino/e2e/vodozemac-c). The Makefile calls `cargo` when the
# host has one — packagers and CI do — and this script otherwise: the same
# arguments, run in the digest-pinned rust image scripts/wasm.sh uses, with
# the crate directory (the caller's cwd) mounted as /src. The crate
# registry is cached in the crate's own `.cargo-home`, gitignored.
#
# The archive links into a binary built by the HOST's C compiler, so the
# image's glibc must not be newer than the host's; the Makefile's link step
# is where that would show, as an undefined versioned symbol.
set -euo pipefail
readonly RUST_IMAGE="$(sed -n 's/^readonly RUST_IMAGE="\(.*\)"$/\1/p' "$(dirname "$0")/wasm.sh")"
[ -n "$RUST_IMAGE" ] || { echo "shottino-cargo: cannot read RUST_IMAGE from scripts/wasm.sh" >&2; exit 1; }
exec docker run --rm -u "$(id -u):$(id -g)" \
	-e CARGO_HOME=/src/.cargo-home \
	-v "$PWD:/src" -w /src "$RUST_IMAGE" cargo "$@"
