#!/usr/bin/env bash
# scripts/oidc/setup.sh — bring up the Kanidm half of the #1911 acceptance
# lab, then provision exactly what the round trip needs.
#
# Produces, under ./data (gitignored, throwaway):
#   ca.pem  key.pem  chain.pem     lab CA + server leaf (CN=localhost)
#   client_secret                  the "grappa" OAuth2 client basic secret
#   e2eci.totp.json                the person's TOTP secret
#   lab.env                        user/password pairs for the caller
#
# Every credential here guards a container that lives for one CI run on an
# ephemeral runner. They are constants, not secrets: rotating them buys
# nothing, and visible literals keep the flow reproducible by hand.
#
# Idempotence: TLS material is generated only when absent, the OAuth2 client
# only when missing, and the person only when Kanidm answers `null` for the
# name. A second run against a live lab converges instead of failing.
set -euo pipefail
cd "$(dirname "$0")"

# Digest-pinned on #103 terms; the tag stays for readability.
#   Refresh: docker buildx imagetools inspect kanidm/tools:1.11.1 \
#     --format '{{.Manifest.Digest}}'
TOOLS_IMAGE=kanidm/tools:1.11.1@sha256:1ba11619dcd99804ec80342166e87337db8c934497bb2fae32bfc689dc1c80b2

URL=https://localhost:8443
KUSER=e2eci
KPASS=e2e-acceptance-pass
GRAPPA_USER=e2eci
GRAPPA_PASS=e2e-acceptance-pass

# 1. local CA + server certificate (CN=localhost, SAN localhost/127.0.0.1)
#    Any missing piece regenerates the whole set: compose auto-creates a
#    missing bind source as a directory, and kanidmd then dies reading
#    /certs/chain.pem ("Failed to start server core!").
if [ ! -f data/ca.pem ] || [ ! -f data/ca.key.pem ] || \
   [ ! -f data/key.pem ] || [ ! -f data/chain.pem ]; then
    mkdir -p data
    openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
        -keyout data/ca.key.pem -out data/ca.pem -subj "/CN=Grappa OIDC Lab CA" 2>/dev/null
    openssl genrsa -out data/key.pem 2048 2>/dev/null
    openssl req -new -key data/key.pem -subj "/CN=localhost" -out /tmp/oidc-lab.csr 2>/dev/null
    printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > /tmp/oidc-lab-ext.cnf
    openssl x509 -req -sha256 -days 825 -in /tmp/oidc-lab.csr -CA data/ca.pem \
        -CAkey data/ca.key.pem -CAcreateserial -out /tmp/oidc-lab-leaf.pem -extfile /tmp/oidc-lab-ext.cnf 2>/dev/null
    cat /tmp/oidc-lab-leaf.pem data/ca.pem > data/chain.pem
    rm -f /tmp/oidc-lab.csr /tmp/oidc-lab-leaf.pem /tmp/oidc-lab-ext.cnf
fi

# 2. start the server; a fresh volume needs a chown for the unprivileged uid
# (compose derives the volume name from this directory: scripts/oidc ->
# project "oidc")
mkdir -p client
docker compose up -d
docker run --rm -v oidc_kanidm-data:/data busybox chown 1000:100 /data \
    || docker compose run --rm --no-deps --user 0 kanidm /bin/sh -c 'chown 1000:100 /data'
docker compose restart >/dev/null

# 3. wait for the HTTPS API. /v1/self answers 401 to an anonymous probe:
# any HTTP answer means "up" — curl -f would turn the 401 into a false
# "did not come up" against a healthy server (measured on 1.11.1)
for _ in $(seq 1 45); do
    curl -s --cacert data/ca.pem -o /dev/null "$URL/v1/self" && break
    sleep 2
done
curl -s --cacert data/ca.pem -o /dev/null "$URL/v1/self" \
    || { echo "kanidm did not come up on $URL"; exit 1; }

# kanidm CLI runner. KANIDM_URL/KANIDM_CA_PATH envs, NOT a config file: the
# env route resolves the token cache by URL, while the config-file route
# looked the same and silently missed it (measured on tools 1.11.1 — every
# command fell through to an interactive password prompt).
krun() {
    docker run --rm --network host --user "$(id -u):$(id -g)" \
        -e HOME=/cfg -e KANIDM_URL="$URL" -e KANIDM_CA_PATH=/certs/ca.pem \
        -e KANIDM_PASSWORD -v "$PWD/client:/cfg" \
        -v "$PWD/data/ca.pem:/certs/ca.pem:ro" \
        "$TOOLS_IMAGE" kanidm "$@"
}

