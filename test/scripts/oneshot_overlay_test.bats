#!/usr/bin/env bats
#
# Bats suite for compose.oneshot.yaml — what the overlay actually buys
# (#1409 D-S7).
#
# WHY THIS EXISTS
#
# The overlay and `_lib.sh` both claimed a hazard: "without it a oneshot
# inherits `container_name: grappa` and the host port-publishes, and both
# collide with the long-lived copy", with a misplaced `-f` called a
# "one-character-edit hazard". Meanwhile six `compose run --rm` invocations
# on the deploy path do not layer the overlay at all and run against a live
# `grappa` by design. Both could not be true.
#
# Measured on 2026-08-16, with the long-lived `grappa` up and holding
# `192.168.53.12:4000`, by inspecting the ephemeral container `compose run`
# creates:
#
#   container_name  →  /grappa-grappa-run-3f90d538d15f, never `grappa`
#   PortBindings    →  {} (with --service-ports as the positive control:
#                      {"4000/tcp":[{"HostIp":"192.168.53.12",...}]})
#   RestartPolicy   →  "no", without the overlay's help
#   Healthcheck     →  INHERITED in full, curl /healthz, 5 retries
#
# So three of the four overlay keys were no-ops and the hazard prose was
# false. Only `healthcheck: disable: true` earns its keep, and this suite
# pins that reduction so the prose cannot grow back.
#
# Scope caveat, deliberately narrow: that measurement is Docker Desktop on
# macOS, one Compose version, one host. This suite pins OUR file, not
# Compose's semantics — a bats that asserted PortBindings would pin someone
# else's product and break on their upgrade with our tree unchanged.

load ../bats_helpers

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    OVERLAY="$ROOT/compose.oneshot.yaml"
    LIB="$ROOT/scripts/_lib.sh"
}

@test "the overlay still disables the healthcheck — the one key that is load-bearing" {
    grep -q 'disable: true' "$OVERLAY"
}

@test "the overlay no longer claims a container_name collision" {
    refute grep -q 'container_name' "$OVERLAY"
}

@test "the overlay no longer resets ports it never inherited" {
    refute grep -q 'ports' "$OVERLAY"
}

@test "_lib.sh no longer claims the overlay drops inherited host bindings" {
    # The review quoted a "one-character-edit hazard" phrase at :249-252 that
    # is not in the file — what IS there is the same falsified claim, that
    # `ports: !reset []` + `container_name: !reset null` "drop host-side
    # bindings inherited from the base file or the personal override". They
    # drop nothing: `run` never applied either.
    refute grep -q 'drop host-side bindings' "$LIB"
    refute grep -q 'container_name: !reset null' "$LIB"
}

@test "in_oneshot still layers the overlay last" {
    # The reduction is about what the file CONTAINS, not about dropping it:
    # the healthcheck override only applies if it is still layered.
    grep -q 'compose.oneshot.yaml' "$LIB"
}
