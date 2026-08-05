#!/usr/bin/env bats
#
# scripts/shellcheck.sh — the DERIVED shell-lint gate (#441).
#
# The thing under test is the derivation, not shellcheck. A hand-written list
# of eleven paths is what #441 is about: it silently omitted
# `infra/linux/install.sh` (the file whose defects filed the issue) and all of
# `bin/`, and would have omitted the next script added for the same reason. So
# these cases pin two properties:
#
#   1. the RULE — membership follows from being a shell script, exercised in a
#      sandbox tree so a new file can actually be added and observed;
#   2. the REAL set — the specific files the old list forgot are in it now.
#
# Plus the anti-regression that matters most: ci.yml must invoke the script,
# and must not go back to naming paths. A hand list re-added beside the
# derived one would re-open the gap while looking like extra rigour.
#
# `--list` is used throughout rather than a real lint run: this suite is about
# WHICH files the gate covers. Whether they are clean is the gate's own job,
# and it needs docker, which bats here does not.

load ../bats_helpers

setup() {
    GATE="$BATS_TEST_DIRNAME/../../scripts/shellcheck.sh"
    CI_YML="$BATS_TEST_DIRNAME/../../.github/workflows/ci.yml"

    # A sandbox repo with the same three roots, and the gate copied in: the
    # script derives its own root from BASH_SOURCE, so the copy enumerates
    # the sandbox and a case can add a file and see what happens.
    SANDBOX="$BATS_TEST_TMPDIR/sandbox"
    mkdir -p "$SANDBOX/bin" "$SANDBOX/infra/linux" "$SANDBOX/scripts"
    cp "$GATE" "$SANDBOX/scripts/shellcheck.sh"
    chmod +x "$SANDBOX/scripts/shellcheck.sh"
    SANDBOX_GATE="$SANDBOX/scripts/shellcheck.sh"
}

@test "a NEW extensionless script with a shell shebang joins the set (#441)" {
    # The whole point of deriving: nobody edits a list for this to be covered.
    printf '#!/usr/bin/env bash\ntrue\n' > "$SANDBOX/infra/linux/newverb"
    printf '#!/bin/sh\ntrue\n' > "$SANDBOX/bin/another"

    run "$SANDBOX_GATE" --list

    [ "$status" -eq 0 ]
    [[ "$output" == *"infra/linux/newverb"* ]]
    [[ "$output" == *"bin/another"* ]]
}

@test "a NEW .sh joins the set even with no shebang at all (#441)" {
    # The sourced libs (scripts/_lib.sh, infra/lib/deploy_common.sh) have no
    # shebang — they declare their dialect with a `# shellcheck shell=`
    # directive instead. The extension has to be enough on its own.
    printf '# shellcheck shell=bash\ntrue\n' > "$SANDBOX/infra/linux/_helpers.sh"

    run "$SANDBOX_GATE" --list

    [ "$status" -eq 0 ]
    [[ "$output" == *"infra/linux/_helpers.sh"* ]]
}

@test "non-shell files under the same roots stay OUT (#441)" {
    # These really do live beside the scripts: nginx.conf, the perl NDP
    # keepalive, PKGBUILD. Sweeping them in would make the gate fail on files
    # shellcheck cannot parse, and the pressure would be to shrink the set.
    printf '# grappa — nginx config\nserver { }\n' > "$SANDBOX/infra/linux/nginx.conf"
    printf '#!/usr/local/bin/perl\nprint "hi";\n' > "$SANDBOX/infra/linux/keepalive.pl"
    printf '# Maintainer: someone\npkgname=grappa\n' > "$SANDBOX/infra/linux/PKGBUILD"

    run "$SANDBOX_GATE" --list

    [ "$status" -eq 0 ]
    refute grep -q 'nginx.conf' <<<"$output"
    refute grep -q 'keepalive.pl' <<<"$output"
    refute grep -q 'PKGBUILD' <<<"$output"
}

@test "an empty derived set fails loud instead of passing vacuously (#441)" {
    # A gate that lints nothing and exits 0 is the failure mode that hides a
    # moved directory or a broken find.
    rm -rf "${SANDBOX:?}/bin" "${SANDBOX:?}/infra"
    mkdir -p "$SANDBOX/bin" "$SANDBOX/infra"
    rm -f "$SANDBOX/scripts"/*.sh.bak
    # Only the gate itself is left under scripts/, so remove it from view by
    # running a copy from outside the enumerated roots.
    mkdir -p "$SANDBOX/tools"
    cp "$GATE" "$SANDBOX/tools/gate.sh"
    chmod +x "$SANDBOX/tools/gate.sh"
    rm -f "$SANDBOX/scripts/shellcheck.sh"

    run "$SANDBOX/tools/gate.sh" --list

    [ "$status" -ne 0 ]
    [[ "$output" == *"EMPTY file set"* ]]
}

@test "the real set covers what the hand-written list forgot (#441)" {
    # The eleven-path list in ci.yml before #441 named neither of these.
    # infra/linux/install.sh is the file the issue was filed about; bin/ was
    # not linted at all; the rc.d services have no .sh extension.
    run "$GATE" --list

    [ "$status" -eq 0 ]
    [[ "$output" == *"infra/linux/install.sh"* ]]
    [[ "$output" == *"infra/linux/install_systemd.sh"* ]]
    [[ "$output" == *"bin/grappa"* ]]
    [[ "$output" == *"infra/freebsd/rc.d/grappa"* ]]
    # And it still covers everything the old list did name.
    [[ "$output" == *"infra/lib/deploy_common.sh"* ]]
    [[ "$output" == *"infra/cloud/first-boot.sh"* ]]
    [[ "$output" == *"infra/packaging/gen-secrets.sh"* ]]
}

@test "the gate lints ITSELF (#441)" {
    # A linter exempt from its own rule is the first file to rot.
    run "$GATE" --list
    [ "$status" -eq 0 ]
    [[ "$output" == *"scripts/shellcheck.sh"* ]]
}

@test "ci.yml runs the derived gate and names no shellcheck paths (#441)" {
    # The regression this guards is not "shellcheck disappeared" — it is
    # someone re-adding `shellcheck <some new file>` beside the derived run.
    # That reads like extra care and quietly restores the two-sources-of-truth
    # state the issue exists to end.
    grep -q 'scripts/shellcheck.sh' "$CI_YML"

    # Every shellcheck mention in the workflow must be the script, never a
    # bare invocation with operands.
    refute grep -nE '^[[:space:]]+shellcheck[[:space:]]' "$CI_YML"
}
