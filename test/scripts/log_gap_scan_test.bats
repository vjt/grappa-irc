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

    # Verbatim from the call sites, so a pin that drifts from production
    # prose fails here rather than reporting a confident zero.
    #   lock_watch.ex — the two edges of one stall episode
    #   busy_retry.ex — the four terminal arms, one per fault kind
    LOCKSTALL_LINE='db lock stall: holder #PID<0.512.0> has held RESERVED for 30123ms with 2 waiter(s) queued — holder status=:runnable at :gen_server.loop/7, stack: a <- b'
    LOCKRESOLVED_LINE='db lock stall RESOLVED: holder #PID<0.512.0> released RESERVED after 30456ms'
    LOCKUNATTR_LINE='db lock stall UNATTRIBUTED: 3 writer(s) queued past the threshold, longest 31303ms — no holder registered, so the holder is NOT attributable at the BEGIN IMMEDIATE seam; longest waiter #PID<0.512.0> status=:waiting at :gen_server.loop/7, stack: a <- b'
    LOCKNIF_LINE='db lock stall NIF CENSUS: 2 process(es) parked inside Exqlite.Sqlite3NIF past the threshold, longest 31402ms — none of them registered at the BEGIN IMMEDIATE seam, so all 2 are writers it cannot name; roster: #PID<0.512.0> 31402ms Exqlite.Sqlite3NIF.step/2, #PID<0.513.0> 30011ms Exqlite.Sqlite3NIF.execute/2; longest #PID<0.512.0> status=:running at Exqlite.Sqlite3NIF.step/2, stack: a <- b'
    LOCKHELD_LINE='db write unavailable: SQLite write lock held by another writer for 30067ms across 1 attempts (1500ms retry budget) — returning :db_unavailable'
    SATURATED_LINE='db write unavailable: SQLite pool saturated for 1512ms across 14 attempts (1500ms retry budget) — returning :db_unavailable'
    # #1657 — the third arm. The elapsed is ~15s because a cancellation is
    # raised only once DBConnection's own `:timeout` has expired, which is
    # also why its attempt count is 1 and not 14 like the saturated line.
    INTERRUPTED_LINE='db write unavailable: SQLite statement cancelled by a pool timeout for 15042ms across 1 attempts (1500ms retry budget) — returning :db_unavailable'
    # #1708 — the fourth arm, and the only one that does NOT open with "db
    # write unavailable": its statement completed, so the row is durable and
    # the prose must not send an operator hunting for it. Attempt count is 1
    # by VERDICT here (the fault is classified non-retryable) rather than
    # because a budget expired.
    ORPHANED_LINE='db write landed but its result was lost: SQLite connection closed after the write completed, 15042ms into the write, on attempt 1 (not retried — the row is durable, a retry would duplicate it) — returning :db_unavailable'
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
        stamp '12:00:03.' "$SATURATED_LINE"
        stamp '12:00:04.' "$LOCKHELD_LINE"
        stamp '12:00:05.' "$LOCKSTALL_LINE"
        stamp '12:00:06.' "$LOCKRESOLVED_LINE"
        stamp '12:00:07.' "$INTERRUPTED_LINE"
        stamp '12:00:08.' "$ORPHANED_LINE"
    } | scan 10 )"

    grep -q 'db30=1' <<<"$out"
    grep -q 'idle30=1' <<<"$out"
    grep -q 'dropped=1' <<<"$out"
    grep -q 'saturated=1' <<<"$out"
    # #1657 — and specifically NOT folded into `saturated`, which stays 1.
    grep -q 'interrupted=1' <<<"$out"
    # #1708 — nor into `interrupted`, nor into `dropped`: the write LANDED, so
    # counting it as a lost row is the one reading the census must not offer.
    grep -q 'orphaned=1' <<<"$out"
    grep -q 'lockheld=1' <<<"$out"
    grep -q 'lockstall=1' <<<"$out"
    grep -q 'lockstall_resolved=1' <<<"$out"
}

# --- #1420: the LockWatch verdict has to reach a GREEN run's artefact ------
#
# `container-logs` uploads on failure only; this census uploads always. #1420
# measured 9 stalled attempts with LockWatch compiled in and only 3 readable —
# the other 6 (5 green, 1 cancelled) threw the instrument's verdict away by
# construction. These two counters are what puts it in the artefact that
# survives.

@test "a LockWatch stall episode is counted at BOTH edges" {
    local out
    out="$( {
        stamp '12:00:00.' "$LOCKSTALL_LINE"
        stamp '12:00:30.' "$LOCKRESOLVED_LINE"
    } | scan 60 )"

    grep -q 'lockstall=1' <<<"$out"
    grep -q 'lockstall_resolved=1' <<<"$out"
}

