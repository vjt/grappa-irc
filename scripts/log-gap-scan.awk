#!/usr/bin/awk -f
#
# #1429 — one streaming pass over a `docker compose logs --timestamps`
# stream, emitting a few hundred bytes instead of a few hundred megabytes.
#
# WHY THIS EXISTS. scripts/integration.sh used to keep the containers'
# logs only when the suite went red, so roughly 91% of runs left no
# server-side evidence at all — and the open question about the 30.1 s
# stall regime (#1420, #1421) is precisely whether it also hits the runs
# that pass. Keeping ~275 MB per green run was never affordable; keeping
# the MEASUREMENT taken from those same bytes costs a few KB, so the
# stream is scanned in flight and only a red materialises it to disk.
#
# 🔴 HOW TO READ A GAP — the direction of causation is NOT given.
#
# A silence in a log is not evidence that the process was stuck. A
# Playwright spec hung on a locator stops driving the stack, and a server
# with no traffic logs nothing: the silence is then the EFFECT of the
# failure, not its cause. Measured instance — a 16.7 s silence on
# grappa-test spanning exactly the lifetime of a failing spec (provision
# 14:40:14, silence 14:40:15.008 -> 14:40:31.720, failure 14:40:32), with
# every damage counter at zero, and that spec passing 3/3 in isolation.
#
#   gap + a DAMAGE SIGNATURE (db30 / idle30 / dropped / saturated /
#       lockheld / lockstall / lockstall_resolved)
#       => a stall. The environment is implicated, the spec is not.
#   BARE gap (every damage counter zero)
#       => attributes NOTHING. Traffic drought and a stalled process
#          look identical from here.
#
# This is why the counters share the line with the gap rather than living
# in a separate report: the gap alone is not a verdict, and separating
# them invites reading it as one.
#
# 🔴 WHY THE LOCK COUNTERS ARE HERE (#1420). `container-logs` uploads on
# failure only; this census uploads on EVERY run. #1420 measured 12
# stalled attempts, 9 of them with `LockWatch` compiled in — and only 3
# were readable, because the other 6 (5 green, 1 cancelled) never
# uploaded any bytes. The instrument's own verdict was thrown away BY
# CONSTRUCTION on the majority of the attempts that armed it. Counting
# `LockWatch`'s two episode edges here puts that verdict in the artefact
# that survives a green run.
#
# What it reports, per service:
#   - the largest silence between consecutive timestamped lines, and when
#     it started. A quiet stack still logs its 5 s healthcheck cadence, so
#     a maxgap materially above that is the signal.
#   - every silence at or over THRESH seconds, individually.
#   - counts of the damage signatures that accompany the regime: a
#     statement or a checked-out connection held for 30-something seconds
#     (db=3xxxx / idle=3xxxx), a dropped scrollback row, a saturated pool,
#     a retry budget exhausted against a held write lock, and the two
#     edges of a `LockWatch` stall episode.
#
# Usage: awk -v SVC=<service> -v THRESH=<seconds> -f log-gap-scan.awk
#
# THRESH is REQUIRED. A defaulted threshold would let a caller that forgot
# it report a plausible-looking census measured against something other
# than what the caller meant.
#
# 🔴 THE CONTROLS ARE INSIDE THE INSTRUMENT, NOT BESIDE IT. Every damage
# signature is registered with a KNOWN-ANSWER sample copied from the call
# site that produces it, and BEGIN pushes those samples through the REAL
# counting path before a single input line is read:
#
#   * known answer — each sample raises its OWN counter exactly once, and
#     no other (so a pattern that swallows a sibling's line is caught:
#     `db lock stall` matches the RESOLVED line too, which is the exact
#     trap these three counters walked into).
#   * invented line — a line no signature describes raises nothing.
#   * complete set — every registered signature reaches the SUMMARY line
#     with its known answer, and the SUMMARY declares no `key=` field that
#     is neither registered nor structural.
#
# A failed control exits 3 having printed NO numbers: a census that cannot
# vouch for its own counters must not publish any, because a zero from a
# broken pattern is indistinguishable from a zero that means "clean".

# Register a damage signature: its counter name, and one line copied
# VERBATIM from the call site that emits it. The pattern itself lives in
# `count_signatures` — the samples are pushed through that function, so
# the control tests the shipped counting path and not a parallel table.
function sig(name, sample) {
    nsig++
    NAME[nsig] = name
    SAMPLE[nsig] = sample
    REGISTERED[name] = 1
}

