#!/usr/bin/env bats
#
# #702 — scripts/integration.sh must dump the containers' logs on a
# failed run, and must do it BEFORE the tear-down in the same EXIT trap.
#
# The ordering is the whole property. `testnet.sh down` destroys the
# containers, so a `docker compose logs` step added to the CI workflow
# after the suite would find nothing to read — which is exactly why the
# integration job has never had a server-side artifact. A test that only
# asserted "the logs exist" would pass against a capture placed after the
# tear-down, i.e. against the bug.
#
# #1429 — and it must leave a GAP CENSUS behind on EVERY run, green
# included. This file used to carry a test asserting the opposite ("a
# green run captures nothing"), which pinned ~91% of runs as unable to
# answer whether a server-side stall had happened at all. The bytes were
# the thing that could not be kept (~275 MB per run); the census is a few
# KB, so it is streamed out of the same `docker compose logs` and the raw
# bytes are materialised only on a red.
#
# Stubs, not a real stack: a `docker` on PATH records every invocation
# and answers the three queries the capture makes, and testnet.sh is
# replaced by a recorder. Both append to ONE log, so the order between
# "logs were read" and "the stack came down" is a line comparison.
#
# The service set is checked with a name no hand-written list could
# contain — the capture derives it from `docker compose ps`, and a
# derived set is the difference between covering the service added next
# year and covering the one somebody remembered.
#
# The stub's grappa-test stream carries a real 30.064 s hole and two
# damage signatures, so the census assertions have an oracle: a census
# that merely EXISTS, or that reports a constant, cannot satisfy them.

load ../bats_helpers

setup() {
    INTEGRATION_SH="$BATS_TEST_DIRNAME/../../scripts/integration.sh"
    LIB_SH="$BATS_TEST_DIRNAME/../../scripts/_lib.sh"
    SCAN_AWK="$BATS_TEST_DIRNAME/../../scripts/log-gap-scan.awk"
    VERSION_SH="$BATS_TEST_DIRNAME/../../infra/packaging/version.sh"

    TMP="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    MAIN="$TMP/main"
    LOG="$TMP/invocations.log"
    : >"$LOG"

    mkdir -p "$MAIN/scripts" "$MAIN/infra/packaging" "$MAIN/lib" "$MAIN/cicchetto/e2e"
    cp "$INTEGRATION_SH" "$MAIN/scripts/integration.sh"
    cp "$LIB_SH" "$MAIN/scripts/_lib.sh"
    # The census scanner travels with the script that invokes it: a copy
    # that omitted it would exercise a capture whose scanner is missing.
    cp "$SCAN_AWK" "$MAIN/scripts/log-gap-scan.awk"
    # integration.sh derives GRAPPA_VERSION from the repo-root VERSION file
    # (#652) before anything else; under set -e it must succeed.
    cp "$VERSION_SH" "$MAIN/infra/packaging/version.sh"
    chmod +x "$MAIN/infra/packaging/version.sh"
    printf '9.9.9\n' >"$MAIN/VERSION"
    printf 'defmodule Grappa.MixProject do\n  @version "9.9.9"\nend\n' >"$MAIN/mix.exs"
    echo base >"$MAIN/lib/base.ex"
    : >"$MAIN/cicchetto/e2e/compose.yaml"

    # _lib.sh resolves REPO_ROOT through `git rev-parse --git-common-dir`.
    git init -q -b main "$MAIN"
    git -C "$MAIN" config user.email test@grappa.local
    git -C "$MAIN" config user.name bats

    # testnet.sh recorder — `up` and `down` land in the shared log.
    cat >"$MAIN/scripts/testnet.sh" <<EOF
#!/usr/bin/env bash
printf 'testnet %s\n' "\$*" >> "$LOG"
EOF
    chmod +x "$MAIN/scripts/testnet.sh"

    # docker stub: records, then answers the capture's three queries.
    # \$2 is the compose subcommand (\$1 is always \`compose\` here).
    STUB="$TMP/stub"
    mkdir -p "$STUB"
    cat >"$STUB/docker" <<EOF
#!/usr/bin/env bash
{ printf 'docker'; for a in "\$@"; do printf ' %s' "\$a"; done; printf '\n'; } >> "$LOG"
case "\$2" in
    ps)
        if [[ " \$* " == *" --services "* ]]; then
            # 'newcomer-svc' is the derivation probe: no hand list has it.
            printf '%s\n' grappa-test hub newcomer-svc
        else
            printf 'NAME STATUS\n'
        fi
        ;;
    logs)
        svc="\${*: -1}"
        if [ "\$svc" = grappa-test ]; then
            case "\${FAKE_STREAM:-stall}" in
                stall)
                    # \`docker logs --timestamps\` shape, with a 30.064 s
                    # hole between the two lines and damage on each.
                    printf '2026-08-16T12:09:04.535000000Z scrollback row dropped\n'
                    printf '2026-08-16T12:09:34.599000000Z db=30064.1ms query returned\n'
                    ;;
                damage)
                    # DAMAGE WITHOUT A STALL: a dropped row at the 5 s
                    # healthcheck cadence. The class that used to be
                    # unobservable, because nothing here trips a gap.
                    printf '2026-08-16T12:09:04.535000000Z healthcheck ok\n'
                    printf '2026-08-16T12:09:09.535000000Z scrollback row dropped\n'
                    ;;
                clean)
                    # A healthy stack: the cadence, and nothing else.
                    printf '2026-08-16T12:09:04.535000000Z healthcheck ok\n'
                    printf '2026-08-16T12:09:09.535000000Z healthcheck ok\n'
                    ;;
            esac
        else
            printf 'fake container output for %s\n' "\$svc"
        fi
        ;;
    run)  exit "\${FAKE_RUNNER_RC:-0}" ;;