# 4. recovery passwords for the two built-in admins (valid 24 h), then CLI
# login — the REST bearer below comes from this cache
for acct in admin idm_admin; do
    PW="$(docker compose exec kanidm /sbin/kanidmd recover-account -c /etc/kanidm/server.toml "$acct" 2>&1 \
        | grep -oE '[0-9a-z]{48}' | head -1)"
    [ -n "$PW" ] || { echo "no recovery password for $acct"; exit 1; }
    KANIDM_PASSWORD="$PW" krun login -D "$acct" >/dev/null
done

get_token() {
    python3 - "$1" <<'EOF'
import json, sys
tokens = json.load(open("client/.cache/kanidm_tokens"))["instances"][""]["tokens"]
print(tokens[f"{sys.argv[1]}@localhost"])
EOF
}

# 5. the "grappa" OAuth2 client. The live-lab shape, exactly: landing is the
# app root, the redirect URL is the origin entry strict mode matches on, and
# idm_all_persons carries the three scopes runtime.exs asks for by default.
if ! krun system oauth2 get grappa --name idm_admin >/dev/null 2>&1; then
    krun system oauth2 create grappa "Grappa IRC" http://localhost:4000/ --name idm_admin >/dev/null
    krun system oauth2 add-redirect-url grappa http://localhost:4000/auth/oidc/callback --name idm_admin >/dev/null
    krun system oauth2 update-scope-map grappa idm_all_persons openid profile email --name idm_admin >/dev/null
fi
krun system oauth2 show-basic-secret grappa --name idm_admin 2>/dev/null \
    | tr -d '\r\n' > data/client_secret
[ -s data/client_secret ] || { echo "no basic secret for client grappa"; exit 1; }
chmod 600 data/client_secret

# 6. a person with password + TOTP credentials through the public REST API.
# Kanidm 1.11 requires MFA on person credentials by default, so the script
# also enrolls a TOTP and stores its secret for flow.sh.
AUTH="Authorization: Bearer $(get_token idm_admin)"
CURL="curl -sf --cacert data/ca.pem"

if [ "$($CURL -H "$AUTH" "$URL/v1/person/$KUSER")" = "null" ]; then
    krun person create "$KUSER" "E2E CI" -D idm_admin >/dev/null
fi
if [ ! -f "data/$KUSER.totp.json" ]; then
    # single-use reset token (valid 1 h), exchanged for a credential-update
    # session
    TOKEN="$($CURL -X GET "$URL/v1/person/$KUSER/_credential/_update_intent/3600" -H "$AUTH" \
        | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["token"] if isinstance(d,dict) else d)')"
    CT="$($CURL -X POST "$URL/v1/credential/_exchange_intent" -H 'Content-Type: application/json' -d "\"$TOKEN\"" \
        | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["token"])')"

    # primary password. Success is the session-status JSON with
    # primary.type_ == "Password" (1.11 answers the status, not a bare
    # "Ok"); a policy rejection is HTTP 400 with "passwordquality" hints.
    # No -f here: it hides the 400 body, so a weak KPASS dies as a bare
    # exit 22 with no reason. Measured against the live 1.11 API.
    curl -s --cacert data/ca.pem -X POST "$URL/v1/credential/_update" \
        -H 'Content-Type: application/json' \
        -d "[{\"password\":\"$KPASS\"},{\"token\":\"$CT\"}]" \
        | python3 -c '
import json, sys
body = json.load(sys.stdin)
if not (isinstance(body, dict) and body.get("primary", {}).get("type_") == "Password"):
    sys.stderr.write("password rejected: %s\n" % json.dumps(body))
    sys.exit(1)'

    # TOTP: enroll, verify with a live code, commit
    $CURL -X POST "$URL/v1/credential/_update" -H 'Content-Type: application/json' \
        -d "[\"totpgenerate\",{\"token\":\"$CT\"}]" \
        | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["mfaregstate"]["TotpCheck"]))' > "data/$KUSER.totp.json"
    sleep 1  # let the TOTP time step move on
    CODE="$(python3 totp.py "data/$KUSER.totp.json")"
    $CURL -X POST "$URL/v1/credential/_update" -H 'Content-Type: application/json' \
        -d "[{\"totpverify\":[$CODE,\"grappa-oidc-lab\"]},{\"token\":\"$CT\"}]" >/dev/null
    $CURL -X POST "$URL/v1/credential/_commit" -H 'Content-Type: application/json' \
        -d "{\"token\":\"$CT\"}" >/dev/null
fi

# 7. hand the caller everything flow.sh and the workflow need
cat > data/lab.env <<EOF
KANIDM_USER=$KUSER
KANIDM_PASSWORD=$KPASS
GRAPPA_USER=$GRAPPA_USER
GRAPPA_PASSWORD=$GRAPPA_PASS
EOF
chmod 600 data/lab.env

echo "lab ready: $URL (client secret + TOTP + lab.env under data/)"
