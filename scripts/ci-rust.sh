#!/usr/bin/env bash
# scripts/ci-rust.sh — put the pinned Rust toolchain on a CI runner's PATH.
#
# shottino links vodozemac through a Rust staticlib (frontends/shottino/
# e2e/vodozemac-c), so every job that builds shottino needs cargo. The
# version is the one scripts/wasm.sh's image pins, so CI, a dev box (through
# scripts/shottino-cargo.sh) and cicchetto's wasm build all compile vodozemac
# with ONE rustc. Ubuntu's own apt cargo is too old for the crate's edition.
#
# GitHub's hosted runners carry rustup; this installs the toolchain through
# it and makes it the default, then exports PATH for later steps.
#
# This file names no image, and it is spelled so the #103 digest-pin gate
# (test/infra/base_image_digest_pin_test.bats) agrees: that gate reads
# `rust:` after a non-letter as a reference to the rust image, so the pattern
# below matches the colon with `.` and the messages carry the script's own
# name rather than a literal `ci-rust:` prefix. The file stays under the
# gate, so an image this script did pull would still have to be pinned.
set -euo pipefail
prog="${0##*/}"
version="$(sed -n 's/^readonly RUST_IMAGE="rust.\([0-9.]*\)-.*$/\1/p' "$(dirname "$0")/wasm.sh")"
[ -n "$version" ] || { echo "$prog: cannot read the rust version from scripts/wasm.sh" >&2; exit 1; }
command -v rustup >/dev/null || { echo "$prog: no rustup on this runner" >&2; exit 1; }
rustup toolchain install "$version" --profile minimal --no-self-update
rustup default "$version"
[ -n "${GITHUB_PATH:-}" ] && echo "$HOME/.cargo/bin" >>"$GITHUB_PATH"
cargo --version
