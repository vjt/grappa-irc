# grappa — IRC bouncer (Elixir/OTP + Phoenix)
#
# Single-stage image: dev = prod = CI = one path, one runtime, one
# binary. `mix phx.server` boots in every environment. The release
# build was dropped in CP23 cluster `cluster/code-reload` to enable
# Phoenix.CodeReloader hot-deploy of running sessions.
#
# Base image: `elixir:1.19-otp-28-alpine` (Docker Hub official). The
# previous multi-stage debian build used `hexpm/elixir:VSN-erlang-VSN-
# debian-VSN` for tighter alpine-tuple pinning, but `hexpm/elixir`
# does NOT publish alpine variants for Elixir 1.19 / OTP 28 — the
# official `elixir:1.19-otp-28-alpine` is the upstream-supported alpine
# path. Elixir + OTP are still pinned via the tag; alpine version
# floats with whatever Docker library publishes for that tag.

FROM elixir:1.19-otp-28-alpine

# build-base + git for hex deps; sqlite-dev for ecto_sqlite3 NIF link;
# curl for the in-container /healthz probe + future hot-deploy POST;
# inotify-tools for Phoenix code-reloader file watch (live in dev,
# request-driven in prod, both rely on the same Erlang port driver).
# exiftool + ffmpeg for Grappa.Uploads.MetadataStrip (#39): exiftool
# strips images + mp4/mov losslessly; ffmpeg remuxes webm (the one
# allowlisted upload type exiftool cannot write). Jail equivalent:
# docs/OPERATIONS.md "Jail package dependencies".
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

# Build as root (alpine `elixir` ships no non-root user); compose
# `user:` directive drops to host UID at runtime so bind-mounted source
# stays writable by the operator.
RUN mix local.hex --force && mix local.rebar --force

# Pre-fetch + compile deps so subsequent rebuilds skip network and
# C-NIF compilation unless mix.lock or config/* change.
COPY mix.exs mix.lock ./
RUN mix deps.get

COPY config/ config/
RUN mix deps.compile

COPY . .
RUN mix compile

EXPOSE 4000

HEALTHCHECK --interval=5s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://localhost:4000/healthz || exit 1

# bin/start.sh exports BEAM resource caps (formerly rel/env.sh.eex) and
# execs `mix phx.server`. Same shell idioms work in dev + prod because
# MIX_ENV is the only env-distinguishing variable.
CMD ["bin/start.sh"]