# The only place a damage signature is recognised. Both the live stream
# and the BEGIN controls go through here.
function count_signatures(line) {
    if (line ~ /db=3[0-9][0-9][0-9][0-9]\./) CNT["db30"]++
    if (line ~ /idle=3[0-9][0-9][0-9][0-9]\./) CNT["idle30"]++
    if (line ~ /scrollback row dropped/) CNT["dropped"]++
    # #1421 — anchored on the `observed_state/1` phrase ALONE, no longer on
    # the numeric tail it used to share with `for the full 1500ms retry
    # budget`. That tail now carries the OBSERVED elapsed and will move again;
    # the phrase that names the topology is the stable half, and it is the
    # half this counter is about.
    if (line ~ /SQLite pool saturated/) CNT["saturated"]++
    # #1657 — the third BusyRetry terminal state. Its own counter, not folded
    # into `saturated`: a cancelled statement had ALREADY been served a
    # connection, so counting it as a checkout that never happened would
    # misreport where the write died.
    if (line ~ /statement cancelled by a pool timeout/) CNT["interrupted"]++
    # #1708 — the fourth BusyRetry terminal state, and the only one whose row
    # is NOT lost: the statement completed and committed, and what the pool
    # took away was the connection the driver then asked for the row count.
    # Its own counter for the reason #1687 gives above, plus one more — folding
    # it into `dropped` would count a durable row as a lost one, and `dropped`
    # is the number the #1429 census exists to be trusted on.
    if (line ~ /SQLite connection closed after the write completed/) CNT["orphaned"]++

    # `index` before the three regexes: every lock signature carries the
    # literal "lock", and the stream is ~10^6 lines. The known-answer
    # control below is what proves the guard lets them through.
    if (index(line, "lock") > 0) {
        if (line ~ /write lock held by another writer/) CNT["lockheld"]++
        if (line ~ /db lock stall: holder /) CNT["lockstall"]++
        if (line ~ /db lock stall RESOLVED/) CNT["lockstall_resolved"]++
        # #1687 — the third LockWatch edge. Its own counter, not folded into
        # `lockstall`: that one means "a holder was NAMED", and the whole
        # point of this one is that nobody could be. Folding them would let
        # an episode the instrument could not attribute be read off the
        # artefact as one it did.
        if (line ~ /db lock stall UNATTRIBUTED/) CNT["lockstall_unattributed"]++
        # #1901 — LockWatch's fourth edge, and the only one taken WITHOUT
        # reading the BEGIN IMMEDIATE seam: a roster of the processes sitting
        # inside the SQLite NIF. Its own counter for the reason the two above
        # have theirs, one step further out — `lockstall` means a holder was
        # NAMED and `lockstall_unattributed` means a QUEUE was measured with
        # nobody to blame, while this one means neither was established and a
        # cohort was photographed instead. Folding it into either would let a
        # census be read off the artefact as an attribution.
        if (line ~ /db lock stall NIF CENSUS/) CNT["lockstall_nif"]++
    }
}

function zero_counters(   i) {
    for (i = 1; i <= nsig; i++) CNT[NAME[i]] = 0
}

# One definition of the SUMMARY line, used by the END emit AND by the
# completeness control, so the control cannot drift from what ships.
function summary_line(svc, nlines, mg, mat) {
    return sprintf(SUMFMT, svc, nlines, mg, mat, THRESH, ngap, \
        CNT["db30"], CNT["idle30"], CNT["dropped"], CNT["saturated"], \
        CNT["interrupted"], CNT["orphaned"], CNT["lockheld"], CNT["lockstall"], \
        CNT["lockstall_resolved"], CNT["lockstall_unattributed"], CNT["lockstall_nif"])
}

function bail(msg) {
    print "log-gap-scan.awk: CONTROL FAILED — " msg >"/dev/stderr"
    print "log-gap-scan.awk: refusing to print a census it cannot vouch for" >"/dev/stderr"
    abort_rc = 3
    exit 3
}

# known answer + no cross-talk: each sample raises its own counter, once.
function control_known_answer(   i, j) {
    for (i = 1; i <= nsig; i++) {
        zero_counters()
        count_signatures(SAMPLE[i])
        if (CNT[NAME[i]] != 1)
            bail("the known-answer sample for " NAME[i] " raised it " CNT[NAME[i]] " times, want 1")
        for (j = 1; j <= nsig; j++)
            if (j != i && CNT[NAME[j]] != 0)
                bail(NAME[i] "'s sample also raised " NAME[j] " — the two patterns do not discriminate")
    }
}

