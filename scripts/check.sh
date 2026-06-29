#!/usr/bin/env bash
# Run the full CI gate locally inside the container.
#
# Usage:
#   scripts/check.sh
#
# Same gates as the `ci` GitHub workflow. Two-stage:
#
#   stage 1: `mix ci.check` alias (defined in mix.exs:140-180):
#     - mix compile --warnings-as-errors  (Boundary compiler fails on cross-boundary violations)
#     - mix format --check-formatted
#     - mix credo --strict
#     - mix deps.audit
#     - mix hex.audit
#     - mix sobelow --config --exit Medium
#     - mix doctor
#     - cmd env MIX_ENV=test mix test --warnings-as-errors  (shells out so Repo gets Sandbox)
#     - mix dialyzer
#     - mix docs (build check)
#
#   stage 2 (this script):
#     - mix grappa.gen_wire_types --check  (cic↔server wire-shape drift gate; codegen cluster H1-H6)
#     - scripts/bats.sh  (host-side bats for bin/grappa dispatcher; submodule vendor/bats-core)
#
# Pins MIX_ENV=dev via scripts/mix.sh because ci.check runs credo +
# sobelow + doctor + ex_doc, all `only: [:dev, :test]` deps. The test
# sub-step uses `cmd env MIX_ENV=test` to shell out into a fresh mix
# process so Repo gets the Sandbox pool — without the cmd shell-out,
# `mix test` inside the alias inherits the parent's :dev env and
# corrupts the run.
#
# Exit non-zero if any gate fails. Same gates as CI workflow, run identically.
#
# Canonical "which test runner do I use?" docs: docs/TESTING.md.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

"$SRC_ROOT/scripts/mix.sh" --env=dev ci.check
# Drift gate for cicchetto/src/lib/wireTypes.ts — regenerates the file
# in memory and diffs against the committed copy. Fails with a clear
# error message pointing the operator at `scripts/mix.sh
# grappa.gen_wire_types` when a Wire typespec was edited without
# regenerating. Closes the C1/C2/H1-H6 drift class structurally per
# the codegen cluster's "structural drift prevention" goal.
"$SRC_ROOT/scripts/mix.sh" --env=dev grappa.gen_wire_types --check
"$SRC_ROOT/scripts/bats.sh"
