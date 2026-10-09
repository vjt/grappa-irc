# grappa — build image for Anthropic's OSS Scanner (issue 2362).
#
# Contract (github.com/anthropics/oss-scanner, templates/Dockerfile): the
# build context is the repository, the checkout lives at /src, and the
# network exists ONLY while this file builds — the scan runs offline. So
# every hex dep, every bun package and every compile the tests need happens
# here.
#
# Built from what the repo already ships rather than from scratch:
#   - the toolchain tuple of the top-level `Dockerfile` and of stage 2 of
#     `Dockerfile.release` (`elixir:1.19-otp-28-alpine`, matching
#     `.tool-versions`), with the toolchain image's apk set: exiftool +
#     ffmpeg because Grappa.Uploads.MetadataStrip fails closed without them;
#   - bun at the version CI tests cicchetto with: `.github/workflows/ci.yml`
#     and `scripts/bun.sh` pin `oven/bun:1` at a digest that is bun 1.3.14,
#     and this is the alpine build of that same version, digest-pinned
#     (#103 supply-chain), copied in as a binary. NOT the `oven/bun:1-alpine`
#     digest stage 1 of `Dockerfile.release` pins: that one is bun 1.4.2,
#     and under 1.4.2 two `dateFormat.test.ts` cases fail on an
#     `Intl.DateTimeFormat` comma that 1.3.14 does not emit — measured on
#     debian too, so it is the version and not musl;
#   - the cicchetto build through `infra/packaging/version.sh` and
#     `credits.sh`, exactly as `Dockerfile.release` drives it.
#
# The context filter is `.oss-scanner/Dockerfile.dockerignore`, not the root
# `.dockerignore`: that one drops `docs/`, which is the design record a
# reviewer of this code wants.

# Refresh on a bump, together with the CI pin:
#   docker buildx imagetools inspect oven/bun:<version>-alpine --format '{{.Manifest.Digest}}'
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS bun

FROM elixir:1.19-otp-28-alpine

RUN apk add --no-cache \
        build-base \
        git \
        curl \
        bash \
        ca-certificates \
        sqlite-dev \
        ncurses \
        libstdc++ \
        libgcc \
        exiftool \
        ffmpeg

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    MIX_HOME=/root/.mix \
    HEX_HOME=/root/.hex

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# Every dep for every env: the test env pulls Mox, Bypass, StreamData and
# friends, and nothing can be fetched once the scan starts. `runtime/` is
# where config/test.exs puts the sqlite file and the upload/DCC spools.
RUN mix local.hex --force \
    && mix local.rebar --force \
    && mix deps.get \
    && mkdir -p runtime \
    && MIX_ENV=dev mix compile \
    && MIX_ENV=test mix compile

# The PWA. `vite build` refuses to run without GRAPPA_VERSION (#538) and
# GRAPPA_CREDITS (#1773); both come from the scripts the release builds use.
RUN cd cicchetto \
    && bun install --frozen-lockfile \
    && GRAPPA_VERSION="$(sh ../infra/packaging/version.sh)" \
    && export GRAPPA_VERSION \
    && GRAPPA_CREDITS="$(sh ../infra/packaging/credits.sh)" \
    && export GRAPPA_CREDITS \
    && bun run build

# The tests, so the image is known to work; a failure warns, it does not
# abort the build. The WHOLE ExUnit suite fits: measured on this image
# (2026-10-09, arm64, docker on a laptop), `mix test` took 179 s for 7919
# tests, against the scanner's 45-minute build budget. vitest took 16 s.
# No e2e: Playwright needs a browser and the full compose stack.
RUN MIX_ENV=test mix test || echo "WARNING: mix test reported failures"
RUN cd cicchetto && (bun run test || echo "WARNING: vitest reported failures")