# invented line: a plausible log line no signature describes must raise
# nothing. Without it a pattern that degenerated to "match anything" would
# pass every known-answer check above.
function control_invented_line(   i) {
    zero_counters()
    count_signatures(NEG)
    for (i = 1; i <= nsig; i++)
        if (CNT[NAME[i]] != 0)
            bail("the invented line raised " NAME[i] " — that pattern matches lines it does not describe")
}

# complete set, both directions: every registered signature reaches the
# SUMMARY with its known answer, and the SUMMARY declares no `key=` field
# that is neither registered nor structural.
# The format is scanned BEFORE it is rendered: an unbacked `%d` field makes
# `sprintf` die with "not enough args" on a strict awk (BSD) and pass
# silently on a lenient one (gawk/mawk), so leaving the render first would
# make the control's own verdict depend on which awk the runner has.
function control_complete_set(   i, probe, n, parts, p, k) {
    n = split(SUMFMT, parts, "\t")
    for (i = 1; i <= n; i++) {
        p = index(parts[i], "=")
        if (p == 0) continue
        k = substr(parts[i], 1, p - 1)
        if (k == "lines" || k == "maxgap" || k == "maxgap_at") continue
        if (k ~ /^gaps_ge_/) continue
        if (!(k in REGISTERED))
            bail("the SUMMARY declares '" k "=' but nothing registers that signature")
    }

    zero_counters()
    for (i = 1; i <= nsig; i++) count_signatures(SAMPLE[i])
    probe = summary_line("selftest", 0, 0, "")
    for (i = 1; i <= nsig; i++)
        if (index(probe, "\t" NAME[i] "=1") == 0)
            bail("signature " NAME[i] " does not reach the SUMMARY line with its known answer")
    zero_counters()
}