esac
exit 0
EOF
    chmod +x "$STUB/docker"
    export PATH="$STUB:$PATH"

    LOGS_DIR="$MAIN/cicchetto/e2e/container-logs"
    CENSUS="$LOGS_DIR/gap-scan.tsv"
}

# First occurrence of a pattern in the shared invocation log, as a line
# number. Empty when absent — the callers compare numerically, so an
# absent line would make the comparison error rather than pass.
first_line() {
    grep -n -- "$1" "$LOG" | head -1 | cut -d: -f1
}

@test "a failed run captures every container's log before the tear-down" {
    cd "$MAIN"
    FAKE_RUNNER_RC=1 run "$MAIN/scripts/integration.sh"
    [ "$status" -eq 1 ]

    local captured torn
    captured="$(first_line 'docker compose logs')"
    torn="$(first_line 'testnet down')"
    [ -n "$captured" ]
    [ -n "$torn" ]
    # The point: reading the logs must precede destroying the containers.
    [ "$captured" -lt "$torn" ]
}

@test "a failed run writes one file per compose service, plus the ps table" {
    cd "$MAIN"
    FAKE_RUNNER_RC=1 run "$MAIN/scripts/integration.sh"
    [ "$status" -eq 1 ]

    [ -s "$LOGS_DIR/grappa-test.log" ]
    [ -s "$LOGS_DIR/hub.log" ]
    # Derived, not listed: this service exists only in the stub's output.
    [ -s "$LOGS_DIR/newcomer-svc.log" ]
    [ -s "$LOGS_DIR/compose-ps.txt" ]

    grep -q 'db=30064.1ms query returned' "$LOGS_DIR/grappa-test.log"
}

@test "a failed run writes the census alongside the raw logs" {
    cd "$MAIN"
    FAKE_RUNNER_RC=1 run "$MAIN/scripts/integration.sh"
    [ "$status" -eq 1 ]

    # The red path keeps both. The census costs nothing beside the bytes,
    # and one instrument that behaves the same on both exits is easier to
    # keep honest than a green-only second one.
    [ -s "$CENSUS" ]
    grep -q 'grappa-test.*maxgap=30.1' "$CENSUS"

    # The verdict is recorded on a red too. Retention is unconditional
    # here, but WHAT was observed still is not — a red that carried damage
    # without a stall has to stay countable alongside the greens.
    grep -q 'RETENTION.*kept=yes.*by_gap=1.*by_dropped=1' "$CENSUS"
}

