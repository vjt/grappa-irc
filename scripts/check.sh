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
#     - cmd env MIX_ENV=test mix doctor  (shells out: in :dev doctor scores
#       test-gated functions as undocumented, and never scans test/support — #621)
#     - cmd env MIX_ENV=test mix test --warnings-as-errors  (shells out so Repo gets Sandbox)
#     - mix dialyzer
#     - mix docs (build check)
#
#   stage 2 (this script):
#     - mix grappa.gen_wire_types --check  (cic↔server wire-shape drift gate; codegen cluster H1-H6)
#     - scripts/bats.sh  (host-side bats for bin/grappa dispatcher; submodule vendor/bats-core)
#
# Pins MIX_ENV=dev via scripts/mix.sh because ci.check runs credo +
# sobelow + ex_doc, all `only: [:dev, :test]` deps. Two sub-steps shell
# out of that pin with `cmd env MIX_ENV=test`: the test run (so Repo gets
# the Sandbox pool — inside an alias `mix test` inherits the parent's :dev
# env and corrupts the run) and, since #621, doctor (so its counts are
# honest and its file set matches the GH job's).
#
# Exit non-zero if any gate fails. Same gates as CI workflow, run identically.
#
# Canonical "which test runner do I use?" docs: docs/TESTING.md.

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

"$SRC_ROOT/scripts/mix.sh" --env=dev ci.check
# #621 — the CI-parity doctor run that used to live HERE moved INTO the
# `ci.check` alias as `cmd env MIX_ENV=test mix doctor`. It was added by #75
# (a 4-red-commits post-mortem) as a SECOND run, because the alias's own
# doctor was pinned to the alias's :dev env and so never scanned
# `test/support` the way the GH job does. That left two doctor runs, one of
# them scoring `Mix.env() == :test` seams as undocumented. Making the
# alias's run the :test one collapses them to one honest run, identical to
# the workflow's single `mix doctor` step — so local == GH is preserved by
# construction rather than by a duplicate kept in step by hand.
# Drift gate for cicchetto/src/lib/wireTypes.ts — regenerates the file
# in memory and diffs against the committed copy. Fails with a clear
# error message pointing the operator at `scripts/mix.sh
# grappa.gen_wire_types` when a Wire typespec was edited without
# regenerating. Closes the C1/C2/H1-H6 drift class structurally per
# the codegen cluster's "structural drift prevention" goal.
"$SRC_ROOT/scripts/mix.sh" --env=dev grappa.gen_wire_types --check
"$SRC_ROOT/scripts/bats.sh"
