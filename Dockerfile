# grappa — IRC bouncer (Elixir/OTP + Phoenix)
#
# Multi-stage build:
#   build   — full Elixir toolchain, mix tasks, deps, compiled artifacts.
#             Used directly as the dev image (bind-mounted source).
#   runtime — minimal Debian + OTP release. Used for prod deploys.
#
# Base image: hexpm/elixir keeps Erlang/Elixir/Debian versions in sync,
# avoiding the version-skew pain of mixing official elixir + erlang images.

ARG ELIXIR_VERSION=1.19.5
ARG OTP_VERSION=28.5
ARG DEBIAN_VERSION=bookworm-20260421-slim
ARG CONTAINER_UID=1000
ARG CONTAINER_GID=1000

# ─── Build stage ──────────────────────────────────────────────────────────────
FROM hexpm/elixir:${ELIXIR_VERSION}-erlang-${OTP_VERSION}-debian-${DEBIAN_VERSION} AS build

ARG CONTAINER_UID
ARG CONTAINER_GID

# Build deps (need build-essential for ecto_sqlite3 NIFs, git for git deps)
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        build-essential git curl ca-certificates locales sqlite3 inotify-tools && \
    sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen && \
    rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    MIX_HOME=/app/.mix \
    HEX_HOME=/app/.hex

# Match host UID/GID so bind-mounted sources are owned by the dev user.
RUN groupadd -g ${CONTAINER_GID} grappa && \
    useradd -m -u ${CONTAINER_UID} -g grappa -d /app -s /bin/bash grappa

WORKDIR /app
RUN chown -R grappa:grappa /app

USER grappa

RUN mix local.hex --force && mix local.rebar --force

# Pre-fetch deps so dev rebuilds skip network unless mix.lock changes.
COPY --chown=grappa:grappa mix.exs mix.lock ./
RUN mix deps.get

COPY --chown=grappa:grappa config/ config/
RUN mix deps.compile

COPY --chown=grappa:grappa . .

# Default for dev: phx.server (bind-mount overrides /app at runtime).
# Prod build proceeds to the runtime stage and uses `bin/grappa start`.
EXPOSE 4000
CMD ["mix", "phx.server"]


# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM debian:${DEBIAN_VERSION} AS runtime

ARG CONTAINER_UID
ARG CONTAINER_GID

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        libstdc++6 openssl libncurses6 locales ca-certificates curl sqlite3 && \
    sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen && \
    rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LANGUAGE=en_US:en

RUN groupadd -g ${CONTAINER_GID} grappa && \
    useradd -m -u ${CONTAINER_UID} -g grappa -d /app -s /bin/bash grappa

WORKDIR /app

# Build the release in the build stage with prod env. Override the build
# stage's CMD by re-running mix release here so the base build stage stays
# usable for dev workflows.
USER grappa
COPY --from=build --chown=grappa:grappa /app /src
RUN cd /src && \
    MIX_ENV=prod mix deps.get --only prod && \
    MIX_ENV=prod mix release --overwrite && \
    cp -r _build/prod/rel/grappa/* /app/ && \
    rm -rf /src

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:4000/healthz || exit 1

CMD ["bin/grappa", "start"]
