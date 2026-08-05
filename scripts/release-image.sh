#!/usr/bin/env bash
# Build + exercise the self-contained RELEASE image (Dockerfile.release)
# locally — the sanctioned door for the `docker run ghcr.io/vjt/grappa:<tag>`
# path that #503 unit D ships and that nothing else in scripts/ could reach.
#
# Why this exists: docs/TESTING.md forbids raw `docker` from a shell or an
# agent, and every other wrapper drives the compose DEV stack. The release
# image is a different artifact with a different failure surface — #862
# (no secrets on a bare run) and #867 (no migration on a bare run) were both
# found by hand-typing docker commands, and unit D still carries a "run a
# real docker run of the published image before trusting these one-liners"
# caveat. This turns that into a repeatable command.
#
# Usage:
#   scripts/release-image.sh build            # buildx the local image
#   scripts/release-image.sh fresh-boot       # WIPE the volume, bare-run, wait /healthz
#   scripts/release-image.sh warm-boot        # bare-run on the EXISTING volume
#   scripts/release-image.sh oneshot <args…>  # `docker run --rm … <args>` on the volume
#   scripts/release-image.sh logs             # container logs
#   scripts/release-image.sh down [--volume]  # remove the container (and volume)
#
# `fresh-boot` / `warm-boot` reproduce the DOCUMENTED one-liner: the only
# thing they pass is PHX_HOST, which cannot be invented. Everything else
# must come from the image + the volume, or the one-liner is a lie.
#
# Knobs: GRAPPA_TEST_IMAGE (tag), GRAPPA_TEST_VOLUME, GRAPPA_TEST_CONTAINER,
# GRAPPA_TEST_PORT, PHX_HOST, GRAPPA_TEST_BOOT_TIMEOUT (seconds).

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$SRC_ROOT"

IMAGE="${GRAPPA_TEST_IMAGE:-grappa-release:local}"
VOLUME="${GRAPPA_TEST_VOLUME:-grappa-release-test-data}"
CONTAINER="${GRAPPA_TEST_CONTAINER:-grappa-release-test}"
PORT="${GRAPPA_TEST_PORT:-4599}"
BOOT_TIMEOUT="${GRAPPA_TEST_BOOT_TIMEOUT:-120}"
TEST_PHX_HOST="${PHX_HOST:-localhost}"

command -v docker >/dev/null 2>&1 || die "docker not found on PATH."

# remove_container — idempotent; the container may not exist.
remove_container() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

# boot — `docker run -d` the image exactly as the docs tell an operator to,
# then poll /healthz from the HOST until it answers or the deadline passes.
# Prints the container log on failure: a dead bare run is the whole point of
# this script, so its output must never be swallowed.
boot() {
    remove_container
    docker run -d \
        --name "$CONTAINER" \
        -v "${VOLUME}:/data" \
        -p "127.0.0.1:${PORT}:4000" \
        -e "PHX_HOST=${TEST_PHX_HOST}" \
        "$IMAGE" >/dev/null \
        || die "docker run failed — is the image built? (scripts/release-image.sh build)"

    local deadline=$((SECONDS + BOOT_TIMEOUT))
    until curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; do
        if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
            printf '\nrelease-image: the container EXITED before serving /healthz.\n' >&2
            docker logs "$CONTAINER" 2>&1 | tail -40 >&2
            die "bare run did not come up (container exited)"
        fi
        if [ "$SECONDS" -ge "$deadline" ]; then
            printf '\nrelease-image: /healthz never answered within %ss.\n' "$BOOT_TIMEOUT" >&2
            docker logs "$CONTAINER" 2>&1 | tail -40 >&2
            die "bare run did not come up (timeout)"
        fi
        printf '.'
        sleep 2
    done
    printf '\nrelease-image: /healthz 200 on http://127.0.0.1:%s/ 🎉\n' "$PORT"
}

case "${1:-}" in
build)
    shift
    [ $# -eq 0 ] || die "usage: scripts/release-image.sh build"
    exec docker buildx build -f Dockerfile.release --load -t "$IMAGE" .
    ;;
fresh-boot)
    shift
    [ $# -eq 0 ] || die "usage: scripts/release-image.sh fresh-boot"
    remove_container
    docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    boot
    ;;
warm-boot)
    shift
    [ $# -eq 0 ] || die "usage: scripts/release-image.sh warm-boot"
    boot
    ;;
oneshot)
    shift
    [ $# -gt 0 ] || die "usage: scripts/release-image.sh oneshot <args…>"
    exec docker run --rm -v "${VOLUME}:/data" -e "PHX_HOST=${TEST_PHX_HOST}" "$IMAGE" "$@"
    ;;
logs)
    shift
    exec docker logs "$CONTAINER" "$@"
    ;;
down)
    shift
    remove_container
    case "${1:-}" in
    --volume) docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true ;;
    '') ;;
    *) die "usage: scripts/release-image.sh down [--volume]" ;;
    esac
    ;;
*)
    die "usage: scripts/release-image.sh build|fresh-boot|warm-boot|oneshot <args…>|logs|down [--volume]"
    ;;
esac
