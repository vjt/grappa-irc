#!/usr/bin/env bats
#
# The bastille jail NAME is written once, and every live spelling agrees
# with it (#2022).
#
# The bug this exists to stop: `scripts/deploy-m42.sh` defaulted JAIL to
# `grappa`, and `infra/freebsd/deploy.sh` built its restart hint on the same
# name — the hint printed when the daemon is GONE. The jail was then called
# `grappa-new`; `grappa` was its host.hostname. So the line an operator pastes
# to bring production back addressed a jail that did not exist. (#2481 has
# since renamed the jail `grappa`, so today the two agree — by coincidence,
# not by construction.)
#
# `infra/lib/bastille_jail.sh` is the one place the name is written for the
# consumers that COMPUTE with it. The ~30 remaining spellings are usage
# comments and runbook incantations, which cannot source a variable — this
# gate is what holds those to the same value, and what turns the next rename
# into a list instead of a repo-wide grep.
#
# Three properties, in the order that makes each one readable:
#
#   1. the CONSTANT exists and is non-empty (a gate that compares against an
#      empty expectation would pass on an empty tree AND on a broken source);
#   2. the DETECTOR bites — a stale spelling planted in a sandbox is found and
#      named, so a green run on the real tree means "nothing stale", not "the
#      regex died";
#   3. the REAL TREE agrees, with a floor on how many sites were examined.
#
# ── What the detector sees, and what it does not ────────────────────
# It matches a jail name in ARGUMENT position: after a bastille verb that
# takes a jail, after `jexec`, after `pkg -j`, and inside a
# /usr/local/bastille/jails/<name> path. A token spelled as a variable or a
# placeholder (`${JAIL}`, `"$JAIL"`, `<jail>`) is not a literal and never
# matches — those are the sites that already read the constant.
#
# It is line-based, so it cannot see a name that prose wrapped onto the next
# line, and it cannot see one named outside a command (`the jail is called X`).
# Both classes exist in docs/OPERATIONS.md and were fixed by hand in #2022;
# neither is claimed to be covered here.
#
# Chronological records are OUT of scope by design: docs/DESIGN_NOTES.md, its
# docs/design_notes/ archives, docs/project-story.md, docs/reviews/ and the
# dated baselines quote what was true when written. A log that gets rewritten
# to stay current is not a log.

load ../bats_helpers

setup() {
    REPO="$BATS_TEST_DIRNAME/../.."
    # shellcheck source=infra/lib/bastille_jail.sh
    . "$REPO/infra/lib/bastille_jail.sh"
}

# Emit "<file>:<line>: <token>" for every literal jail name written in
# argument position under $1.
scan_jail_names() {
    root="$1"
    verbs='cmd|console|start|stop|restart|service|sysrc|pkg|cp|rcp|template'
    verbs="$verbs|create|destroy|edit|htop|limits|mount|umount|rename"
    verbs="$verbs|update|upgrade|verify|zfs"
    # A LITERAL token only: no `$`, no `<`, no quote — so `${JAIL}` and
    # `<jail>` fall out at the regex, not at a post-filter that could rot.
    tok='[A-Za-z0-9_.-]+'

    grep -rnIEo \
        -e "(bastille[[:space:]]+($verbs)|bastille-restart|jexec|pkg[[:space:]]+-j)[[:space:]]+$tok" \
        -e "/usr/local/bastille/jails/$tok" \
        "$root" \
        --exclude-dir=.git \
        --exclude-dir=node_modules \
        --exclude-dir=_build \
        --exclude-dir=deps \
        --exclude-dir=.cache \
        --exclude-dir=.mix \
        --exclude-dir=.hex \
        --exclude-dir=design_notes \
        --exclude-dir=reviews \
        --exclude=DESIGN_NOTES.md \
        --exclude=project-story.md \
        --exclude='zfs-baseline-*.md' \
        2>/dev/null \
    | awk '{
        i = index($0, ":");   f = substr($0, 1, i - 1); r = substr($0, i + 1)
        j = index(r,  ":");  ln = substr(r,  1, j - 1); m = substr(r,  j + 1)
        n = split(m, parts, /[ \t\/]+/); t = parts[n]
        # A bare number is a JID, not a name — a different addressing mode,
        # and docs/OPERATIONS.md quotes `jexec 6` on purpose as the form that
        # DRIFTS. Demanding a name there would delete the warning.
        if (t ~ /^[0-9]+$/) next
        printf "%s:%s: %s\n", f, ln, t
      }'
}

@test "the jail name is declared, once, and is not empty" {
    [ -n "$BASTILLE_JAIL" ]

    # One declaration, not two: a second assignment in the lib would give the
    # gate an expectation the consumers do not share.
    run grep -cE '^BASTILLE_JAIL=' "$REPO/infra/lib/bastille_jail.sh"
    [ "$output" -eq 1 ]
}

@test "the detector bites: a stale spelling in a sandbox is found and named" {
    sandbox="$BATS_TEST_TMPDIR/sandbox"
    mkdir -p "$sandbox/infra/freebsd"

    # The stale token is BUILT, never written: a wrong name spelled literally
    # in this file would sit in argument position in the live tree and trip
    # the real-tree case below on its own fixture.
    stale="stale$$"

    printf '#!/bin/sh\n#   sudo bastille cmd %s /home/grappa/grappa/x.sh\n' \
        "$stale" > "$sandbox/infra/freebsd/rail.sh"
    cat > "$sandbox/agrees.sh" <<EOF
#!/bin/sh
#   sudo bastille cmd ${BASTILLE_JAIL} /home/grappa/grappa/infra/freebsd/x.sh
#   sudo bastille cmd \${JAIL} /home/grappa/grappa/infra/freebsd/x.sh
EOF

    run scan_jail_names "$sandbox"
    [ "$status" -eq 0 ]

    # The stale one is named, with its file and line.
    [[ "$output" == *"rail.sh:2: ${stale}"* ]]
    # The agreeing literal is seen (so the comparison below is a real
    # comparison), and the variable spelling is not a literal at all.
    [[ "$output" == *"agrees.sh:2: ${BASTILLE_JAIL}"* ]]
    refute grep -q 'JAIL}' <<< "$output"

    # And the verdict the real-tree case draws from it.
    stale=$(grep -v ": ${BASTILLE_JAIL}\$" <<< "$output" || true)
    [ "$(wc -l <<< "$stale" | tr -d ' ')" -eq 1 ]
}

@test "every live spelling of the bastille jail name is the declared one" {
    run scan_jail_names "$REPO"
    [ "$status" -eq 0 ]

    # Floor: the scan really examined the tree. Without it a regex that died
    # would report nothing and read as "all clean" — the failure mode this
    # whole gate exists to avoid. The live tree carries the usage comments of
    # the twelve infra/freebsd rails plus the OPERATIONS.md runbooks.
    examined=$(wc -l <<< "$output" | tr -d ' ')
    [ "$examined" -ge 20 ]

    stale=$(grep -v ": ${BASTILLE_JAIL}\$" <<< "$output" || true)
    if [ -n "$stale" ]; then
        printf 'jail name must be %s — %s stale spelling(s):\n%s\n' \
            "$BASTILLE_JAIL" "$(wc -l <<< "$stale" | tr -d ' ')" "$stale" >&2
        return 1
    fi
}