@test "the RESOLVED edge alone does not score as a DETECTION" {
    # The substring trap, and the reason these are two counters rather than
    # one `db lock stall`: the RESOLVED line CONTAINS that phrase, so a
    # counter anchored on it would report an episode that never opened —
    # and, worse, report a resolved stall as an unresolved one.
    local out
    out="$( stamp '12:00:00.' "$LOCKRESOLVED_LINE" | scan 10 )"

    grep -q 'lockstall=0' <<<"$out"
    grep -q 'lockstall_resolved=1' <<<"$out"
}

@test "a DETECTION alone does not score as RESOLVED" {
    # The other side, and the one that matters most in a census: an episode
    # that never closed is the stall still running when the run ended.
    local out
    out="$( stamp '12:00:00.' "$LOCKSTALL_LINE" | scan 10 )"

    grep -q 'lockstall=1' <<<"$out"
    grep -q 'lockstall_resolved=0' <<<"$out"
}

# --- #1687: the episode that named NOBODY has to reach the artefact too ----
#
# Prod, 2026-08-22: LockWatch armed at `stall_threshold_ms: 2_000` through a
# ~170 s episode with 23 `busy_locked` terminals, and BOTH counters above read
# zero — because `observe/1`'s only producer is `immediate_transaction/1` while
# the writer that dominates the hot path is a bare autocommit `Repo.insert`. A
# census that can only count NAMED episodes reports a clean run for exactly the
# incident it exists to catch.

@test "an UNATTRIBUTED episode is counted, and not as a named stall" {
    local out
    out="$( stamp '12:00:00.' "$LOCKUNATTR_LINE" | scan 10 )"

    grep -q 'lockstall_unattributed=1' <<<"$out"
    # The discrimination that matters: `lockstall` means a holder was NAMED.
    # Folding the two would let an episode nobody could attribute be read off
    # the artefact as one that was — the census asserting an attribution the
    # instrument explicitly declined to make.
    grep -q 'lockstall=0' <<<"$out"
    grep -q 'lockstall_resolved=0' <<<"$out"
}

# --- #1901: the census that reads the NIF, not the seam --------------------
#
# All four #1888 episodes had the shape the three counters above cannot
# express: writers demonstrably stuck, nobody registered at the seam, and no
# queue the seam could measure either — so `lockstall`, `lockstall_resolved`
# AND `lockstall_unattributed` all read zero while the node was frozen for
# 31 s. This is the counter that can be non-zero in exactly that state.

@test "a NIF CENSUS is counted, and not as any of the three seam verdicts" {
    local out
    out="$( stamp '12:00:00.' "$LOCKNIF_LINE" | scan 10 )"

    grep -q 'lockstall_nif=1' <<<"$out"
    # The discrimination, and it runs in both directions. `lockstall` means a
    # holder was NAMED and `lockstall_unattributed` means a queue was MEASURED
    # with nobody to blame; a census established neither, it photographed a
    # cohort. Folding it into either would let an artefact report an
    # attribution the instrument explicitly declined to make.
    grep -q 'lockstall=0' <<<"$out"
    grep -q 'lockstall_resolved=0' <<<"$out"
    grep -q 'lockstall_unattributed=0' <<<"$out"
}

@test "a NAMED stall does not score as a NIF census" {
    local out
    out="$( {
        stamp '12:00:00.' "$LOCKSTALL_LINE"
        stamp '12:00:30.' "$LOCKRESOLVED_LINE"
        stamp '12:00:31.' "$LOCKUNATTR_LINE"
    } | scan 60 )"

    grep -q 'lockstall_nif=0' <<<"$out"
}

@test "a NAMED stall does not score as unattributed" {
    local out
    out="$( {
        stamp '12:00:00.' "$LOCKSTALL_LINE"
        stamp '12:00:30.' "$LOCKRESOLVED_LINE"
    } | scan 60 )"

    grep -q 'lockstall_unattributed=0' <<<"$out"
}

@test "a retry budget exhausted on the write LOCK is counted apart from a saturated POOL" {
    # #1420 measured 4 terminal BusyRetry observations in CI, all four
    # `fault=busy_locked` — i.e. lock contention wearing a pool label. The
    # prose split at the call site is worth nothing if the census re-merges
    # them here.
    local out
    out="$( stamp '12:00:00.' "$LOCKHELD_LINE" | scan 10 )"
    grep -q 'lockheld=1' <<<"$out"
    grep -q 'saturated=0' <<<"$out"

    out="$( stamp '12:00:00.' "$SATURATED_LINE" | scan 10 )"
    grep -q 'saturated=1' <<<"$out"
    grep -q 'lockheld=0' <<<"$out"
}

