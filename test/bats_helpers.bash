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
#
# `cmd` must be a COMMAND, not a shell keyword: `[[ ... ]]` and
# `(( ... ))` are parsed by the shell, not looked up, so `refute [[ -f x ]]`
# dies with "command not found". Use `refute test -f x` (or `refute [ -f x ]`).
#
# An exit status of 2-or-more is treated as a FAILURE of the assertion,
# not as a satisfied negation. For the greps these assertions are built
# on, 1 means "looked, found nothing" while 2 means "could not look" —
# a missing log file, a bad pattern. Passing on 2 would let an assertion
# hold vacuously against a file that never existed, which is the same
# class of silent no-op this helper was written to remove.
refute() {
    local rc=0
    "$@" || rc=$?

    if [ "$rc" -eq 0 ]; then
        printf 'refute: expected a non-zero exit, but this SUCCEEDED:\n    %s\n' "$*" >&2
        return 1
    fi

    if [ "$rc" -gt 1 ]; then
        printf 'refute: command ERRORED (rc=%s) so the assertion proves nothing:\n    %s\n' \
            "$rc" "$*" >&2
        return 1
    fi

    return 0
}

# Numeric permission bits of a file ("640"), on both userlands.
#
# NOT `stat -f '%Lp' f || stat -c '%a' f`. `-f` is the FORMAT flag on BSD
# stat and `--file-system` on GNU stat, so on Linux that spelling asks for
# filesystem status, treats the format string as a second file operand, and
# exits non-zero — AFTER printing six lines of filesystem status to stdout.
# `||` then appends the fallback's "640" to them, and the caller compares a
# seven-line blob against "640". Measured on ubuntu:24.04 (GNU coreutils
# 9.4): the assertion could not pass on a Linux runner, and was green on
# the maintainer's darwin box only because BSD stat reads `-f` the other way.
#
# So: probe GNU FIRST (the failing spelling there is `-c`, which BSD rejects
# as an illegal option without writing to stdout), and CAPTURE rather than
# chain — a fallback must replace the first attempt's output, never be
# concatenated onto it.
file_mode() {
    local mode
    if mode="$(stat -c '%a' "$1" 2>/dev/null)"; then
        printf '%s\n' "$mode"
        return 0
    fi
    stat -f '%Lp' "$1"
}
