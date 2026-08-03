#!/usr/bin/env bats
#
# A guard over the test suites themselves (#745).
#
# A negated command at the top level of a bats test body cannot fail the
# case unless it happens to be the last line — bash suppresses errexit
# for an inverted status. Every such assertion is therefore either dead
# or one appended line away from becoming dead, silently.
#
# `refute` (test/bats_helpers.bash) is the replacement: an ordinary
# function call, so errexit applies wherever it sits in the body.
#
# This guard is the reason the class cannot come back. Fixing the 79
# sites was the one-off; this is the part that keeps them fixed.
#
# Every check enumerates the suites with `find`, deliberately NOT a
# hardcoded directory list: scripts/bats.sh names the three directories
# it runs, and a guard carrying its own copy would silently stop
# covering a fourth one the day somebody adds it.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"

    # Wider than "the line starts with a bang": errexit is suppressed for
    # an inverted status ANYWHERE a command can begin, so a bang after
    # `;`, `&&`, `||`, `|`, `(` or `{` is just as dead.
    PATTERN='(^[[:space:]]*|[;&|({][[:space:]]*)![[:space:]]'
}

# Every .bats file under test/, as an array (no xargs: it reports 123
# when the command it runs exits 1, which would mask grep's own
# "found nothing" and turn a clean scan into a guard failure).
suite_files() {
    local f
    SUITES=()
    while IFS= read -r f; do SUITES+=("$f"); done \
        < <(find "$REPO_ROOT/test" -name '*.bats' -type f | sort)
}

@test "no bats body asserts with a bare inverted command (use refute)" {
    suite_files

    # grep: 0 = matches, 1 = none, 2+ = it could not look. Only 1 is a
    # clean bill of health — treating 2 as "no offenders" would make this
    # guard fail OPEN, the very shape it exists to catch.
    local offenders rc=0
    offenders="$(grep -nE "$PATTERN" "${SUITES[@]}")" || rc=$?

    if [ "$rc" -gt 1 ]; then
        printf 'guard could not scan the suites (grep rc=%s)\n' "$rc" >&2
        return 1
    fi

    if [ -n "$offenders" ]; then
        printf 'Bare inverted assertions found — these cannot fail the test:\n%s\n' \
            "$offenders" >&2
        printf '\nReplace with `refute cmd` (test/bats_helpers.bash).\n' >&2
        return 1
    fi
}

@test "the guard catches every position a bare negation can hide in" {
    # The dead spellings are ASSEMBLED rather than written literally: a
    # literal one would be found by the scan above, in this very file.
    # Each of these reports ok as a mid-test line on bats 1.9.0.
    local b='!'
    local dead=(
        "    $b grep -q x \$LOG"
        "$(printf '\t')$b grep -q x \$LOG"
        "    { $b true; }"
        "    true && $b true"
        "    true; $b true"
        "    true || $b true"
    )

    local d
    for d in "${dead[@]}"; do
        grep -qE "$PATTERN" <<<"$d" \
            || { printf 'guard would MISS this dead spelling: %s\n' "$d" >&2; return 1; }
    done

    # ...and narrow enough not to flag the spellings that DO keep errexit.
    # The first three are condition contexts where inverting is the point;
    # in the last two the bang belongs to the test builtin (or to `!=`),
    # and `[` returns non-zero itself, so errexit still trips.
    local live=(
        '    if ! grep -q x "$LOG"; then'
        '    while ! grep -q x "$LOG"; do'
        '    until ! grep -q x "$LOG"; do'
        '    [ ! -f "$path" ]'
        '    [ "$a" != "$b" ]'
    )

    local l
    for l in "${live[@]}"; do
        refute grep -qE "$PATTERN" <<<"$l"
    done
}

@test "every suite that calls refute has loaded the helper" {
    suite_files

    local missing="" f
    for f in "${SUITES[@]}"; do
        grep -qE '^[[:space:]]*refute[[:space:]]' "$f" || continue
        grep -qE '^[[:space:]]*load[[:space:]].*bats_helpers' "$f" \
            || missing="$missing$f"$'\n'
    done

    if [ -n "$missing" ]; then
        # A missing function is "command not found" — non-zero — so an
        # unloaded `refute` reads as a satisfied negation. Silent, again.
        printf 'These call refute without loading the helper:\n%s' "$missing" >&2
        return 1
    fi
}

@test "refute fails the case when the command succeeds" {
    # The property the whole change rests on, pinned so a future edit to
    # the helper cannot quietly restore the old no-op behaviour.
    run refute true
    [ "$status" -ne 0 ]
    [[ "$output" == *"SUCCEEDED"* ]]

    run refute false
    [ "$status" -eq 0 ]
}

@test "refute refuses to pass on a command that could not look" {
    # grep 2 = "could not look" (missing file, bad pattern). Passing on it
    # would let an assertion hold vacuously against a log that never
    # existed — and most of these logs are created by a stub when it runs,
    # not by setup, so "the file is absent" is a reachable state.
    run refute grep -q 'anything' "$BATS_TEST_TMPDIR/does-not-exist"
    [ "$status" -ne 0 ]
    [[ "$output" == *"ERRORED"* ]]
}
