#!/bin/bash
# Register grappa.bad.ass A record via Technitium DNS API.
#
# Idempotent: re-running is safe; treats "record already exists" as
# success. Operator runs manually after the first prod deploy of nginx
# (compose.prod.yaml + scripts/deploy.sh) so iPhone PWA install can
# resolve grappa.bad.ass on the home LAN/VPN.
#
# Reads TECHNITIUM_API_TOKEN from /srv/dns/.env on this host (override
# with TECHNITIUM_ENV_FILE). Other knobs available via env vars:
#   GRAPPA_DOMAIN     default grappa.bad.ass
#   GRAPPA_ZONE       default bad.ass
#   GRAPPA_IP         default 192.168.53.11   (nginx vlan53 IP)
#   GRAPPA_TTL        default 300
#   TECHNITIUM_API_URL default https://ns1.bad.ass/api/zones/records/add
#
# Technitium quirks: API takes params as query-string (NOT JSON body);
# self-signed cert (curl -sk); response JSON has "status":"ok" or
# "status":"error" + "errorMessage":"...".

set -euo pipefail

ENV_FILE="${TECHNITIUM_ENV_FILE:-/srv/dns/.env}"
DOMAIN="${GRAPPA_DOMAIN:-grappa.bad.ass}"
ZONE="${GRAPPA_ZONE:-bad.ass}"
IP="${GRAPPA_IP:-192.168.53.11}"
TTL="${GRAPPA_TTL:-300}"
API_URL="${TECHNITIUM_API_URL:-https://ns1.bad.ass/api/zones/records/add}"

if [ ! -r "$ENV_FILE" ]; then
    echo "register-dns.sh: env file '$ENV_FILE' not readable" >&2
    exit 1
fi

# shellcheck disable=SC1090
. "$ENV_FILE"

if [ -z "${TECHNITIUM_API_TOKEN:-}" ]; then
    echo "register-dns.sh: TECHNITIUM_API_TOKEN missing from '$ENV_FILE'" >&2
    exit 1
fi

response="$(curl -sk -X POST \
    --data-urlencode "token=$TECHNITIUM_API_TOKEN" \
    --data-urlencode "domain=$DOMAIN" \
    --data-urlencode "zone=$ZONE" \
    --data-urlencode "type=A" \
    --data-urlencode "ipAddress=$IP" \
    --data-urlencode "ttl=$TTL" \
    "$API_URL")"

# Shallow JSON extract — Technitium's status + errorMessage are top-level.
status="$(printf '%s' "$response" | sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
errmsg="$(printf '%s' "$response" | sed -nE 's/.*"errorMessage"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"

case "$status" in
    ok)
        echo "✓ DNS record registered: $DOMAIN A $IP (TTL $TTL)"
        ;;
    error)
        if printf '%s' "$errmsg" | grep -qi "already exists"; then
            echo "✓ DNS record already exists: $DOMAIN A $IP (idempotent — no-op)"
        else
            echo "register-dns.sh: API error: $errmsg" >&2
            echo "register-dns.sh: full response: $response" >&2
            exit 1
        fi
        ;;
    *)
        echo "register-dns.sh: unexpected response: $response" >&2
        exit 1
        ;;
esac
