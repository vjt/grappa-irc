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
# What it reports, per service:
#   - the largest silence between consecutive timestamped lines, and when
#     it started. A quiet stack still logs its 5 s healthcheck cadence, so
#     a maxgap materially above that is the signal.
#   - every silence at or over THRESH seconds, individually.
#   - counts of the damage signatures that accompany the regime: a
#     statement or a checked-out connection held for 30-something seconds
#     (db=3xxxx / idle=3xxxx), a dropped scrollback row, a saturated pool.
#
# Usage: awk -v SVC=<service> -v THRESH=<seconds> -f log-gap-scan.awk
#
# THRESH is REQUIRED. A defaulted threshold would let a caller that forgot
# it report a plausible-looking census measured against something other
# than what the caller meant.

BEGIN {
    if (THRESH + 0 <= 0) {
        print "log-gap-scan.awk: -v THRESH=<seconds> is required" >"/dev/stderr"
        missing_thresh = 1
        exit 2
    }
    prev = -1
    maxgap = 0
    maxat = ""
    ngap = 0
    db30 = 0
    idle30 = 0
    dropped = 0
    saturated = 0
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

    if ($0 ~ /db=3[0-9][0-9][0-9][0-9]\./) db30++
    if ($0 ~ /idle=3[0-9][0-9][0-9][0-9]\./) idle30++
    if ($0 ~ /scrollback row dropped/) dropped++
    if ($0 ~ /saturated for the full/) saturated++
}

END {
    if (missing_thresh) exit 2
    printf "%s\tSUMMARY\tlines=%d\tmaxgap=%.1f\tmaxgap_at=%s\tgaps_ge_%d=%d\tdb30=%d\tidle30=%d\tdropped=%d\tsaturated=%d\n", \
        SVC, lines, maxgap, maxat, THRESH, ngap, db30, idle30, dropped, saturated
}
