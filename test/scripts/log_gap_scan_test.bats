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
    # 🔴 issue 1960 — the three OPENING lines now share one prefix and differ
    # by `attribution=`, so these three pins are what proves the counters key
    # on the field. A pin that kept an old prefix would pass against a scanner
    # that no longer matches production at all.
    LOCKSTALL_LINE='db lock stall: attribution=named, holder #PID<0.512.0> has held RESERVED for 30123ms — 1 holder(s) / 2 waiter(s) registered at the seam, 0 process(es) parked inside Exqlite.Sqlite3NIF; subject #PID<0.512.0> status=:runnable at :gen_server.loop/7, stack: a <- b'
    LOCKRESOLVED_LINE='db lock stall RESOLVED: holder #PID<0.512.0> released RESERVED after 30456ms'
    LOCKUNATTR_LINE='db lock stall: attribution=none, longest writer queued at the seam for 31303ms — no holder registered, so the holder is NOT attributable at the BEGIN IMMEDIATE seam — 0 holder(s) / 3 waiter(s) registered at the seam, 0 process(es) parked inside Exqlite.Sqlite3NIF; subject #PID<0.512.0> status=:waiting at :gen_server.loop/7, stack: a <- b'
    LOCKNIF_LINE='db lock stall: attribution=cohort, longest process parked inside Exqlite.Sqlite3NIF for 31402ms — nothing registered at the seam, and nothing BEAM-visible says which of the cohort holds the lock — 0 holder(s) / 0 waiter(s) registered at the seam, 2 process(es) parked inside Exqlite.Sqlite3NIF; none of them registered at the BEGIN IMMEDIATE seam, so all 2 are writers it cannot name; roster: #PID<0.512.0> 31402ms Exqlite.Sqlite3NIF.step/2, #PID<0.513.0> 30011ms Exqlite.Sqlite3NIF.execute/2; subject #PID<0.512.0> status=:running at Exqlite.Sqlite3NIF.step/2, stack: a <- b'
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
# `stamp` is on 2026-08-16; `stamp_on` names the date, for a case that
# crosses one.
stamp() {
    stamp_on 2026-08-16 "$1" "$2"
}

stamp_on() {
    printf '%sT%s000000Z %s\n' "$1" "$2" "$3"
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
    # Read from time of day alone this is -86390 s, which is not merely
    # wrong: it is BELOW the threshold, so a stall spanning midnight would
    # discard the bytes that prove it. The stamp's date makes it 10 s.
    local out
    out="$( { stamp '23:59:59.' before; stamp_on 2026-08-17 '00:00:09.' after; } | scan 10 )"
    grep -q 'svc	GAP	10.0' <<<"$out"
    grep -q 'maxgap=10.0' <<<"$out"
}

@test "a line a few ms behind its predecessor is disorder, not a 24 h silence" {
    # #2443 — `docker logs` interleaves a container's stdout and stderr, so a
    # line can arrive a few ms behind the one before it. Reading every
    # backward step as a midnight rollover turned those 5 ms into 86400 s: a
    # GAP far over the threshold, which fired the retention trigger on a run
    # whose services never went quiet.
    local out
    out="$( {
        stamp '08:41:11.720' 'request_id=GODNYdI2phhkN70ADYWB'
        stamp '08:41:11.720590' 'Parameters: %{"channel_id" => "#spec-w0"}'
        stamp '08:41:11.715395' 'request_id=GODNYdI2phhkN70ADYWB <- 5 ms behind'
        stamp '08:41:12.720590' 'after'
    } | scan 10 )"

    refute grep -q 'GAP' <<<"$out"
    grep -q 'gaps_ge_10=0' <<<"$out"
    # The true silence is still measured: 1 s, not 86400 s. This does NOT pin
    # where it is measured from — `%.1f` prints 1.000 and 1.005 alike — so
    # the high-water rule has its own case below.
    grep -q 'maxgap=1.0' <<<"$out"
}

@test "a line behind the high-water stamp does not become the origin of the next delta" {
    # #2443 — measuring from the out-of-order line would count the reorder
    # skew a second time. Here that skew is what carries a 9.95 s silence
    # across the threshold: 08:41:19.950 - 08:41:09.900 = 10.05 s, a GAP that
    # would keep a green run's bytes for a silence that never reached 10 s.
    local out
    out="$( {
        stamp '08:41:10.000' 'high-water'
        stamp '08:41:09.900' '100 ms behind'
        stamp '08:41:19.950' 'after'
    } | scan 10 )"

    refute grep -q 'GAP' <<<"$out"
    grep -q 'gaps_ge_10=0' <<<"$out"
    grep -q 'maxgap_at=08:41:10.000' <<<"$out"
}

