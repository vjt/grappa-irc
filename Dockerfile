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

FROM elixir:1.20.1-otp-29-alpine

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

# Toolchain image ONLY — no baked hex/rebar, deps, or _build (#364 docker
# S1). Every runtime shape bind-mounts the repo over /app (dev compose
# `./:/app`; deploy.sh + quickstart.sh; both e2e services `../..:/app`),
# and MIX_HOME/HEX_HOME + deps/ + _build/ all live UNDER /app — so any
# image-baked `mix local.hex` / `COPY mix.exs mix.lock` / `mix deps.get` /
# `mix compile` layer is 100% SHADOWED by that mount at runtime. It buys
# nothing (it cannot seed the host tree), yet it made every `docker
# compose build` re-run C-NIF dep compilation and invalidated the
# `COPY . .` layer on any repo edit — and it made the "clone-and-go"
# claim false (a fresh clone has no host-side hex/deps, and the baked
# ones are invisible). Deps are installed into the BIND-MOUNTED tree at
# first boot instead:
#   - dev `docker compose up` → bin/start.sh self-heals (hex + deps.get
#     when deps/ is empty), so it is genuinely clone-and-go;
#   - scripts/quickstart.sh → installs them explicitly (standalone path);
#   - scripts/deploy.sh → syncs deps on every deploy;
#   - the e2e seeder → installs before grappa-test boots.
# Result: image builds drop from minutes to seconds and the image shrinks.

EXPOSE 4000

HEALTHCHECK --interval=5s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://localhost:4000/healthz || exit 1

# bin/start.sh exports BEAM resource caps (formerly rel/env.sh.eex) and
# execs `mix phx.server`. Same shell idioms work in dev + prod because
# MIX_ENV is the only env-distinguishing variable.
CMD ["bin/start.sh"]
