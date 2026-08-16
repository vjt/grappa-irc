#!/usr/bin/env bats
#
# #1429 — the gap scanner's own definition, pinned.
#
# WHY THIS FILE EXISTS. The census used to be a report: if it drifted, a
# number in an investigation drifted with it and somebody would notice
# the next time they read it. It is not a report any more —
# `scripts/integration.sh` asks it whether a GREEN run tripped, and keeps
# or discards ~275 MB of forensic evidence on the answer. A silent change
# to what counts as a gap therefore changes the RETENTION policy without
# changing a line of the script that implements it.
#
# So every clause of the definition is pinned here: the threshold
# boundary, the arithmetic, the rollover, and one assertion per damage
# signature. The scanner is fed on stdin, which is how integration.sh
# uses it — no fixture files, no stack, no lane.

load ../bats_helpers

setup() {
    SCANNER="$BATS_TEST_DIRNAME/../../scripts/log-gap-scan.awk"
    [ -f "$SCANNER" ]
}

# The scanner as integration.sh invokes it: a service label and a
# threshold in seconds, stream on stdin.
scan() {
    awk -v SVC=svc -v THRESH="$1" -f "$SCANNER"
}

# A `docker logs --timestamps` line: RFC3339 stamp, then the payload.
stamp() {
    printf '2026-08-16T%s000000Z %s\n' "$1" "$2"
}

@test "a silence AT the threshold is named; one just below it is not" {
    # The boundary is the whole contract: it is what decides whether a
    # green run's bytes are kept. Both halves, or the pin proves nothing.
    local out
    out="$( { stamp '12:00:00.' quiet; stamp '12:00:10.' quiet; } | scan 10 )"
    grep -q 'svc	GAP	10.0' <<<"$out"
    grep -q 'gaps_ge_10=1' <<<"$out"

    out="$( { stamp '12:00:00.' quiet; stamp '12:00:09.9' quiet; } | scan 10 )"
    refute grep -q 'GAP' <<<"$out"
    grep -q 'gaps_ge_10=0' <<<"$out"
    # ...and it is still MEASURED, just not named: a sub-threshold silence
    # that vanished from maxgap would hide the run drifting toward the line.
    grep -q 'maxgap=9.9' <<<"$out"
}

@test "maxgap reports the LARGEST silence and the stamp it started at" {
    local out
    out="$( {
        stamp '12:00:00.' a
        stamp '12:00:02.' b     # 2 s
        stamp '12:00:32.' c     # 30 s — the winner, starting at 12:00:02
        stamp '12:00:33.' d     # 1 s
    } | scan 10 )"

    grep -q 'maxgap=30.0' <<<"$out"
    grep -q 'maxgap_at=12:00:02.000' <<<"$out"
    # Only the one over the threshold is named individually.
    grep -q 'gaps_ge_10=1' <<<"$out"
}

@test "a silence across midnight is a silence, not a negative number" {
    # Without the rollover this reads as -86390 s, which is not merely
    # wrong: it is BELOW the threshold, so a stall spanning midnight would
    # discard the bytes that prove it.
    local out
    out="$( { stamp '23:59:59.' before; stamp '00:00:09.' after; } | scan 10 )"
    grep -q 'svc	GAP	10.0' <<<"$out"
    grep -q 'maxgap=10.0' <<<"$out"
}

@test "each damage signature is counted by itself and not by another" {
    local out
    out="$( {
        stamp '12:00:00.' 'db=30064.1ms query returned'
        stamp '12:00:01.' 'conn idle=30062.4ms checked out'
        stamp '12:00:02.' 'scrollback row dropped for #bofh'
        stamp '12:00:03.' 'pool saturated for the full 30s'
    } | scan 10 )"

    grep -q 'db30=1' <<<"$out"
    grep -q 'idle30=1' <<<"$out"
    grep -q 'dropped=1' <<<"$out"
    grep -q 'saturated=1' <<<"$out"
}

@test "a sub-30s duration does not score as a 30-something hold" {
    # db=3xxxx matches 30000-39999 ms. 2999.9 and 4000.1 are the
    # neighbours that would fall in if the pattern lost a digit.
    local out
    out="$( {
        stamp '12:00:00.' 'db=2999.9ms fast'
        stamp '12:00:01.' 'db=4000.1ms slowish'
    } | scan 10 )"

    grep -q 'db30=0' <<<"$out"
}

@test "untimestamped lines are counted, but never form a gap" {
    # docker interleaves the odd unprefixed line (a container's own
    # multi-line output). Treating one as a stamp would invent silences.
    local out
    out="$( {
        stamp '12:00:00.' first
        printf 'a bare continuation line\n'
        stamp '12:00:02.' second
    } | scan 10 )"

    grep -q 'lines=3' <<<"$out"
    grep -q 'maxgap=2.0' <<<"$out"
    grep -q 'gaps_ge_10=0' <<<"$out"
}

@test "an empty stream reads as quiet rather than as an error" {
    # A container that logged nothing must still produce its row, or the
    # census silently loses a service instead of reporting a silent one.
    local out
    out="$( printf '' | scan 10 )"
    grep -q 'svc	SUMMARY	lines=0' <<<"$out"
    grep -q 'maxgap=0.0' <<<"$out"
}

@test "a missing threshold is refused, not defaulted" {
    # A census measured against a threshold the caller forgot still looks
    # plausible, and would be read as one measured against the intended
    # one. Refusing is the only honest answer.
    run awk -v SVC=svc -f "$SCANNER" </dev/null
    [ "$status" -eq 2 ]
    [[ "$output" == *"THRESH"* ]]
    refute grep -q 'SUMMARY' <<<"$output"
}