@test "a line a few ms behind across midnight is disorder too, not a 24 h silence" {
    # The same disorder seen from the other side of midnight: 23:59:59.998
    # on the 16th arrives after 00:00:00.001 on the 17th. Time of day alone
    # steps FORWARD by nearly a day, an 86400 s silence; the full stamp says
    # 3 ms back, which is disorder, and the line must not become the origin
    # of the next delta either.
    local out
    out="$( {
        stamp '23:59:59.999' 'before midnight'
        stamp_on 2026-08-17 '00:00:00.001' 'after midnight'
        stamp '23:59:59.998' '3 ms behind, across midnight'
        stamp_on 2026-08-17 '00:00:01.000' 'after'
    } | scan 10 )"

    refute grep -q 'GAP' <<<"$out"
    grep -q 'gaps_ge_10=0' <<<"$out"
    grep -q 'maxgap=1.0' <<<"$out"
    grep -q 'maxgap_at=00:00:00.001' <<<"$out"
}

@test "a step back of any size is disorder: no rollover is guessed" {
    # With the date read, no backward step is a midnight in disguise, not
    # even one of more than half a day. A rollover arm put back "to be
    # safe" would turn this 13 h-late line into an 11 h silence.
    local out
    out="$( {
        stamp '12:00:00.000' 'high-water'
        stamp_on 2026-08-15 '23:00:00.000' '13 h behind'
        stamp '12:00:05.000' 'after'
    } | scan 10 )"

    refute grep -q 'GAP' <<<"$out"
    grep -q 'gaps_ge_10=0' <<<"$out"
    grep -q 'maxgap=5.0' <<<"$out"
    grep -q 'maxgap_at=12:00:00.000' <<<"$out"
}

@test "a silence of more than half a day is a silence, not disorder" {
    # From time of day alone a step forward of more than 12 h is as likely
    # to be disorder across midnight, and reading it that way left the
    # scanner blind to every line after it. The date settles it.
    local out
    out="$( {
        stamp '00:00:00.000' a
        stamp '13:00:00.000' b
        stamp '13:00:05.000' c
        stamp '13:00:20.000' d
    } | scan 10 )"

    grep -q 'svc	GAP	46800.0	00:00:00.000 -> 13:00:00.000' <<<"$out"
    grep -q 'svc	GAP	15.0	13:00:05.000 -> 13:00:20.000' <<<"$out"
    grep -q 'gaps_ge_10=2' <<<"$out"
}

@test "a silence of more than half a day across midnight is a silence too" {
    # 20:00 -> 09:00 is 11 h back by time of day, which used to read as
    # disorder; the next day's date makes it 13 h forward.
    local out
    out="$( {
        stamp '20:00:00.000' a
        stamp_on 2026-08-17 '09:00:00.000' b
        stamp_on 2026-08-17 '09:00:05.000' c
        stamp_on 2026-08-17 '09:00:20.000' d
    } | scan 10 )"

    grep -q 'svc	GAP	46800.0	20:00:00.000 -> 09:00:00.000' <<<"$out"
    grep -q 'svc	GAP	15.0	09:00:05.000 -> 09:00:20.000' <<<"$out"
    grep -q 'gaps_ge_10=2' <<<"$out"
}

@test "a change of year is 100 ms, not a year back" {
    # The date is read in full: 31 December to 1 January is one day on,
    # not eleven months back.
    local out
    out="$( {
        stamp_on 2026-12-31 '23:59:59.9' 'last line of the year'
        stamp_on 2027-01-01 '00:00:00.0' 'first line of the next'
    } | scan 10 )"

    refute grep -q 'GAP' <<<"$out"
    grep -q 'gaps_ge_10=0' <<<"$out"
    grep -q 'maxgap=0.1' <<<"$out"
    grep -q 'maxgap_at=23:59:59.900' <<<"$out"
}

@test "consecutive days are 86400 s apart across month, year and leap-day edges" {
    # Each pair is one day apart: a month end, a year end, February in a
    # common year, both sides of a leap day, and the two century rules
    # (2100 is not a leap year, 2000 is).
    local pair out
    for pair in 2026-08-31,2026-09-01 2026-12-31,2027-01-01 2027-02-28,2027-03-01 \
        2028-02-28,2028-02-29 2028-02-29,2028-03-01 2100-02-28,2100-03-01 \
        2000-02-29,2000-03-01; do
        out="$( { stamp_on "${pair%,*}" '12:00:00.' a; stamp_on "${pair#*,}" '12:00:00.' b; } | scan 10 )"
        grep -q 'svc	GAP	86400.0' <<<"$out" || { echo "$pair: $out"; false; }
    done
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
    mutated="$(corrupted_scanner 's|/db lock stall: attribution=named/|/db lock stall/|')"

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
