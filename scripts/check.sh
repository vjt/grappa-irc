#!/usr/bin/env bash
# Run the full CI gate locally inside the container.
#
# Usage:
#   scripts/check.sh
#
# Equivalent to the `mix ci.check` alias defined in mix.exs:
#   - mix format --check-formatted
#   - mix credo --strict
#   - mix deps.audit (mix_audit) + mix hex.audit
#   - mix sobelow --config --exit Medium
#   - mix doctor
#   - mix test --warnings-as-errors --cover
#   - mix dialyzer
#   - mix docs (build check)
#
# Plus the bats suite for host-side bash dispatchers (bin/grappa) — runs
# on the host (no container).
#
# Pins MIX_ENV=dev via scripts/mix.sh because ci.check runs credo +
# sobelow + doctor + ex_doc, all `only: [:dev, :test]` deps.
#
# Exit non-zero if any gate fails. Same gates as CI workflow, run identically.

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
