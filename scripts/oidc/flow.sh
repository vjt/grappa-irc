#!/usr/bin/env bash
# scripts/oidc/flow.sh — the #1911 acceptance round trip: grappa against the
# Kanidm lab brought up by setup.sh, with curl in place of a browser.
#
#   1. grappa /auth/oidc/authorize -> Kanidm /ui/oauth2 (PKCE S256 + nonce)
#   2. Kanidm UI login wizard: username -> TOTP -> password
#   3. consent (first run only), then the callback lands the code on grappa
#   4. grappa exchanges the code and answers with a /login#oidc= fragment
# The default round trip LINKS the identity (POST /me/oidc/link). With
# "login" it drives the pure login door (GET /auth/oidc/authorize) and
# expects an OIDC-minted session bearer, proven on /me/oidc.
#
# Usage: flow.sh <kanidm-user> <kanidm-password> <grappa-bearer> [link|login]
# The grappa bearer comes from POST /auth/login (the password door); the
# account is operator-made (`mix grappa.create_user`) and linked on the
# first run — a provider assertion never conjures one.
set -euo pipefail
cd "$(dirname "$0")"

KUSER="${1:?kanidm username required}"
KPASS="${2:?kanidm password required}"
GTOK="${3:?grappa bearer required}"
MODE="${4:-link}"
URL="${KANIDM_URL:-https://localhost:8443}"
GRAPPA="${GRAPPA_URL:-http://localhost:4000}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" /tmp/kanidm-'"$KUSER"'-lastcode' EXIT
CURL="curl -sS --cacert data/ca.pem -b $TMP/jar -c $TMP/jar -m 20"

# 1. authorize URL from grappa (signed state + PKCE live server-side)
if [ "$MODE" = "login" ]; then
    $CURL -o /dev/null -D "$TMP/authz" "$GRAPPA/auth/oidc/authorize"
    AURL=$(grep -i '^location:' "$TMP/authz" | tr -d '\r' | cut -d' ' -f2)
else
    AURL=$($CURL -X POST "$GRAPPA/me/oidc/link" -H "Authorization: Bearer $GTOK" \
        -H 'Content-Type: application/json' -d '{}' \
        | python3 -c 'import json,sys;print(json.load(sys.stdin)["authorize_url"])')
fi
[ -n "$AURL" ] || { echo "no authorize_url from grappa"; exit 1; }

# 2. Kanidm UI wizard (state is carried by the cookie jar)
# --data-urlencode: -d sends the body raw, so a password with spaces (or any
# reserved byte) never reaches the wizard intact and the login dies silently
# at the pw step — every step of the wizard form-posts here.
$CURL -o /dev/null "$AURL"
$CURL -o /dev/null -X POST --data-urlencode "username=$KUSER" "$URL/ui/login/begin"
CODE="$(python3 totp.py "data/$KUSER.totp.json")"
LAST="/tmp/kanidm-$KUSER-lastcode"
if [ -f "$LAST" ] && [ "$(cat "$LAST")" = "$CODE" ]; then
    sleep "$(python3 -c 'import time; print(int(30 - time.time() % 30 + 1))')"
    CODE="$(python3 totp.py "data/$KUSER.totp.json")"
fi
echo "$CODE" > "$LAST"
$CURL -o /dev/null -X POST -d "totp=$CODE" "$URL/ui/login/totp"
$CURL -o /dev/null -X POST --data-urlencode "password=$KPASS" "$URL/ui/login/pw"

# 3. resume -> consent (first run) -> callback code -> grappa session
# fragment. ONE resume, headers and body together: the response deletes the
# o2-authreq session cookie, so a second fetch of the same step arrives
# session-less and renders the login page instead of the consent form.
# `set -e` kills the script inside a failing command substitution (grep with
# no match), so every header-scrape that legitimately finds nothing when the
# consent page shows up must be `|| true`-guarded — the [ -n "$CB" ] check
# below is the intended failure point, not a silent early exit.
$CURL -D "$TMP/resume" -o "$TMP/resume-body" "$URL/ui/oauth2/resume"
CB=$(grep -i '^location' "$TMP/resume" | tr -d '\r' | cut -d' ' -f2 || true)
if [ -z "$CB" ]; then  # consent page: submit its token, then take the new code
    CT=$(grep -oE 'name="consent_token"[^>]*value="[^"]*"' "$TMP/resume-body" | grep -oE 'value="[^"]*"' | cut -d'"' -f2 || true)
    $CURL -o /dev/null -D "$TMP/consent-post" -X POST -d "consent_token=$CT" "$URL/ui/oauth2/consent"
    CB=$(grep -i '^location:' "$TMP/consent-post" | tr -d '\r' | cut -d' ' -f2 || true)
fi
[ -n "$CB" ] || { echo "no callback URL from Kanidm"; exit 1; }

# 4. grappa callback: code+verifier exchange, ID token validation, link/login
$CURL -o /dev/null -D "$TMP/callback" "$CB"
FRAG=$(grep -i '^location:' "$TMP/callback" | tr -d '\r' | awk '{print $2}' | sed 's|^/login#oidc=||' || true)
DECODED=$(echo "$FRAG" | python3 -c "import base64,json,sys;p=sys.stdin.read().strip();p+='='*(-len(p)%4);print(json.dumps(json.loads(base64.urlsafe_b64decode(p))))" 2>/dev/null || echo '{}')
KIND=$(echo "$DECODED" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("kind","undecodable"))')
CODE=$(echo "$DECODED" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("code",""))')
echo "round trip kind: $KIND ${CODE:+code=$CODE}"

if [ "$KIND" = "linked" ]; then
    echo "link ok for $KUSER"
    exit 0
fi
if [ "$KIND" = "error" ] && [ "$CODE" = "already_linked" ]; then
    echo "$KUSER already linked — link leg already proven; use \"login\" mode for the session round trip"
    exit 0
fi
[ "$KIND" = "session" ] || { echo "unexpected fragment: ${FRAG:0:120}"; exit 1; }
OTOK=$(echo "$DECODED" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
$CURL "$GRAPPA/me/oidc" -H "Authorization: Bearer $OTOK" | grep -q '"identity"' \
    && echo "login ok: OIDC-minted bearer answered /me/oidc" \
    || { echo "OIDC bearer rejected"; exit 1; }
