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
# Stubs, not a real stack: a `docker` on PATH records every invocation
# and answers the three queries the capture makes, and testnet.sh is
# replaced by a recorder. Both append to ONE log, so the order between
# "logs were read" and "the stack came down" is a line comparison.
#
# The service set is checked with a name no hand-written list could
# contain — the capture derives it from `docker compose ps`, and a
# derived set is the difference between covering the service added next
# year and covering the one somebody remembered.

load ../bats_helpers

setup() {
    INTEGRATION_SH="$BATS_TEST_DIRNAME/../../scripts/integration.sh"
    LIB_SH="$BATS_TEST_DIRNAME/../../scripts/_lib.sh"
    VERSION_SH="$BATS_TEST_DIRNAME/../../infra/packaging/version.sh"

    TMP="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    MAIN="$TMP/main"
    LOG="$TMP/invocations.log"
    : >"$LOG"

    mkdir -p "$MAIN/scripts" "$MAIN/infra/packaging" "$MAIN/lib" "$MAIN/cicchetto/e2e"
    cp "$INTEGRATION_SH" "$MAIN/scripts/integration.sh"
    cp "$LIB_SH" "$MAIN/scripts/_lib.sh"
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
    logs) printf 'fake container output for %s\n' "\${*: -1}" ;;
    run)  exit "\${FAKE_RUNNER_RC:-0}" ;;
esac
exit 0
EOF
    chmod +x "$STUB/docker"
    export PATH="$STUB:$PATH"

    LOGS_DIR="$MAIN/cicchetto/e2e/container-logs"
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

    grep -q 'fake container output for grappa-test' "$LOGS_DIR/grappa-test.log"
}

@test "a green run captures nothing" {
    cd "$MAIN"
    FAKE_RUNNER_RC=0 run "$MAIN/scripts/integration.sh"
    [ "$status" -eq 0 ]

    # Failure-only: collecting on every run is how an artifact store
    # becomes a landfill, and a green run's logs answer no question.
    refute grep -q 'docker compose logs' "$LOG"
    [ ! -d "$LOGS_DIR" ]
    # ...and the stack still came down.
    grep -q 'testnet down' "$LOG"
}
