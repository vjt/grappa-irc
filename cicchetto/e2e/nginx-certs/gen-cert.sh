#!/bin/sh
# Self-signed cert for the e2e nginx-test TLS listener — push
# notifications cluster B5 (2026-05-14).
#
# The cic SW + Push API + Notification API all require an isolated
# secure context per W3C Push spec. The integration harness's
# nginx-test serves over plain HTTP by default; chromium's
# `--unsafely-treat-insecure-origin-as-secure` flag does not honor
# Playwright's launch shape (Playwright rejects `--user-data-dir`
# which the chromium flag requires for profile-scoped allow-listing,
# observed: chromium 1.59 reports `isSecureContext: false` even with
# the flag set). Self-signed TLS is the canonical workaround:
# Playwright `ignoreHTTPSErrors: true` accepts the cert, isSecureContext
# flips to true, push API surfaces.
#
# Cert is generated ONCE per integration run (idempotent via the
# `if [ ! -s nginx.crt ]` guard) and re-used; subsequent runs are
# zero-cost. Output: `nginx.crt` + `nginx.key` (separate files —
# nginx's `ssl_certificate` + `ssl_certificate_key` directives
# read them independently).
set -eu
cd "$(dirname "$0")"

if ! command -v openssl >/dev/null 2>&1; then
    apk add --no-cache openssl >/dev/null
fi

if [ ! -s nginx.crt ] || [ ! -s nginx.key ]; then
    # SAN: nginx-test (docker DNS alias) + localhost (for in-container
    # debugging via `docker exec`). CN matches the most-used name.
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
        -subj "/CN=nginx-test" \
        -addext "subjectAltName=DNS:nginx-test,DNS:localhost,IP:127.0.0.1" \
        -keyout nginx.key -out nginx.crt >/dev/null 2>&1
    echo "generated nginx.crt + nginx.key"
fi
