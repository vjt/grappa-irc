#!/usr/bin/env bash
# Register a grappa A record via Technitium DNS API.
#
# Personal/operator helper — not invoked by the standard dev or deploy
# flow. Pre-supposes a Technitium DNS server with API access and an
# env file containing TECHNITIUM_TOKEN. Tune the env vars below for
# your deployment; nothing is hardcoded to a particular IP/hostname.
#
# Idempotent in the strong sense: post-condition asserts the
# authoritative DNS answer matches the desired IP after this runs.
# If the record already resolves correctly, no API call is made. If
# it exists but resolves to a different IP (drift), the existing
# record is deleted and re-added — `add` alone would silently no-op
# on conflict and leave the wrong IP in place.
#
# Required env vars (no defaults — script refuses to run without):
#   GRAPPA_DOMAIN         FQDN to register, e.g. grappa.example.com
#   GRAPPA_ZONE           authoritative zone, e.g. example.com
#   GRAPPA_IP             A-record target IP
#
# Optional env vars (with defaults):
#   GRAPPA_TTL            default 300
#   TECHNITIUM_BASE_URL   default https://ns1.bad.ass/api
#   DNS_NS                default ns1.bad.ass     (post-condition dig)
#   TECHNITIUM_ENV_FILE   default /srv/dns/.env   (sourced for TECHNITIUM_TOKEN)
#
# Technitium quirks: API takes params as query-string (NOT JSON body);
# self-signed cert (curl -sk); response JSON has `status` + optional
# `errorMessage` at top level.

set -euo pipefail

ENV_FILE="${TECHNITIUM_ENV_FILE:-/srv/dns/.env}"
DOMAIN="${GRAPPA_DOMAIN:?GRAPPA_DOMAIN missing — e.g. export GRAPPA_DOMAIN=grappa.example.com}"
ZONE="${GRAPPA_ZONE:?GRAPPA_ZONE missing — e.g. export GRAPPA_ZONE=example.com}"
IP="${GRAPPA_IP:?GRAPPA_IP missing — e.g. export GRAPPA_IP=192.168.1.10}"
TTL="${GRAPPA_TTL:-300}"
TECHNITIUM_BASE_URL="${TECHNITIUM_BASE_URL:-https://ns1.bad.ass/api}"
DNS_NS="${DNS_NS:-ns1.bad.ass}"

if [ ! -r "$ENV_FILE" ]; then
    echo "register-dns.sh: env file '$ENV_FILE' not readable" >&2
    exit 1
fi

# shellcheck disable=SC1090
. "$ENV_FILE"

if [ -z "${TECHNITIUM_TOKEN:-}" ]; then
    echo "register-dns.sh: TECHNITIUM_TOKEN missing from '$ENV_FILE'" >&2
    exit 1
fi

# Print only `status` + `errorMessage` from a Technitium response —
# never the full body. Defense in depth: if Technitium ever echoes
# the API token in an error reply (current versions don't, but the
# request token rides every call), the leak would surface in operator
# stdout/CI logs. Tab-separated for cut downstream.
api_call() {
    local endpoint="$1"
    shift
    local response status errmsg
    response="$(curl -sk -X POST \
        --data-urlencode "token=$TECHNITIUM_TOKEN" \
        "$@" \
        "$TECHNITIUM_BASE_URL/$endpoint")"
    status="$(printf '%s' "$response" | sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
    errmsg="$(printf '%s' "$response" | sed -nE 's/.*"errorMessage"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
    printf '%s\t%s\n' "$status" "$errmsg"
}

# Authoritative pre-check. dig with +short prints just the answer;
# +tries=1 + +timeout=5 fails fast on a dead nameserver. `|| true`
# absorbs dig's own non-zero exit on no-answer (record absent).
current="$(dig @"$DNS_NS" "$DOMAIN" A +short +timeout=5 +tries=1 2>/dev/null || true)"
if [ "$current" = "$IP" ]; then
    echo "✓ DNS record already correct: $DOMAIN A $IP (no API call needed)"
    exit 0
fi

# Drift OR absence — both end with "delete then add" so the record
# is authoritative regardless of prior state. Delete failure on a
# non-existent record is expected and not fatal.
echo "  current: '$DOMAIN' → '${current:-<none>}', desired: '$IP' — re-registering"

del_result="$(api_call zones/records/delete \
    --data-urlencode "domain=$DOMAIN" \
    --data-urlencode "zone=$ZONE" \
    --data-urlencode "type=A")"
del_status="$(printf '%s' "$del_result" | cut -f1)"
del_err="$(printf '%s' "$del_result" | cut -f2)"
case "$del_status" in
    ok)
        echo "  • deleted prior $DOMAIN A record"
        ;;
    error)
        # Idempotent: prior absence is fine, the add below will create.
        echo "  • no prior $DOMAIN A record to delete (api: ${del_err:-<no message>})"
        ;;
    *)
        echo "register-dns.sh: unexpected delete-status: '${del_status:-<empty>}' err='${del_err:-<none>}'" >&2
        exit 1
        ;;
esac

add_result="$(api_call zones/records/add \
    --data-urlencode "domain=$DOMAIN" \
    --data-urlencode "zone=$ZONE" \
    --data-urlencode "type=A" \
    --data-urlencode "ipAddress=$IP" \
    --data-urlencode "ttl=$TTL")"
add_status="$(printf '%s' "$add_result" | cut -f1)"
add_err="$(printf '%s' "$add_result" | cut -f2)"
if [ "$add_status" != "ok" ]; then
    echo "register-dns.sh: API add failed: status='${add_status:-<empty>}' err='${add_err:-<none>}'" >&2
    exit 1
fi
echo "✓ DNS record set: $DOMAIN A $IP (TTL $TTL)"

# Post-condition. Tiny settle delay: Technitium's in-zone cache lags
# the add slightly. If the new answer doesn't propagate within ~3s
# something is wrong with the zone serial or the upstream resolver.
sleep 1
final="$(dig @"$DNS_NS" "$DOMAIN" A +short +timeout=5 +tries=1 2>/dev/null || true)"
if [ "$final" != "$IP" ]; then
    echo "register-dns.sh: post-condition failed — '$DOMAIN A' resolves to '${final:-<none>}', expected '$IP'" >&2
    exit 1
fi
echo "✓ Verified: $DOMAIN → $IP via @$DNS_NS"