BEGIN {
    if (THRESH + 0 <= 0) {
        print "log-gap-scan.awk: -v THRESH=<seconds> is required" >"/dev/stderr"
        missing_thresh = 1
        exit 2
    }

    SUMFMT = "%s\tSUMMARY\tlines=%d\tmaxgap=%.1f\tmaxgap_at=%s\tgaps_ge_%d=%d" \
        "\tdb30=%d\tidle30=%d\tdropped=%d\tsaturated=%d\tinterrupted=%d" \
        "\torphaned=%d\tlockheld=%d\tlockstall=%d\tlockstall_resolved=%d" \
        "\tlockstall_unattributed=%d\tlockstall_nif=%d\n"

    # Samples copied from the emitting call site. Keep them verbatim: a
    # sample edited to fit the pattern turns the control into a mirror.
    #   db30 / idle30      — Ecto's own query log (`Grappa.DbLatency`).
    #   dropped            — Grappa.Scrollback, #336 never-crash contract.
    #   saturated          — Repo.BusyRetry, pool queue_timeout arm.
    #   interrupted        — Repo.BusyRetry, interrupted arm (#1657).
    #   orphaned           — Repo.BusyRetry, connection_closed arm (#1708):
    #                      the pool closed the connection AFTER the statement
    #                      completed, so the row is DURABLE and only its
    #                      RETURNING id and live broadcast were lost. 22 of
    #                      these killed 22 live IRC sessions on 2026-08-22
    #                      while losing no message at all.
    #                      🔴 It OVERLAPS `dropped`, it does not sit beside it.
    #                      Scrollback maps this fault onto the same
    #                      `:persist_unavailable` as a row that never landed
    #                      (the engine cannot hand the kind back without a
    #                      fourth terminal atom, and ~150 `@spec`s carry the
    #                      current three), so every orphaned fault on the
    #                      scrollback path ALSO raises `dropped`. Read it as:
    #                      `dropped` is the UPPER bound on lost rows and
    #                      `dropped - orphaned` the LOWER one — orphaned also
    #                      counts the non-scrollback write paths, which emit
    #                      no `dropped` line of their own.
    #   lockheld           — Repo.BusyRetry, busy_locked arm (#1420).
    #   lockstall{,_resolved} — Grappa.Repo.LockWatch's two episode edges.
    #   lockstall_unattributed — LockWatch's third edge (#1687): a queue past
    #                      the threshold that named nobody. It counted ZERO
    #                      through the whole 2026-08-22 prod episode because
    #                      the line did not exist; a census blind to it reads
    #                      exactly like a clean run.
    #   lockstall_nif      — LockWatch's fourth edge (#1901): the roster of
    #                      processes inside `Exqlite.Sqlite3NIF` past the
    #                      threshold. It is the ONLY lock signature that does
    #                      not depend on a writer having gone through the
    #                      BEGIN IMMEDIATE seam, which is why it is the one
    #                      that can be non-zero while all three above are
    #                      zero — the shape all four #1888 episodes had.
    sig("db30", "QUERY OK source=\"messages\" db=30064.1ms queue=0.1ms")
    sig("idle30", "client #PID<0.700.0> checked out, idle=30062.4ms")
    sig("dropped", "scrollback row dropped for #bofh: :persist_unavailable")
    sig("saturated", \
        "db write unavailable: SQLite pool saturated for 1512ms across 14 attempts" \
        " (1500ms retry budget) — returning :db_unavailable")
    sig("interrupted", \
        "db write unavailable: SQLite statement cancelled by a pool timeout for 15042ms" \
        " across 1 attempts (1500ms retry budget) — returning :db_unavailable")
    sig("orphaned", \
        "db write landed but its result was lost: SQLite connection closed after the" \
        " write completed, 15042ms into the write, on attempt 1 (not retried — the row" \
        " is durable, a retry would duplicate it) — returning :db_unavailable")
    sig("lockheld", \
        "db write unavailable: SQLite write lock held by another writer for 30067ms" \
        " across 1 attempts (1500ms retry budget) — returning :db_unavailable")
    sig("lockstall", \
        "db lock stall: holder #PID<0.512.0> has held RESERVED for 30123ms with 2" \
        " waiter(s) queued — holder status=:runnable at :gen_server.loop/7, stack: …")
    sig("lockstall_resolved", \
        "db lock stall RESOLVED: holder #PID<0.512.0> released RESERVED after 30456ms")
    sig("lockstall_unattributed", \
        "db lock stall UNATTRIBUTED: 3 writer(s) queued past the threshold, longest" \
        " 31303ms — no holder registered, so the holder is NOT attributable at the" \
        " BEGIN IMMEDIATE seam; longest waiter #PID<0.512.0> status=:waiting at" \
        " :gen_server.loop/7, stack: …")
    sig("lockstall_nif", \
        "db lock stall NIF CENSUS: 2 process(es) parked inside Exqlite.Sqlite3NIF past the" \
        " threshold, longest 31402ms — none of them registered at the BEGIN IMMEDIATE seam," \
        " so all 2 are writers it cannot name; roster: #PID<0.512.0> 31402ms" \
        " Exqlite.Sqlite3NIF.step/2, #PID<0.513.0> 30011ms Exqlite.Sqlite3NIF.execute/2;" \
        " longest #PID<0.512.0> status=:running at Exqlite.Sqlite3NIF.step/2, stack: …")

    # Deliberately ordinary: a real line from the same stream that names
    # none of the signatures. It DOES carry the word "lock" so the
    # index-guard above cannot be what makes it pass.
    NEG = "GET /healthz — 200 in 412µs (db lock unrelated prose, no signature here)"

    control_known_answer()
    control_invented_line()
    control_complete_set()

    prev = -1
    maxgap = 0
    maxat = ""
    ngap = 0
    lines = 0
}

{
    lines++

    # `docker logs --timestamps` prefixes RFC3339: 2026-08-16T12:09:04.535…Z.
    # Positions rather than a regex — this runs over a million lines.
    if (substr($0, 5, 1) == "-" && substr($0, 11, 1) == "T") {
        t = substr($0, 12, 2) * 3600 + substr($0, 15, 2) * 60 + substr($0, 18, 9)
        if (prev >= 0) {
            d = t - prev
            if (d < 0) d += 86400          # midnight rollover
            if (d > maxgap) { maxgap = d; maxat = prevstamp }
            if (d >= THRESH) {
                ngap++
                printf "%s\tGAP\t%.1f\t%s -> %s\n", SVC, d, prevstamp, substr($0, 12, 12)
            }
        }
        prev = t
        prevstamp = substr($0, 12, 12)
    }

    count_signatures($0)
}

END {
    if (missing_thresh) exit 2
    if (abort_rc) exit abort_rc
    printf "%s", summary_line(SVC, lines, maxgap, maxat)
}
