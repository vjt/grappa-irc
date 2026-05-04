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
# Exit non-zero if any gate fails. Same gates as CI workflow, run identically.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

in_container_or_oneshot mix ci.check
