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
set -euo pipefail
version="$(sed -n 's/^readonly RUST_IMAGE="rust:\([0-9.]*\)-.*$/\1/p' "$(dirname "$0")/wasm.sh")"
[ -n "$version" ] || { echo "ci-rust: cannot read the rust version from scripts/wasm.sh" >&2; exit 1; }
command -v rustup >/dev/null || { echo "ci-rust: no rustup on this runner" >&2; exit 1; }
rustup toolchain install "$version" --profile minimal --no-self-update
rustup default "$version"
[ -n "${GITHUB_PATH:-}" ] && echo "$HOME/.cargo/bin" >>"$GITHUB_PATH"
cargo --version
