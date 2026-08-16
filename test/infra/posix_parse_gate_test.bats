#!/usr/bin/env bats
#
# scripts/posix-parse.sh — the DERIVED POSIX-sh parse gate (#1377 D-S4).
#
# The thing under test is the derivation, not dash. The hand-written list in
# ci.yml named five paths and covered five of the twenty-eight files that
# declare the sh dialect: it missed two of the three POSIX libs under
# infra/lib/ (docs/OPERATIONS.md calls all three POSIX, and both misses carry
# `# shellcheck shell=sh` on line 1, in the same directory as the one it did
# name), the twelve infra/freebsd/jail_*.sh rails, and infra/packaging/version.sh.
#
# So these cases pin three properties:
#
#   1. the RULE — membership follows from the file's own line-1 dialect
#      declaration, exercised in a sandbox tree so a new file can actually be
#      added and observed;
#   2. the REAL set — the specific files the old list forgot are in it now;
#   3. that the gate BITES — a bashism in a newly covered file makes it fail,
#      naming that file. A gate nobody has watched fail is not a gate.
#
# `--list` is used for the membership cases: they are about WHICH files the
# gate covers. Case 3 runs the real thing, so it needs dash — which is also
# what CI and the jail run, and what the gate refuses to proceed without.

load ../bats_helpers

setup() {
    GATE="$BATS_TEST_DIRNAME/../../scripts/posix-parse.sh"
    CI_YML="$BATS_TEST_DIRNAME/../../.github/workflows/ci.yml"

    # A sandbox repo with the same three roots, and the gate copied in: the
    # script derives its own root from BASH_SOURCE, so the copy enumerates
    # the sandbox and a case can add a file and see what happens.
    SANDBOX="$BATS_TEST_TMPDIR/sandbox"
    mkdir -p "$SANDBOX/bin" "$SANDBOX/infra/lib" "$SANDBOX/scripts"
    cp "$GATE" "$SANDBOX/scripts/posix-parse.sh"
    chmod +x "$SANDBOX/scripts/posix-parse.sh"
    SANDBOX_GATE="$SANDBOX/scripts/posix-parse.sh"
    # One valid member, so a case about EXCLUSION reads the exclusion and not
    # the empty-set refusal. (The gate itself is bash and stays out of its own
    # set, so without this the sandbox can hold only non-members.) The
    # empty-set case removes the roots and therefore this too.
    printf '#!/bin/sh\ntrue\n' > "$SANDBOX/infra/lib/canary.sh"
}

@test "a NEW script with an sh shebang joins the set (#1377)" {
    printf '#!/bin/sh\ntrue\n' > "$SANDBOX/infra/lib/newrail.sh"
    printf '#!/usr/bin/env sh\ntrue\n' > "$SANDBOX/bin/another"

    run "$SANDBOX_GATE" --list

    [ "$status" -eq 0 ]
    [[ "$output" == *"infra/lib/newrail.sh"* ]]
    [[ "$output" == *"bin/another"* ]]
}

@test "a NEW sourced lib declaring shell=sh on line 1 joins the set (#1377)" {
    # This is the shape the hand list missed twice over: infra/lib/beam_wait.sh
    # and infra/lib/cic_dist.sh are sourced, so they have no shebang at all —
    # the directive IS the dialect declaration.
    printf '# shellcheck shell=sh\ntrue\n' > "$SANDBOX/infra/lib/helpers.sh"

    run "$SANDBOX_GATE" --list

    [ "$status" -eq 0 ]
    [[ "$output" == *"infra/lib/helpers.sh"* ]]
}

