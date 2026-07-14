# syntax=docker/dockerfile:1.6
#
# #221 — solanum (Libera.Chat's ircd) node for the grappa e2e testnet.
# Replaces the second standalone bahamut (azzurra2/bahamut-test2) so
# integration tests exercise grappa's parser against the REAL ircd Libera
# runs — the WHOIS numeric set, on-connect usermodes, and WHO-mask
# round-trip these #221 fixes touch, validated against solanum rather than
# a bahamut mock.
#
# Build context lives in the grappa repo (NOT the azzurra-testnet
# submodule under infra/) because solanum is a different upstream with a
# different conf format + build system (meson/ninja vs bahamut's autoconf).
FROM debian:trixie AS build
ARG SOLANUM_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config meson ninja-build \
    libsqlite3-dev flex bison libssl-dev libltdl-dev \
    ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Support branches, tags, and arbitrary refs (incl. full SHAs) by
# initialising an empty repo + shallow-fetching the requested ref, mirror
# of the bahamut node's fetch shape.
RUN git init -q \
 && git remote add origin https://github.com/solanum-ircd/solanum.git \
 && git fetch --depth=1 origin "${SOLANUM_REF}" \
 && git checkout -q FETCH_HEAD
# Install to /usr/local/solanum (self-contained PREFIX — solanum resolves
# its etc/ conf + module paths relative to the prefix).
RUN meson setup build --optimization 2 --prefix=/usr/local/solanum \
 && meson compile -C build \
 && meson install -C build

FROM debian:trixie-slim
# netbase provides /etc/services — solanum's authd resolves its nameserver
# via getaddrinfo(ns, "domain", …) (reslib.c:232), looking up the "domain"
# service (port 53) in /etc/services. Without it EVERY nameserver is
# rejected → authd dies "no name servers" → non-loopback client
# registration stalls. libltdl7: solanum dlopen's its modules via libltdl.
# gosu: entrypoint drops root→ircd after repairing resolv.conf.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 libssl3 libltdl7 gettext-base gosu netbase \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/solanum /usr/local/solanum
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY ircd.conf.tmpl /etc/solanum/ircd.conf.tmpl
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && useradd -r -s /usr/sbin/nologin -d /usr/local/solanum ircd \
 && mkdir -p /usr/local/solanum/etc /usr/local/solanum/logs \
 && chown -R ircd: /usr/local/solanum /etc/solanum
# Entrypoint starts as ROOT (to repair resolv.conf for authd — see
# entrypoint.sh) then drops to the unprivileged ircd user via gosu before
# exec'ing solanum (which refuses to run as root). No USER directive.
WORKDIR /usr/local/solanum
EXPOSE 6667
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
