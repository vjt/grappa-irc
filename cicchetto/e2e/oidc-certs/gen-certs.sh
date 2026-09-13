#!/bin/sh
# #1911 — PKI for the stub OP (oidc-op): a throwaway CA, a leaf for the
# `oidc-test` docker alias, and the MERGED trust bundle grappa-test mounts.
#
# Why a CA + leaf (and not one self-signed cert, like ../nginx-certs): the
# grappa side of the OIDC contract is Req/Finch with verify_peer against
# the SYSTEM store — :public_key.cacerts_get() on the alpine image reads
# /etc/ssl/certs/ca-certificates.crt (measured: the file decodes into
# {ok, certs}). Mounting the CA into that bundle is the ONLY production
# shape that exercises the real verification path: a self-signed leaf
# would need the verify knob weakened, and grappa deliberately has none.
# The bundle is the image's own public CAs + our CA concatenated, so the
# mount-over clobbers nothing else grappa might reach over TLS.
#
# Idempotent via the `-s` guards (same shape as gen-cert.sh): a re-run
# with every artifact present installs no packages and generates nothing,
# which is what makes it safe as grappa-test's
# `service_completed_successfully` dependency under `compose up --wait`
# (the wrapper re-runs exited one-shots).
#
# Outputs (all gitignored, all throwaway, `compose down -v` class state):
#   ca.crt / ca.key      — the e2e CA (key 0644: only containers read it)
#   oidc.crt / oidc.key  — leaf, SAN oidc-test (the docker DNS alias)
#   ca-bundle.crt        — system CAs + ca.crt; mounted OVER grappa-test's
#                          /etc/ssl/certs/ca-certificates.crt
set -eu
cd "$(dirname "$0")"

if [ ! -s ca.crt ] || [ ! -s ca.key ] || [ ! -s oidc.crt ] || [ ! -s oidc.key ] || [ ! -s ca-bundle.crt ]; then
    # Inside the guard: a warm re-run stays offline and instant.
    if ! command -v openssl >/dev/null 2>&1; then
        apk add --no-cache openssl >/dev/null
    fi
    # ca-certificates provides the system bundle the merge starts from.
    # Best-effort presence probe: the alpine base ships without it.
    if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then
        apk add --no-cache ca-certificates >/dev/null
    fi

    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
        -subj "/CN=grappa-e2e-oidc-CA" \
        -keyout ca.key -out ca.crt >/dev/null 2>&1

    openssl req -newkey rsa:2048 -nodes \
        -subj "/CN=oidc-test" \
        -keyout oidc.key -out oidc.csr >/dev/null 2>&1
    # SAN: oidc-test (the docker DNS alias grappa dials) + localhost for
    # in-container debugging. CN is cosmetic; the SAN is what RFC 6125
    # hostname checking reads.
    printf "subjectAltName=DNS:oidc-test,DNS:localhost,IP:127.0.0.1\n" >san.ext
    openssl x509 -req -in oidc.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
        -days 365 -sha256 -extfile san.ext -out oidc.crt >/dev/null 2>&1
    rm -f oidc.csr san.ext ca.srl

    cat /etc/ssl/certs/ca-certificates.crt ca.crt >ca-bundle.crt

    # oidc-op runs as nobody (65534) and reads the leaf key; the secrets
    # are per-run throwaways, so o+r is the honest shape (mirrors why
    # nginx-certs keeps its key out of the runner context instead — see
    # ../.dockerignore).
    chmod 644 ca.key oidc.key
    echo "generated oidc-op CA + leaf + merged ca-bundle.crt"
fi
