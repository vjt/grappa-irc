#!/usr/bin/env bash
#
# Shared assertions for the bats suites (test/bin, test/infra, test/scripts).
#
# WHY THIS FILE EXISTS — the `! cmd` trap (#745)
#
# Bash suppresses `errexit` for a command whose status is inverted with
# `!` (POSIX: "the shell does not exit if the command that fails is ...
# the command whose return status is being inverted with !"). Bats runs
# a test body under `set -e`, so a bare
#
#     ! grep -q "should not be here" "$LOG"
#
# only fails the case when it is the LAST line of the test. Anywhere
# else it is a no-op: the grep matches, the negation yields 1, errexit
# stays quiet, the body runs on, and the test reports ok. Measured on
# the vendored bats 1.9.0 — a mid-test `! true` reports `ok`, the same
# line as the final statement reports `not ok`.
#
# That made 23 assertions across the suites unable to fail, and left the
# other 56 live only by the accident of being written last — one
# appended line would have killed any of them silently.
#
# `refute` closes it because a FUNCTION CALL is an ordinary command: its
# non-zero return is not an inverted status, so errexit fires normally
# wherever it appears in the body.

# Fail the test when `cmd` SUCCEEDS. The inverse of running `cmd` bare.
#
#     refute grep -q "run --no-start" "$ARGV_LOG"
#
# For something that was a pipeline under the old spelling, feed the
# subject in rather than piping into `refute`:
#
#     refute grep -q 'partial-release' <<<"$output"
refute() {
    if "$@"; then
        printf 'refute: expected a non-zero exit, but this SUCCEEDED:\n    %s\n' "$*" >&2
        return 1
    fi
    return 0
}