@test "a CLEAN green run writes the census and keeps no raw logs" {
    cd "$MAIN"
    FAKE_RUNNER_RC=0 FAKE_STREAM=clean run "$MAIN/scripts/integration.sh"

    # Evidence collection, not a new assertion: a green run stays green.
    [ "$status" -eq 0 ]

    # The census is written, and its service set is DERIVED — including
    # the one no hand list contains.
    [ -s "$CENSUS" ]
    grep -q '^grappa-test' "$CENSUS"
    grep -q '^hub' "$CENSUS"
    grep -q '^newcomer-svc' "$CENSUS"

    # ...and it MEASURED. The healthcheck cadence is named as such, so a
    # census that reported a constant, or scanned nothing, cannot pass.
    grep -q 'grappa-test.*maxgap=5.0' "$CENSUS"
    grep -q 'grappa-test.*gaps_ge_10=0' "$CENSUS"
    grep -q 'grappa-test.*dropped=0' "$CENSUS"
    refute grep -q 'GAP' "$CENSUS"
    # A quiet service reads as quiet rather than as missing.
    grep -q 'hub.*maxgap=0.0' "$CENSUS"

    # The 275 MB is the thing that could not be kept on every green: with
    # nothing measured, there is nothing to forensick, so the bytes go.
    [ ! -e "$LOGS_DIR/grappa-test.log" ]
    [ ! -e "$LOGS_DIR/hub.log" ]
    [ ! -e "$LOGS_DIR/compose-ps.txt" ]

    # The census also reaches stdout, which CI retains as the job log for
    # a green run without any artifact at all.
    grep -q 'maxgap=5.0' <<<"$output"

    # The verdict is recorded even when nothing was retained, so "no
    # damage" and "not looked at" stay distinguishable in the artifact.
    grep -q 'RETENTION.*kept=no' "$CENSUS"
    grep -q 'RETENTION.*by_gap=0.*by_dropped=0' "$CENSUS"

    # ...and the stack still came down.
    grep -q 'testnet down' "$LOG"
}

@test "a green run that MEASURED a stall keeps the bytes too" {
    cd "$MAIN"
    FAKE_RUNNER_RC=0 FAKE_STREAM=stall run "$MAIN/scripts/integration.sh"

    # Still not a gate: measuring a stall does not fail the run.
    [ "$status" -eq 0 ]
    grep -q 'grappa-test.*maxgap=30.1' "$CENSUS"

    # A green run that measured a stall is the first non-blind green there
    # has ever been, and the census alone cannot be forensicked — so this
    # is the one green whose bytes are worth keeping.
    [ -s "$LOGS_DIR/grappa-test.log" ]
    [ -s "$LOGS_DIR/hub.log" ]
    [ -s "$LOGS_DIR/compose-ps.txt" ]
    grep -q 'db=30064.1ms query returned' "$LOGS_DIR/grappa-test.log"

    grep -q 'RETENTION.*kept=yes.*by_gap=1' "$CENSUS"
}

@test "a green run with DAMAGE but no stall keeps the bytes, and says so" {
    cd "$MAIN"
    FAKE_RUNNER_RC=0 FAKE_STREAM=damage run "$MAIN/scripts/integration.sh"

    [ "$status" -eq 0 ]

    # Nothing here trips a silence: the cadence is 5 s, under the
    # threshold. The damage is the only signal.
    grep -q 'grappa-test.*maxgap=5.0' "$CENSUS"
    grep -q 'grappa-test.*gaps_ge_10=0' "$CENSUS"
    grep -q 'grappa-test.*dropped=1' "$CENSUS"
    refute grep -q 'GAP' "$CENSUS"

    # Retention is a different job from attribution. A gap is a proxy for
    # a mechanism; a dropped row IS the damage. Discarding the bytes here
    # would make "damage WITHOUT a stall" permanently unobservable —
    # which is the class nobody can currently prove exists.
    [ -s "$LOGS_DIR/grappa-test.log" ]
    grep -q 'scrollback row dropped' "$LOGS_DIR/grappa-test.log"

    # And the census says WHICH trigger fired, so that class becomes
    # countable rather than merely retained: one grep over the artifacts.
    grep -q 'RETENTION.*kept=yes.*by_gap=0.*by_dropped=1' "$CENSUS"
}
