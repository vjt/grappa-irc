#!/usr/bin/env bats
#
# A guard over the test suites themselves (#745).
#
# `! cmd` at the top level of a bats test body cannot fail the case
# unless it happens to be the last line — bash suppresses errexit for an
# inverted status. Every such assertion is therefore either dead or one
# appended line away from becoming dead, silently.
#
# `refute` (test/bats_helpers.bash) is the replacement: an ordinary
# function call, so errexit applies wherever it sits in the body.
#
# This guard is the reason the class cannot come back. Fixing the 79
# sites was the one-off; this is the part that keeps them fixed.

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
}

@test "no bats body asserts with a bare inverted command (use refute)" {
    cd "$REPO_ROOT"

    # First non-blank token on the line is `!`. Deliberately does NOT
    # match the legitimate spellings, all of which keep errexit:
    #   `if ! cmd; then`     — condition context, negation is the point
    #   `[ ! -f "$path" ]`   — the `!` belongs to the test builtin, and
    #                          `[` itself returns non-zero, so errexit fires
    #   `while ! cmd; do`    — condition context
    local offenders
    offenders="$(grep -rnE '^[[:space:]]*![[:space:]]' \
        test/bin test/infra test/scripts --include='*.bats' || true)"

    if [ -n "$offenders" ]; then
        printf 'Bare inverted assertions found — these cannot fail the test:\n%s\n' \
            "$offenders" >&2
        printf '\nReplace `! cmd` with `refute cmd` (test/bats_helpers.bash).\n' >&2
        return 1
    fi
}

@test "every suite that calls refute has loaded the helper" {
    cd "$REPO_ROOT"

    local missing=""
    for f in test/bin/*.bats test/infra/*.bats test/scripts/*.bats; do
        grep -qE '^[[:space:]]*refute[[:space:]]' "$f" || continue
        grep -qE '^load .*bats_helpers' "$f" || missing="$missing$f"$'\n'
    done

    if [ -n "$missing" ]; then
        printf 'These call refute without loading the helper:\n%s' "$missing" >&2
        return 1
    fi
}

@test "refute fails the case when the command succeeds" {
    # The property the whole change rests on, pinned here so a future
    # edit to the helper cannot quietly restore the old no-op behaviour.
    load ../bats_helpers

    run refute true
    [ "$status" -ne 0 ]
    [[ "$output" == *"SUCCEEDED"* ]]

    run refute false
    [ "$status" -eq 0 ]
}