@test "both terminal counters survive a change to the line's numeric tail" {
    # #1421 moved that tail: it used to read "for the full 1500ms retry
    # budget" and now carries the OBSERVED elapsed, which varies per event.
    # The anchors are the `observed_state/1` phrases alone precisely so the
    # next number that moves does not blind the census — a pattern that
    # stopped matching reports zero, and zero is what a clean run looks like.
    local out
    out="$( {
        stamp '12:00:00.' 'db write unavailable: SQLite pool saturated for 9ms across 2 attempts (7ms retry budget) — returning :db_unavailable'
        stamp '12:00:01.' 'db write unavailable: SQLite write lock held by another writer for 123456ms across 3 attempts (7ms retry budget) — returning :db_unavailable'
    } | scan 10 )"

    grep -q 'saturated=1' <<<"$out"
    grep -q 'lockheld=1' <<<"$out"
}

# --- the scanner's own controls -------------------------------------------
#
# The counters above are only worth their numbers if a broken pattern is
# LOUD rather than zero. The scanner carries three controls in BEGIN —
# known answer, invented line, complete set — and refuses to print a census
# when one fails. A control nobody has seen fire is not a control, so each is
# exercised by corrupting a COPY (the complete-set one in both directions).

# A copy of the scanner with one sed applied. The edit must actually change
# something, or the test would pass against an untouched script.
corrupted_scanner() {
    local out="$BATS_TEST_TMPDIR/scanner.awk"
    sed "$1" "$SCANNER" >"$out"
    refute cmp -s "$out" "$SCANNER"
    printf '%s' "$out"
}

@test "the shipped scanner passes its own controls and prints its census" {
    # The positive side. Without it the three corruption tests below could
    # all be passing because the scanner never runs at all.
    run awk -v SVC=svc -v THRESH=10 -f "$SCANNER" </dev/null
    [ "$status" -eq 0 ]
    grep -q 'svc	SUMMARY	lines=0' <<<"$output"
    refute grep -q 'CONTROL FAILED' <<<"$output"
}

@test "a known-answer control failure prints NO numbers" {
    # A pattern that stopped matching the line it exists for reports zero,
    # and a zero is what a clean run looks like. Break the db30 sample so it
    # no longer raises its counter.
    local mutated
    mutated="$(corrupted_scanner 's/db=30064\.1ms/db=1.1ms/')"

    run awk -v SVC=svc -v THRESH=10 -f "$mutated" </dev/null
    [ "$status" -eq 3 ]
    [[ "$output" == *"db30"* ]]
    refute grep -q $'\tSUMMARY\t' <<<"$output"
}

@test "two patterns that do not discriminate print NO numbers" {
    # The trap this slice exists for, as a mutant: loosen the DETECTION
    # anchor to the bare phrase and it swallows the RESOLVED line too. The
    # known-answer control's cross-talk arm is what names both signatures
    # instead of quietly reporting an episode that never opened.
    local mutated
    mutated="$(corrupted_scanner 's|/db lock stall: holder /|/db lock stall/|')"

    run awk -v SVC=svc -v THRESH=10 -f "$mutated" </dev/null
    [ "$status" -eq 3 ]
    [[ "$output" == *"lockstall_resolved's sample also raised lockstall"* ]]
    refute grep -q $'\tSUMMARY\t' <<<"$output"
}

@test "a pattern that matches lines it does not describe prints NO numbers" {
    # The invented-line control. Make the negative sample carry a real
    # signature: the `dropped` pattern then matches a line no signature
    # describes, which is how a degenerate pattern would look.
    local mutated
    mutated="$(corrupted_scanner 's/no signature here/scrollback row dropped/')"

    run awk -v SVC=svc -v THRESH=10 -f "$mutated" </dev/null
    [ "$status" -eq 3 ]
    [[ "$output" == *"dropped"* ]]
    refute grep -q $'\tSUMMARY\t' <<<"$output"
}

@test "a registered signature missing from the SUMMARY prints NO numbers" {
    # The complete-set control, counted direction: a counter that is raised
    # but never emitted is a measurement nobody can read.
    local mutated
    mutated="$(corrupted_scanner 's/\\tdropped=%d//')"

    run awk -v SVC=svc -v THRESH=10 -f "$mutated" </dev/null
    [ "$status" -eq 3 ]
    [[ "$output" == *"dropped"* ]]
    refute grep -q $'\tSUMMARY\t' <<<"$output"
}

@test "a SUMMARY field nothing registers prints NO numbers" {
    # The complete-set control, emitted direction: a field in the census
    # that no signature backs reports a number that means nothing.
    local mutated
    mutated="$(corrupted_scanner 's/\\tsaturated=%d/\\tsaturated=%d\\tbogus=%d/')"

    run awk -v SVC=svc -v THRESH=10 -f "$mutated" </dev/null
    [ "$status" -eq 3 ]
    [[ "$output" == *"bogus"* ]]
    refute grep -q $'\tSUMMARY\t' <<<"$output"
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
