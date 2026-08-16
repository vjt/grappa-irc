#!/usr/bin/env bats
#
# Bats suite for the `PORT` knob on the Docker substrate (#1409 D-S6).
#
# WHY THIS EXISTS
#
# `.env.example` presented `PORT` as an ordinary knob with no caveat and
# `compose.yaml` gave it a literal default specifically so the override would
# not be a silent no-op (#369 X1). But on the Docker substrate NOTHING
# consumes it: the container side of the publish, the compose healthcheck,
# the Dockerfile EXPOSE + HEALTHCHECK, `scripts/healthcheck.sh`, the
# `/admin/reload` and `/admin/cic-bundle-changed` POSTs all hardcode 4000.
# `PORT=4001` therefore yields a container that is healthy and reported
# unhealthy, a `depends_on: service_healthy` that never resolves, and a
# deploy that fails at the reload POST.
#
# Docker is the LOCAL DEV stack (CLAUDE.md: nothing production runs on it),
# so threading the port through it is work with no user. The knob is marked
# unsupported there instead, and this suite pins BOTH halves of that: the
# prose that says so, and the absence of the consumer that would make the
# prose a lie.
#
# The absence half needs a probe that can be trusted, so the same grep is
# first pointed at `infra/linux/install.sh`, the Docker-free substrate that
# DOES honour `${PORT}`. If that known-positive stops matching, the probe is
# broken and every "absent" assertion below is vacuous.

load ../bats_helpers

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
}

@test "the PORT probe finds the substrate that does honour it (falsification)" {
    # Positive control for every "no consumer" assertion in this file.
    grep -qE '\$\{PORT' "$ROOT/infra/linux/install.sh"
}

@test ".env.example marks PORT unsupported on Docker" {
    grep -A4 '^PORT=' "$ROOT/.env.example" > "$BATS_TEST_TMPDIR/port_block" || true
    grep -B6 '^PORT=' "$ROOT/.env.example" >> "$BATS_TEST_TMPDIR/port_block" || true
    grep -qi 'docker' "$BATS_TEST_TMPDIR/port_block"
}

@test "the compose PORT line carries the same caveat" {
    grep -B6 'PORT: \${PORT' "$ROOT/compose.yaml" > "$BATS_TEST_TMPDIR/compose_block"
    grep -qi 'docker' "$BATS_TEST_TMPDIR/compose_block"
}

@test "no Docker-side consumer reads PORT" {
    # compose.yaml:98 passes it INTO the app and is the one legitimate
    # mention; everything else on this substrate must not pretend to read it.
    for f in "$ROOT/Dockerfile" "$ROOT/scripts/healthcheck.sh" \
             "$ROOT/scripts/deploy-cic.sh" "$ROOT/infra/lib/deploy_docker.sh"; do
        refute grep -qE '\$\{?PORT' "$f"
    done
}

@test "the Docker substrate still hardcodes 4000, so the caveat is not stale" {
    # The inverse pin: the day someone threads PORT for real, these fail and
    # the caveat must be revisited rather than left lying.
    grep -q 'localhost:4000/healthz' "$ROOT/scripts/healthcheck.sh"
    grep -q 'localhost:4000/admin/reload' "$ROOT/infra/lib/deploy_docker.sh"
}
