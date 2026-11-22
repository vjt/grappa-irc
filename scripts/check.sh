#!/usr/bin/env bash
# Run the full CI gate locally inside the container.
#
# Usage:
#   scripts/check.sh
#
# Same gates as the `ci` GitHub workflow, in two stages:
#
#   stage 1: the `mix ci.check` alias in mix.exs (the gate list lives there).
#   stage 2 (this script): the cic↔server wire-shape drift gate, the #1393d
#            wire-shape pin, the issue 2690 ratchet and its git half, then
#            the host-side bats suite.
#
# Pins MIX_ENV=dev via scripts/mix.sh (credo / sobelow / ex_doc are dev-only
# deps). Two sub-steps inside the alias shell out with `cmd env MIX_ENV=test`:
# the test run (so Repo gets the Sandbox pool) and, since #621, doctor.
# Why: docs/OPERATIONS.md § "Developer and deploy scripts (scripts/*.sh)".
#
# Canonical "which test runner do I use?" docs: docs/TESTING.md.

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

"$SRC_ROOT/scripts/mix.sh" --env=dev ci.check
# Do NOT re-add a second `mix doctor` run here — it belongs in the ci.check
# alias, at MIX_ENV=test.
# Why: docs/TESTING.md § "What each script actually runs" (#621).
#
# Drift gate for cicchetto/src/lib/wireTypes.ts — regenerates the file in
# memory and diffs it against the committed copy.
"$SRC_ROOT/scripts/mix.sh" --env=dev grappa.gen_wire_types --check
#
# #1393d — the wire-shape pin: fails when the generated shape moved and
# `Grappa.Protocol.version/0` did not. A SEPARATE gate from the line above
# because that one has no BEFORE — it diffs the artefact against its own
# source, so a regenerated additive field reads `in sync.`, which is the
# case this rule exists for. The BEFORE is priv/wire/shape.pin; no network.
"$SRC_ROOT/scripts/mix.sh" --env=dev grappa.wire_pin --check
#
# issue 2690 — the ratchet: fails when Session.Server's state keys, its
# handle_call/handle_info clauses or any boundary's `deps:` count moved off
# priv/ratchet/ratchet.pin. Offline like the pin above.
"$SRC_ROOT/scripts/mix.sh" --env=dev grappa.ratchet --check
# Its git half: a commit that RAISES a recorded value names the key in a
# DESIGN_NOTES line in the same commit. Run from SRC_ROOT, because the
# commits to judge are the worktree's branch, not main's.
(cd "$SRC_ROOT" && scripts/ratchet-gate.sh)
"$SRC_ROOT/scripts/bats.sh"
