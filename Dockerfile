# grappa — IRC bouncer (Elixir/OTP + Phoenix).
#
# The single-stage TOOLCHAIN image, used by dev, CI and the compose prod
# stack: it bind-mounts the repo and boots `mix phx.server`, so
# Phoenix.CodeReloader can hot-deploy running sessions. The self-contained
# release image published to ghcr.io is a DIFFERENT file with a different
# role — see Dockerfile.release, and docs/OPERATIONS.md § "The two images:
# Dockerfile (toolchain) vs Dockerfile.release" for why there are two.

FROM elixir:1.20.2-otp-29-alpine

# build-base + git for hex deps; sqlite-dev for the ecto_sqlite3 NIF link;
# curl for the in-container /healthz probe and the hot-deploy POST;
# inotify-tools for the Phoenix code-reloader file watch; exiftool + ffmpeg
# for Grappa.Uploads.MetadataStrip (#39) — exiftool strips images and
# mp4/mov, ffmpeg remuxes webm. Jail equivalent: docs/OPERATIONS.md
# "Jail package dependencies".
RUN apk add --no-cache \
        build-base \
        git \
        curl \
        sqlite-dev \
        ncurses \
        inotify-tools \
        exiftool \
        ffmpeg

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/app \
    MIX_HOME=/app/.mix \
    HEX_HOME=/app/.hex \
    XDG_CACHE_HOME=/app/.cache \
    XDG_DATA_HOME=/app/.local/share

WORKDIR /app

# Toolchain ONLY — deliberately no baked hex/rebar, deps or _build (#364
# docker S1). Every runtime shape mounts the repo over /app, and MIX_HOME,
# HEX_HOME, deps/ and _build/ all live under it, so a baked layer would be
# shadowed at runtime. Deps are installed into the mounted tree at first
# boot instead, by bin/start.sh, scripts/quickstart.sh, scripts/deploy.sh
# and the e2e seeder. Do not add a `mix deps.get` layer here — why, and
# what it cost last time: docs/OPERATIONS.md § "The two images: Dockerfile
# (toolchain) vs Dockerfile.release".

EXPOSE 4000

HEALTHCHECK --interval=5s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://localhost:4000/healthz || exit 1

# bin/start.sh exports the BEAM resource caps, then execs `mix phx.server`.
CMD ["bin/start.sh"]