@test "bash-dialect and dialect-less files stay OUT (#1377)" {
    # dash -n reports syntax errors for perfectly valid bash, so sweeping
    # these in would make the gate fail on files it has no claim over — and
    # the pressure would be to shrink the set back to a hand list.
    printf '#!/usr/bin/env bash\narr=(a b)\n' > "$SANDBOX/scripts/basher.sh"
    printf '# shellcheck shell=bash\narr=(a b)\n' > "$SANDBOX/infra/lib/_bashlib.sh"
    printf '# grappa — nginx config\nserver { }\n' > "$SANDBOX/infra/lib/nginx.conf"

    run "$SANDBOX_GATE" --list

    [ "$status" -eq 0 ]
    refute grep -q 'basher.sh' <<<"$output"
    refute grep -q '_bashlib.sh' <<<"$output"
    refute grep -q 'nginx.conf' <<<"$output"
}

@test "an empty derived set fails loud instead of passing vacuously (#1377)" {
    # A gate that parses nothing and exits 0 is the failure mode that hides a
    # moved directory or a broken find.
    rm -rf "${SANDBOX:?}/bin" "${SANDBOX:?}/infra"
    mkdir -p "$SANDBOX/bin" "$SANDBOX/infra"
    mkdir -p "$SANDBOX/tools"
    cp "$GATE" "$SANDBOX/tools/gate.sh"
    chmod +x "$SANDBOX/tools/gate.sh"
    rm -f "$SANDBOX/scripts/posix-parse.sh"

    run "$SANDBOX/tools/gate.sh" --list

    [ "$status" -ne 0 ]
    [[ "$output" == *"EMPTY file set"* ]]
}

@test "a bashism in a covered file fails the gate, naming the file (#1377)" {
    # The mutation that buys the gate. An ARRAY, not `[[ ]]`: dash -n checks
    # GRAMMAR, and `[[ 1 == 1 ]]` parses as an ordinary command (it fails when
    # it runs, and shellcheck's SC3xxx is what catches it). The array is a
    # syntax error, which is what this tool is for.
    printf '# shellcheck shell=sh\narr=(a b c)\n' > "$SANDBOX/infra/lib/regressed.sh"

    run "$SANDBOX_GATE"

    [ "$status" -ne 0 ]
    [[ "$output" == *"infra/lib/regressed.sh"* ]]
}

@test "the real set covers what the hand-written list forgot (#1377)" {
    # The five-path list in ci.yml before #1377 named none of these.
    run "$GATE" --list

    [ "$status" -eq 0 ]
    # Two of the three infra/lib POSIX libs, in the same directory as the one
    # it did name, with the same line-1 declaration.
    [[ "$output" == *"infra/lib/beam_wait.sh"* ]]
    [[ "$output" == *"infra/lib/cic_dist.sh"* ]]
    # The jail rails the jail's /bin/sh actually runs, and the version
    # delegate every deploy wrapper shells out to.
    [[ "$output" == *"infra/freebsd/jail_mix.sh"* ]]
    [[ "$output" == *"infra/freebsd/jail_db_query.sh"* ]]
    [[ "$output" == *"infra/packaging/version.sh"* ]]
    # An extensionless one, which a `*.sh` glob would have missed.
    [[ "$output" == *"infra/freebsd/rc.d/grappa"* ]]
    # And it still covers every path the old list did name.
    [[ "$output" == *"infra/lib/deploy_common.sh"* ]]
    [[ "$output" == *"infra/freebsd/deploy.sh"* ]]
    [[ "$output" == *"infra/docker/assert-abi-lockstep.sh"* ]]
    [[ "$output" == *"infra/docker/release-entrypoint.sh"* ]]
    [[ "$output" == *"infra/docker/get.sh"* ]]
}

@test "ci.yml runs the derived gate and names no dash paths (#1377)" {
    # The regression this guards is not "the step disappeared" — it is someone
    # re-adding `dash -n <some new file>` beside the derived run. That reads
    # like extra care and quietly restores the two-sources-of-truth state this
    # change exists to end.
    grep -q 'scripts/posix-parse.sh' "$CI_YML"

    refute grep -nE '^[[:space:]]+dash[[:space:]]+-n[[:space:]]' "$CI_YML"
}
