#!/usr/bin/env bash
# OIDC acceptance suite (#1911): boots a real Kanidm beside a MIX_ENV=prod
# grappa (infra/oidc-e2e/compose.yaml, HOST network) and drives BOTH legs of
# the authorization-code round trip with curl — no browser, no mocks:
#
#   link   POST /me/oidc/link on a password-door bearer -> Kanidm UI login
#          wizard (username -> TOTP -> password) -> consent -> callback ->
#          /login#oidc= {"kind":"linked"}
#   login  GET /auth/oidc/authorize -> same wizard -> callback ->
#          /login#oidc= {"kind":"session"} -> the minted bearer answers
#          GET /me/oidc
#   gate   #1911c doors, on persons the password door never saw: an
#          unlinked member of grappa_users provisions a passwordless
#          account on first login ({"kind":"session"}; /me/oidc shows the
#          identity; /admin/me stays 403), joining grappa_admins flips
#          is_admin on the NEXT login (/admin/me 200 — the sync leg), a
#          person in NEITHER group is refused with
#          {"kind":"error","code":"not_linked"}, and the LAST admin
#          leaving the group still logs in ({"kind":"session"}, flag
#          retained with a warning — the guard must not take the whole
#          OIDC door down with it)
#   raw    the script itself is the relying party, on a second OAuth2
#          client (e2e-raw): discovery shape, a hand-built PKCE S256
#          authorize, an ES256 id_token whose signature is checked against
#          the published JWKS (openssl, no grappa code in the path),
#          nonce/iss/aud/groups claims, userinfo sub == id_token sub,
#          an unregistered redirect_uri refused, the token endpoint
#          refusing a wrong client secret, and a stolen code refused
#          (wrong PKCE verifier)
#   hard   grappa's own door: a callback with a bogus state gets
#          {"kind":"error","code":"invalid_state"}, replaying a CONSUMED
#          callback URL mints no second session, and a garbage bearer is
#          401 on /me/oidc; the link door is idempotent (a second link
#          round trip answers already_linked), and leaving grappa_admins
#          closes the admin door again on the next login (the sync leg
#          runs in both directions — docs/oidc-kanidm.md §3)
#
# This is the acceptance pass the #1911 commit owed ("verified against the
# shape, not against a live provider"): the Bypass-driven controller tests
# prove grappa's half of the protocol; only a real provider proves discovery
# parsing, PKCE S256 acceptance, ES256 id_token validation and consent
# handling against something grappa does not control.
#
# Everything the stack needs is generated per run: the CA + server cert, the
# Kanidm admin recovery + CLI logins, the person (password + TOTP — Kanidm
# 1.11 requires MFA on person credentials by default), the OAuth2 client, and
# every prod secret grappa requires. Nothing secret is committed; rerunning
# is from scratch (compose down -v) and must stay green.
#
# Ports: CI owns 8443/4000 free and clear. A dev host usually does not —
# the lab's Kanidm holds 8443 and the dev stack's grappa holds 4000, and
# with host networking a second bind dies at AddrInUse. When a default is
# busy the script walks up to the first free port on its own; an explicit
# override still wins unchanged:
#
#   OIDC_E2E_KANIDM_PORT=8444 OIDC_E2E_GRAPPA_PORT=4010 scripts/oidc-e2e.sh
#
# The Kanidm cert is issued for DNS "localhost" (SAN localhost/127.0.0.1),
# which is port-agnostic — the issuer URL is rebuilt from the chosen port.
#
# `scripts/oidc-e2e.sh --logs` prints the stack's container logs and exits:
# the CI failure step uses it instead of raw `docker compose logs`.
#
# Local state lands in infra/oidc-e2e/runtime/ (gitignored): TLS material,
# server.toml, CLI token cache, TOTP secret, the generated grappa.env.
set -euo pipefail

cd "$(dirname "$0")/.."
E2E=infra/oidc-e2e
# Both anchored absolute: the script cds INTO $E2E below, where relative
# paths (an $E2E-relative RUNTIME, a dirname-$0-relative generator call)
# resolve one level too deep.
ROOT=$PWD
RUNTIME=$ROOT/$E2E/runtime
# Absolute compose path: the EXIT trap runs with cwd inside $E2E, where a
# relative path would resolve one level too deep.
COMPOSE="docker compose -f $PWD/$E2E/compose.yaml"
PROJECT=grappa-oidc-e2e
# A busy default walks to the next free port (header note above): a bind
# failure on a taken port is a scheduling problem on the host, not an
# acceptance finding, and CI never shifts (its defaults are free).
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
pick_port() {  # $1 = preferred port; first free of $1..$1+20, else $1
    local p
    for p in $(seq "$1" $(("$1" + 20))); do
        port_busy "$p" || { echo "$p"; return; }
    done
    echo "$1"
}
if [ -n "${OIDC_E2E_KANIDM_PORT:-}" ]; then
    KPORT=$OIDC_E2E_KANIDM_PORT
else
    KPORT=$(pick_port 8443)
    [ "$KPORT" = 8443 ] || echo "oidc-e2e: 8443 busy — Kanidm on $KPORT" >&2
fi
if [ -n "${OIDC_E2E_GRAPPA_PORT:-}" ]; then
    GPORT=$OIDC_E2E_GRAPPA_PORT
else
    GPORT=$(pick_port 4000)
    [ "$GPORT" = 4000 ] || echo "oidc-e2e: 4000 busy — grappa on $GPORT" >&2
fi
# CLI twin of the server image pinned in the compose file; they MUST move
# together (same Kanidm release).
KANIDM_TOOLS="kanidm/tools@sha256:1ba11619dcd99804ec80342166e87337db8c934497bb2fae32bfc689dc1c80b2"
URL="https://localhost:$KPORT"
GRAPPA="http://localhost:$GPORT"
# Test identities. The Kanidm person and the grappa account need NOT share a
# name — the link binds the provider's `sub` to whatever account holds the
# bearer — but keeping them distinct proves it. NEWUSER/OUTUSER exist for
# the #1911c gate legs: nobody links them and no password door ever saw
# them, so the group claim is the ONLY thing that can speak for them.
KUSER=oidc-person
NEWUSER=oidc-newcomer
OUTUSER=oidc-outsider
UGROUP=grappa_users
AGROUP=grappa_admins
KPASS='KanidmAcceptance!2026'
GUSER=oidc-ci
GPASS='GrappaAcceptance!2026'
CONTAINER_UID="$(id -u)"
CONTAINER_GID="$(id -g)"
export CONTAINER_UID CONTAINER_GID

mkdir -p "$RUNTIME"
# Placeholder before the first compose call: the grappa service's env_file
# must EXIST for compose to resolve the model, even for commands that only
# touch kanidm. The real contents are generated once the client secret is
# known, later in this run.
: > "$RUNTIME/grappa.env"
cd "$E2E"

if [ "${1:-}" = "--logs" ]; then
    $COMPOSE logs --tail 300
    exit 0
fi

die() { echo "oidc-e2e: $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }

# The EXIT trap tears the stack down INCLUDING volumes — a rerun must not
# inherit a half-configured Kanidm (the person/client creation below is
# idempotent in shape, but a stale volume with a stale client secret would
# silently diverge from the freshly generated grappa.env).
cleanup() {
    rc=$?
    if [ "$rc" -ne 0 ]; then
        echo >&2
        echo "oidc-e2e: FAILED (rc=$rc) — dumping container logs:" >&2
        $COMPOSE logs --tail 200 >&2 || true
    fi
    $COMPOSE down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
step "TLS material (CA + localhost server cert)"
# Same shape as scripts/setup.sh in the Kanidm lab: a throwaway CA and a
# leaf for DNS localhost / IP 127.0.0.1. grappa trusts the CA via the
# merged-bundle compose mount (below); curl via --cacert.
if [ ! -f runtime/ca.pem ]; then
    openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
        -keyout runtime/ca.key.pem -out runtime/ca.pem \
        -subj "/CN=grappa OIDC acceptance CA" 2>/dev/null
    openssl genrsa -out runtime/key.pem 2048 2>/dev/null
    openssl req -new -key runtime/key.pem -subj "/CN=localhost" \
        -out /tmp/oidc-e2e.csr 2>/dev/null
    printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
        > /tmp/oidc-e2e-ext.cnf
    openssl x509 -req -sha256 -days 825 -in /tmp/oidc-e2e.csr \
        -CA runtime/ca.pem -CAkey runtime/ca.key.pem -CAcreateserial \
        -out /tmp/oidc-e2e-leaf.pem -extfile /tmp/oidc-e2e-ext.cnf 2>/dev/null
    cat /tmp/oidc-e2e-leaf.pem runtime/ca.pem > runtime/chain.pem
    rm -f /tmp/oidc-e2e.csr /tmp/oidc-e2e-leaf.pem /tmp/oidc-e2e-ext.cnf
fi

# The trust bundle grappa mounts over /etc/ssl/certs/ca-certificates.crt is
# the IMAGE's own public CAs + this run's acceptance CA — same shape as
# cicchetto/e2e/oidc-certs/gen-certs.sh. A bare ca.pem there would arm the
# OIDC verify path and DISARM everything else in the same mount: the boot
# chain's `mix local.hex` + `mix deps.get` dial builds.hex.pm over httpc,
# which reads the same file, and a bundle without the public CAs fails the
# FIRST cold run with a TLS "unknown CA" — on the GitHub runner exactly as
# on a dev host. Rebuilt every run (one `docker run cat`, no network) so a
# refreshed base image can never leave a stale bundle behind.
$COMPOSE build grappa >/dev/null
docker run --rm --entrypoint /bin/cat grappa:oidc-e2e \
    /etc/ssl/certs/ca-certificates.crt > runtime/system-ca.pem
cat runtime/system-ca.pem runtime/ca.pem > runtime/ca-bundle.crt

# server.toml is rendered per run: bindaddress/origin carry $KPORT, and
# LDAPS is deliberately absent (nothing in the flow reads LDAP).
cat > runtime/server.toml <<EOF
bindaddress = "0.0.0.0:$KPORT"
db_path = "/data/kanidm.db"
tls_chain = "/certs/chain.pem"
tls_key = "/certs/key.pem"
domain = "localhost"
origin = "$URL"
EOF

# CLI config: token cache lives under runtime/client too, so reruns never
# reuse a stale admin session. The cache and the per-run secrets are wiped
# here because a failed run leaves them behind — CI starts from a fresh
# checkout, a dev host does not.
mkdir -p runtime/client/.config
rm -rf runtime/client/.cache runtime/*.totp.json runtime/last-totp
printf 'uri = "%s"\nca_path = "/certs/ca.pem"\n' "$URL" > runtime/client/.config/kanidm

# curl against the acceptance CA; -f so a 4xx/5xx body fails the step.
KURL="curl -sf --cacert runtime/ca.pem"

# Kanidm CLI: tools container on the host network (server is host-bound),
# unprivileged, HOME inside the mounted client dir. KANIDM_PASSWORD goes in
# ONLY when set: the CLI maps it onto clap's --password, and an EMPTY value
# reads as "supplied without a value" — every passwordless command (person
# create, oauth2 create) aborts in arg parsing with "a value is required
# for '--password'". Measured on the 1.11.1 tools image.
kcli() {
    local pw_env=()
    if [ -n "${KANIDM_PASSWORD:-}" ]; then
        pw_env=(-e KANIDM_PASSWORD="$KANIDM_PASSWORD")
    fi
    docker run --rm --network host --user "$(id -u):$(id -g)" \
        -e HOME=/cfg "${pw_env[@]}" \
        -v "$PWD/runtime/client:/cfg" \
        -v "$PWD/runtime/ca.pem:/certs/ca.pem:ro" \
        "$KANIDM_TOOLS" kanidm "$@"
}

# bearer token of a CLI-logged-in account (lib.sh twin of the lab)
token() {
    python3 - "$1" <<'PYEOF'
import json, sys
cache = json.load(open("runtime/client/.cache/kanidm_tokens"))
print(cache["instances"][""]["tokens"][sys.argv[1] + "@localhost"])
PYEOF
}

# current TOTP code from the enrolled secret. Byte-for-byte the logic of the
# lab's scripts/totp.py: Kanidm 1.11's TotpCheck secret is a RAW BYTE ARRAY
# (not base32 text) and the algo/steps/digits come from the JSON — the
# enrollment above mints sha256, so a hardcoded sha1 computes codes the
# wizard leg would reject.
totp() {  # $1 = the person's totp json under runtime/
    python3 - "$1" <<'PYEOF'
import hashlib, hmac, json, struct, sys, time
totp = json.load(open(sys.argv[1]))
if isinstance(totp, list):  # tolerate the raw byte-array form
    totp = {"secret": totp, "algo": "sha256", "step": 30, "digits": 6}
key = bytes(totp["secret"])
step = totp.get("step", 30)
digits = totp.get("digits", 6)
algo = {"sha1": hashlib.sha1, "sha256": hashlib.sha256,
        "sha512": hashlib.sha512}[totp.get("algo", "sha256").lower()]
mac = hmac.new(key, struct.pack(">Q", int(time.time() // step)), algo).digest()
offset = mac[-1] & 0x0F
code = (struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
print(str(code).zfill(digits))
PYEOF
}

# ---------------------------------------------------------------------------
step "Kanidm up"
# Any leftover stack from an interrupted run owns the fixed container names
# and the ports; clear it first so THIS run starts from scratch.
$COMPOSE down -v >/dev/null 2>&1 || true
$COMPOSE up -d --wait kanidm || true   # first boot may healthcheck-fail on a fresh volume
# chown to the invoking ids, matching the service user: the volume must be
# writable by the same uid that must read the 0600 key.pem (CI runners are
# uid 1001, not 1000 — a hardcoded 1000:100 leaves both unwritable there).
docker run --rm -v "${PROJECT}_kanidm-data:/data" busybox \
    chown "$CONTAINER_UID:$CONTAINER_GID" /data
$COMPOSE restart kanidm >/dev/null
for _ in $(seq 1 45); do
    curl -s --cacert runtime/ca.pem -o /dev/null "$URL/v1/self" && break
    sleep 2
done
curl -s --cacert runtime/ca.pem -o /dev/null "$URL/v1/self" \
    || die "Kanidm API never came up on $URL"

step "admin recovery + CLI logins"
for acct in admin idm_admin; do
    # || true: a failing docker exec or an empty grep kills the script
    # SILENTLY under set -euo pipefail (the assignment adopts the
    # pipeline's rc) — the [ -n "$PW" ] die below is the intended,
    # loud failure point. Same guard as callback()'s scrapes.
    PW=$(docker exec grappa-oidc-kanidm /sbin/kanidmd recover-account \
        -c /etc/kanidm/server.toml "$acct" 2>&1 | grep -oE '[0-9a-z]{48}' | head -1 || true)
    [ -n "$PW" ] || die "no recovery password for $acct"
    KANIDM_PASSWORD="$PW" kcli login -D "$acct" >/dev/null 2>&1 \
        || die "CLI login failed for $acct"
done

step "persons (password + TOTP)"
# REST port of the lab's create-user.sh. Kanidm 1.11 requires MFA on person
# credentials by default, so the TOTP enrollment is not optional — and the
# login wizard legs below exercise it for real. One maker for every person:
# the gate legs need identities that exist ONLY on the provider side.
AUTH="Authorization: Bearer $(token idm_admin)"
make_person() {  # $1 = person name; leaves runtime/$1.totp.json enrolled
    local p="$1"
    if [ "$($KURL -H "$AUTH" "$URL/v1/person/$p")" = "null" ]; then
        kcli person create "$p" "OIDC Acceptance Person" -D idm_admin >/dev/null
    fi
    ITOKEN="$($KURL -X GET -H "$AUTH" "$URL/v1/person/$p/_credential/_update_intent/3600" \
        | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["token"] if isinstance(d,dict) else d)')"
    CT="$($KURL -X POST "$URL/v1/credential/_exchange_intent" -H 'Content-Type: application/json' \
        -d "\"$ITOKEN\"" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["token"])')"

    $KURL -X POST "$URL/v1/credential/_update" -H 'Content-Type: application/json' \
        -d "[{\"password\":\"$KPASS\"},{\"token\":\"$CT\"}]" >/dev/null
    $KURL -X POST "$URL/v1/credential/_update" -H 'Content-Type: application/json' \
        -d "[\"totpgenerate\",{\"token\":\"$CT\"}]" \
        | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["mfaregstate"]["TotpCheck"]))' \
        > "runtime/$p.totp.json"
    # verify with a live code, then commit. One second of slack first, exactly
    # like the lab's create-user.sh: the code is computed for the CURRENT step,
    # and the verify must not race the very edge of one. The code goes in as a
    # JSON NUMBER — the API's CURequest wants a u32, and a quoted code dies in
    # deserialization with a 500 (measured, 1.11.1).
    sleep 1
    VC="$(totp "runtime/$p.totp.json")"
    # JSON numbers carry no leading zeros: a code like 051730 must cross the
    # wire as 51730 or the body is not valid JSON (measured — curl -f rc=22,
    # and the same latent flake sits in the lab's create-user.sh, which got
    # lucky on every code without a leading zero). The wizard leg below keeps
    # the ZERO-PADDED string: that one is a form field, not JSON.
    VCN=$((10#$VC))
    $KURL -X POST "$URL/v1/credential/_update" -H 'Content-Type: application/json' \
        -d "[{\"totpverify\":[${VCN},\"oidc-e2e\"]},{\"token\":\"$CT\"}]" >/dev/null
    $KURL -X POST "$URL/v1/credential/_commit" -H 'Content-Type: application/json' \
        -d "{\"token\":\"$CT\"}" >/dev/null
}
make_person "$KUSER"
# The gate persons exist NOW, before the groups reference them: Kanidm's
# referential integrity 500s on a member uuid it cannot resolve, and the
# outsider must exist before it can be left out of everything.
make_person "$NEWUSER"
make_person "$OUTUSER"

step "OAuth2 client 'grappa' (confidential, PKCE, openid profile email groups)"
# Confidential + default PKCE matches grappa's posture (client secret at the
# token endpoint, S256 challenge). Scope map on idm_all_persons so every
# person can consent — the acceptance person is in no custom group.
# `groups` rides the SAME map: Kanidm only puts the claim in the token when
# the scope is granted, and the #1911c gate legs below read nothing else.
# -D idm_admin, NOT admin: OAuth2 resource servers are IDM entries, and the
# domain admin gets a bare 403 AccessDenied on create (measured, 1.11.1).
kcli system oauth2 create grappa "Grappa (OIDC acceptance)" \
    "http://localhost:$GPORT/auth/oidc/callback" -D idm_admin >/dev/null
kcli system oauth2 update-scope-map grappa idm_all_persons openid profile email groups \
    -D idm_admin >/dev/null
CSECRET="$(kcli system oauth2 show-basic-secret grappa -D idm_admin 2>/dev/null \
    | grep -oE '[0-9a-z]{48}' | head -1)"
[ -n "$CSECRET" ] || die "no client secret from Kanidm"

# The RAW leg's client: same posture as grappa's (confidential, PKCE,
# openid profile email groups), but the script holds the secret and IS
# the relying party — a provider-side break cannot hide behind grappa's
# own verify path.
kcli system oauth2 create e2e-raw "e2e raw relying party" \
    "http://localhost:$GPORT/e2e-raw-callback" -D idm_admin >/dev/null
kcli system oauth2 update-scope-map e2e-raw idm_all_persons openid profile email groups \
    -D idm_admin >/dev/null
RSECRET="$(kcli system oauth2 show-basic-secret e2e-raw -D idm_admin 2>/dev/null \
    | grep -oE '[0-9a-z]{48}' | head -1)"
[ -n "$RSECRET" ] || die "no e2e-raw secret from Kanidm"

step "gate groups $UGROUP + $AGROUP (#1911c)"
# Membership is the whole gate: grappa's group_member?/2 matches the bare
# env name against the claim's spn (grappa_users@localhost), so the names
# here are bare. KUSER is a member WITH a pre-linked account — the sync
# leg, not provisioning, must answer its login. NEWUSER joins below, at
# the moment the admin-flip leg needs it; OUTUSER never joins either.
kcli group create "$UGROUP" -D idm_admin >/dev/null
kcli group create "$AGROUP" -D idm_admin >/dev/null
kcli group add-members "$UGROUP" "$KUSER" "$NEWUSER" -D idm_admin >/dev/null

step "grappa up (MIX_ENV=prod)"
# Non-secret wiring + the per-run OAuth2 client secret first; then the ONE
# secret generator fills every runtime.exs secret into the same file. Run 8
# of the rehearsal is why: the hand-rolled list forgot the VAPID pair and
# grappa refused to boot — a hand-maintained list is a bug farm the moment
# runtime.exs grows its next required secret, while gen-secrets.sh owns the
# full set in the same byte shapes the packaged paths use (fourth consumer,
# after postinstall / release-entrypoint / deploy.sh). 0600 like the
# release container's own first-boot run of it.
{
    echo "PORT=$GPORT"
    echo "PHX_HOST=localhost"
    echo "GRAPPA_CAPTCHA_PROVIDER=disabled"
    echo "GRAPPA_OIDC_ISSUER=$URL/oauth2/openid/grappa"
    echo "GRAPPA_OIDC_CLIENT_ID=grappa"
    echo "GRAPPA_OIDC_CLIENT_SECRET=$CSECRET"
    echo "GRAPPA_OIDC_REDIRECT_URI=http://localhost:$GPORT/auth/oidc/callback"
    echo "GRAPPA_OIDC_SCOPES=openid profile email groups"
    echo "GRAPPA_OIDC_USERS_GROUP=$UGROUP"
    echo "GRAPPA_OIDC_ADMINS_GROUP=$AGROUP"
} > "$RUNTIME/grappa.env"
GRAPPA_ENV_FILE="$RUNTIME/grappa.env" GRAPPA_ENV_MODE=0600 \
    "$ROOT/infra/packaging/gen-secrets.sh" >/dev/null
# Cold run compiles deps+app into the bind-mounted tree (docker on a 9p
# checkout is slow; CI's local disk is not) — several minutes either way.
# grappa-runtime gets the same one-shot chown kanidm-data gets above: a
# fresh named volume is root-owned and the unprivileged container user
# cannot create the sqlite DB in it (run 11's database_open_failed).
docker run --rm -v "${PROJECT}_grappa-runtime:/data" \
    busybox chown "$CONTAINER_UID:$CONTAINER_GID" /data
$COMPOSE up -d --build grappa
for _ in $(seq 1 240); do
    curl -sf -o /dev/null "$GRAPPA/healthz" && break
    sleep 5
done
curl -sf -o /dev/null "$GRAPPA/healthz" || die "grappa never became healthy on $GRAPPA"

step "grappa account $GUSER + password-door bearer"
# --admin: the de-flip legs demote $NEWUSER out of $AGROUP, and the
# last-admin guard refuses to demote the ONLY admin — with a lone
# non-admin operator account the post-removal login would hit the
# retention path instead of the sync it exists to prove. A real
# deployment keeps a password-door admin exactly for this.
$COMPOSE exec -T grappa mix grappa.create_user --name "$GUSER" --password "$GPASS" --admin >/dev/null
GTOK="$($KURL -X POST "$GRAPPA/auth/login" -H 'Content-Type: application/json' \
    -d "{\"identifier\":\"$GUSER\",\"password\":\"$GPASS\"}" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
[ -n "$GTOK" ] || die "no bearer from /auth/login"

# ---------------------------------------------------------------------------
step "round trip: LINK leg (bearer-authenticated /me/oidc/link)"
# Port of the lab's oidc-flow.sh. The consent page appears on the FIRST
# authorization only, so the link leg handles it and the login leg must not
# need to.
FLOW="curl -sS --cacert runtime/ca.pem -m 20"

# One cookie jar carries the Kanidm session from the wizard into the
# resume/consent exchange; a FRESH jar per leg, or the second leg's login
# POSTs answer on a session that is already authenticated and stall.
new_jar() {
    KJ=$(mktemp)
    FLOW="curl -sS --cacert runtime/ca.pem -b $KJ -c $KJ -m 20"
}

wizard() {  # $1 = person name, $2 = authorize URL to enter the wizard with
    $FLOW -o /dev/null "$2"
    $FLOW -o /dev/null -X POST -d "username=$1" "$URL/ui/login/begin"
    # TOTP: never reuse a code across 30s steps (Kanidm rejects replays and
    # the enrollment verify may have consumed this step's).
    CODE="$(totp "runtime/$1.totp.json")"
    LAST=runtime/last-totp
    if [ -f "$LAST" ] && [ "$(cat "$LAST")" = "$CODE" ]; then
        sleep "$(python3 -c 'import time; print(int(30 - time.time() % 30 + 1))')"
        CODE="$(totp "runtime/$1.totp.json")"
    fi
    echo "$CODE" > "$LAST"
    $FLOW -o /dev/null -X POST -d "totp=$CODE" "$URL/ui/login/totp"
    $FLOW -o /dev/null -X POST -d "password=$KPASS" "$URL/ui/login/pw"
}

callback() {  # resume -> consent (if first auth) -> callback URL; prints it
    # One GET only: Kanidm advances its flow state on /resume, so a second
    # fetch to scrape the consent form answers Error and the consent_token
    # grep reads an error page — the body captured here IS the consent form
    # whenever there is no Location header. And `set -e` kills the script
    # inside a FAILING command substitution (a grep that legitimately finds
    # nothing the moment the consent page shows up), so every scrape below
    # is `|| true`-guarded — the [ -n "$CB" ] die is the intended failure
    # point, not a silent early exit. Same three deaths as the lab's
    # oidc-flow.sh, fixed there in fa7cd68; ported so the suite stops dying
    # at the first-run consent of every person the password door never saw.
    $FLOW -o runtime/resume -D runtime/hdr-resume "$URL/ui/oauth2/resume"
    CB=$(grep -i '^location' runtime/hdr-resume | tr -d '\r' | cut -d ' ' -f2 || true)
    if [ -z "$CB" ]; then
        CT=$(grep -oE 'name="consent_token"[^>]*value="[^"]*"' runtime/resume \
            | grep -oE 'value="[^"]*"' | cut -d'"' -f2 || true)
        $FLOW -o /dev/null -D runtime/hdr-consent \
            -X POST -d "consent_token=$CT" "$URL/ui/oauth2/consent"
        CB=$(grep -i '^location' runtime/hdr-consent | tr -d '\r' | cut -d ' ' -f2 || true)
    fi
    [ -n "$CB" ] || die "no callback URL from Kanidm"
    echo "$CB"
}

# decoded /login#oidc= fragment field: $1 = key ("kind"/"code"/"token")
frag() {
    echo "$FRAG" | python3 -c "import base64,json,sys;p=sys.stdin.read().strip();p+='='*(-len(p)%4);print(json.loads(base64.urlsafe_b64decode(p)).get('$1',''))"
}

# one person's full login round trip: authorize -> wizard -> callback ->
# fragment in $FRAG. The consent page is handled inside callback(), so a
# person's FIRST authorization needs nothing extra here.
login_leg() {  # $1 = person name
    $FLOW -o /dev/null -D runtime/hdr-authz "$GRAPPA/auth/oidc/authorize"
    AURL=$(grep -i '^location:' runtime/hdr-authz | tr -d '\r' | cut -d ' ' -f2 || true)
    [ -n "$AURL" ] || die "no redirect from /auth/oidc/authorize"
    new_jar
    wizard "$1" "$AURL"
    CB="$(callback)"
    $FLOW -o /dev/null -D runtime/hdr-cb "$CB"
    FRAG=$(grep -i '^location' runtime/hdr-cb | tr -d '\r' | awk '{print $2}' | sed 's|^/login#oidc=||' || true)
}

AURL="$($KURL -X POST "$GRAPPA/me/oidc/link" \
    -H "Authorization: Bearer $GTOK" -H 'Content-Type: application/json' -d '{}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["authorize_url"])')"
[ -n "$AURL" ] || die "no authorize_url from grappa"
new_jar
wizard "$KUSER" "$AURL"
CB="$(callback)"
$FLOW -o /dev/null -D runtime/hdr-cb "$CB"
FRAG=$(grep -i '^location' runtime/hdr-cb | tr -d '\r' | awk '{print $2}' | sed 's|^/login#oidc=||' || true)
[ "$(frag kind)" = "linked" ] \
    || die "link leg: unexpected fragment kind '$(frag kind)' (want linked)"

step "round trip: LOGIN leg (authorize -> session bearer -> /me/oidc)"
# KUSER is linked AND a member of $UGROUP — the linked account answers,
# proving the sync leg does not fork a second account for a member.
login_leg "$KUSER"
[ "$(frag kind)" = "session" ] \
    || die "login leg: unexpected fragment kind '$(frag kind)' (want session)"
OTOK="$(frag token)"
[ -n "$OTOK" ] || die "login leg: no token in fragment"
$KURL "$GRAPPA/me/oidc" -H "Authorization: Bearer $OTOK" \
    | grep -q '"identity"' || die "OIDC-minted bearer rejected by /me/oidc"

# ---------------------------------------------------------------------------
step "round trip: GATE legs (#1911c — provision, admin flip, refusal)"
# NEWUSER: in $UGROUP, never linked, no grappa account exists for it — the
# ONLY thing that can admit it is the group claim. First login must
# provision a passwordless account and mint a working bearer; the admin
# door must stay shut until the admins group says otherwise.
login_leg "$NEWUSER"
[ "$(frag kind)" = "session" ] \
    || die "gate leg: newcomer not provisioned (kind '$(frag kind)', code '$(frag code)')"
NTOK="$(frag token)"
[ -n "$NTOK" ] || die "gate leg: no token in newcomer fragment"
$KURL "$GRAPPA/me/oidc" -H "Authorization: Bearer $NTOK" \
    | grep -q '"label"' || die "provisioned identity missing from /me/oidc"
NCODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $NTOK" "$GRAPPA/admin/me")
[ "$NCODE" = "403" ] \
    || die "gate leg: admin door answered $NCODE for a non-admin (want 403)"

# The provisioned account is passwordless BY DESIGN: the password door
# must refuse it (the nil-hash branch of verify_password/2) with a 401 —
# a 500 there is Argon2 crashing on a nil hash, the exact crash that
# branch exists to prevent.
PCODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GRAPPA/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"identifier\":\"$NEWUSER\",\"password\":\"no-local-password\"}")
[ "$PCODE" = "401" ] \
    || die "gate leg: password door answered $PCODE for a passwordless account (want 401)"

# Joining $AGROUP does nothing until the NEXT login: is_admin is synced on
# the login leg, not live from the claim — a bearer minted before the flip
# must have stayed non-admin, and the one minted after must open the door.
kcli group add-members "$AGROUP" "$NEWUSER" -D idm_admin >/dev/null \
    || die "gate leg: adding $NEWUSER to $AGROUP failed"
login_leg "$NEWUSER"
NTOK="$(frag token)"
[ -n "$NTOK" ] || die "gate leg: no token on the admin-flip login"
NCODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $NTOK" "$GRAPPA/admin/me")
[ "$NCODE" = "200" ] \
    || die "gate leg: admins group did not open the admin door ($NCODE)"

# OUTUSER: in neither group — the door refuses, by name, without charging
# anyone (log_refusal's no-attack branch).
login_leg "$OUTUSER"
[ "$(frag kind)" = "error" ] && [ "$(frag code)" = "not_linked" ] \
    || die "gate leg: outsider not refused (kind '$(frag kind)', code '$(frag code)')"

# ---------------------------------------------------------------------------
step "round trip: RAW leg (script as relying party on e2e-raw)"
# Everything so far consumed the provider through grappa's client. Here
# the script drives the SAME provider half with its own confidential
# client: discovery endpoints, a hand-built PKCE S256 authorization, and
# an id_token verified against the JWKS with openssl — so discovery
# parsing, ES256 signing and the claim contract are proven by something
# that shares zero code with grappa.
DISC="$($KURL "$URL/oauth2/openid/e2e-raw/.well-known/openid-configuration")"
echo "$DISC" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for k in ("issuer", "authorization_endpoint", "token_endpoint",
          "userinfo_endpoint", "jwks_uri"):
    assert d.get(k), "discovery missing " + k
print("discovery ok:", d["issuer"])'
echo "$DISC" | grep -q "\"issuer\":\"$URL/oauth2/openid/e2e-raw\"" \
    || die "raw leg: discovery issuer is not the client issuer path"
AUTHZ_EP=$(echo "$DISC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["authorization_endpoint"])')
TOK_EP=$(echo "$DISC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token_endpoint"])')
UI_EP=$(echo "$DISC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["userinfo_endpoint"])')
JKS_URI=$(echo "$DISC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["jwks_uri"])')
RAWREDIRECT="http://localhost:$GPORT/e2e-raw-callback"

# curl WITHOUT -f for the refusal legs: a 4xx IS the answer under test.
RAWCURL="curl -s --cacert runtime/ca.pem -m 20"

# own PKCE S256 material + nonce + state
read -r VERIFIER CHALLENGE RNONCE RSTATE <<<"$(python3 - <<'PY'
import base64, hashlib, secrets
v = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
c = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode()
print(v, c, secrets.token_hex(16), secrets.token_hex(16))
PY
)"
authz_url() {  # $1 = redirect_uri; prints the fully encoded authorize URL
    python3 - "$1" "$RSTATE" "$RNONCE" "$CHALLENGE" <<'PY'
import sys, urllib.parse as u
print(u.urlencode({
    "response_type": "code", "scope": "openid profile email groups",
    "client_id": "e2e-raw", "redirect_uri": sys.argv[1],
    "state": sys.argv[2], "nonce": sys.argv[3],
    "code_challenge": sys.argv[4], "code_challenge_method": "S256"}))
PY
}

# An unregistered redirect_uri must earn NO redirect carrying a code —
# checked first, cookie-less: this request never gets as far as a session.
$RAWCURL -o runtime/evil-body -D runtime/evil-hdr \
    "$AUTHZ_EP?$(authz_url "http://localhost:$GPORT/evil")"
if grep -i '^location' runtime/evil-hdr | grep -q 'code='; then
    die "raw leg: unregistered redirect_uri was granted a code"
fi
echo "unregistered redirect_uri refused (no code redirect)"

new_jar
wizard "$KUSER" "$AUTHZ_EP?$(authz_url "$RAWREDIRECT")"
RCB="$(callback)"
# The provider's redirect targets our OWN redirect uri, where nothing
# listens: parse the code+state out of the Location instead of fetching.
read -r RCODE RSTATE_BACK <<<"$(python3 - "$RCB" <<'PY'
import sys, urllib.parse as u
q = u.parse_qs(u.urlparse(sys.argv[1]).query)
print(q.get("code", [""])[0], q.get("state", [""])[0])
PY
)"
[ -n "$RCODE" ] || die "raw leg: no code in the callback redirect"
[ "$RSTATE_BACK" = "$RSTATE" ] || die "raw leg: state not echoed back"

# Wrong client secret at the token endpoint: no tokens, whatever the code.
BADTOK="$($RAWCURL -X POST "$TOK_EP" -u "e2e-raw:deliberately-wrong-secret" \
    -d "grant_type=authorization_code&code=$RCODE&redirect_uri=$RAWREDIRECT&code_verifier=$VERIFIER")"
if printf '%s' "$BADTOK" | grep -qE '"(access_token|id_token)"'; then
    die "raw leg: a wrong client secret exchanged tokens"
fi
echo "wrong client secret refused: $(printf '%s' "$BADTOK" | head -c 80)"

# The real exchange: Basic auth + PKCE verifier.
TOKS="$($KURL -X POST "$TOK_EP" -u "e2e-raw:$RSECRET" \
    -d "grant_type=authorization_code&code=$RCODE&redirect_uri=$RAWREDIRECT&code_verifier=$VERIFIER")"
IDTOK="$(printf '%s' "$TOKS" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id_token",""))')"
ACCTOK="$(printf '%s' "$TOKS" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("access_token",""))')"
[ -n "$IDTOK" ] && [ -n "$ACCTOK" ] || die "raw leg: token exchange returned no tokens"

# id_token verification, zero grappa code: ES256 signature against the
# published JWKS via openssl (JWK -> SPKI PEM + raw r||s -> DER in pure
# python DER, no third-party modules), then the claim contract.
$KURL "$JKS_URI" > runtime/jwks.json
printf '%s' "$IDTOK" > runtime/idtoken.jwt
JSUB="$(python3 - runtime/idtoken.jwt runtime/jwks.json "$URL/oauth2/openid/e2e-raw" <<'PY'
import base64, json, subprocess, sys, time

def b64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def der_len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b

def der(tag, body):
    return bytes([tag]) + der_len(len(body)) + body

def der_int(raw):
    i = int.from_bytes(raw, "big")
    b = i.to_bytes(max(1, (i.bit_length() + 7) // 8), "big")
    if b[0] & 0x80:
        b = b"\x00" + b
    return der(0x02, b)

jwt = open(sys.argv[1]).read().strip().split(".")
jwks = json.load(open(sys.argv[2]))
expected_iss = sys.argv[3]
hdr = json.loads(b64u(jwt[0]))
claims = json.loads(b64u(jwt[1]))
keys = [k for k in jwks.get("keys", []) if k.get("kty") == "EC" and k.get("crv") == "P-256"]
if hdr.get("kid"):
    by_kid = [k for k in keys if k.get("kid") == hdr["kid"]]
    if by_kid:
        keys = by_kid
assert keys, "no P-256 signing key in the JWKS"
key = keys[0]
assert key.get("alg", "ES256") == "ES256", "JWKS key is not ES256"

# JWK -> SPKI PEM (uncompressed point)
x = b64u(key["x"]).rjust(32, b"\x00")
y = b64u(key["y"]).rjust(32, b"\x00")
spki = der(0x30,
    der(0x30,
        der(0x06, bytes.fromhex("2a8648ce3d0201"))       # id-ecPublicKey
        + der(0x06, bytes.fromhex("2a8648ce3d030107")))  # prime256v1
    + der(0x03, b"\x00" + b"\x04" + x + y))
pem_b64 = base64.b64encode(spki).decode()
pem = ("-----BEGIN PUBLIC KEY-----\n"
       + "\n".join(pem_b64[i:i + 64] for i in range(0, len(pem_b64), 64))
       + "\n-----END PUBLIC KEY-----\n")
open("runtime/jwks-pub.pem", "w").write(pem)

# JOSE signature is raw r||s; openssl wants DER
sig = b64u(jwt[2])
assert len(sig) == 64, "ES256 signature is not 64 raw bytes"
open("runtime/jwks-sig.der", "wb").write(der(0x30, der_int(sig[:32]) + der_int(sig[32:])))
open("runtime/jwks-body", "wb").write((jwt[0] + "." + jwt[1]).encode())
rc = subprocess.run(
    ["openssl", "dgst", "-sha256", "-verify", "runtime/jwks-pub.pem",
     "-signature", "runtime/jwks-sig.der", "runtime/jwks-body"],
    capture_output=True).returncode
assert rc == 0, "id_token ES256 signature does NOT verify against the JWKS"

now = time.time()
assert claims.get("iss") == expected_iss, "iss %r is not the client issuer" % claims.get("iss")
assert claims.get("aud") in ("e2e-raw", ["e2e-raw"]), "aud is not e2e-raw"
assert claims.get("nonce"), "no nonce in the id_token"
assert claims["exp"] > now, "id_token already expired"
assert claims["iat"] <= now + 60, "iat is in the future"
print(claims["sub"])
PY
)" || die "raw leg: id_token failed JWKS verification or the claim contract"
# nonce equality and the spn shape grappa's group_member?/2 matches
python3 - "$IDTOK" "$RNONCE" <<'PY' || die "raw leg: nonce/groups claim contract failed"
import base64, json, sys
p = sys.argv[1].split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
assert claims.get("nonce") == sys.argv[2], "nonce not echoed in the id_token"
groups = claims.get("groups", [])
assert any(g.split("@")[0] == "grappa_users" for g in groups), \
    "groups claim does not carry the grappa_users spn: %r" % groups
print("id_token ok: nonce echoed, groups %r" % groups[:3])
PY
echo "id_token verified against the JWKS: sub=$JSUB"

# userinfo with the access token: same sub as the id_token.
UICODE=$(curl -s -o runtime/userinfo.json -w '%{http_code}' \
    --cacert runtime/ca.pem -H "Authorization: Bearer $ACCTOK" "$UI_EP")
[ "$UICODE" = "200" ] || die "raw leg: userinfo answered $UICODE"
UISUB="$(python3 -c 'import json;print(json.load(open("runtime/userinfo.json"))["sub"])')"
[ "$UISUB" = "$JSUB" ] || die "raw leg: userinfo sub ≠ id_token sub"

# A same-verifier replay of the code is NOT assertable against Kanidm:
# the code is a stateless short-lived JWE, not a consumed row — 1.11.1's
# check_oauth2_token_exchange_authorization_code decrypts it, checks
# expiry/PKCE/redirect and mints, with no single-use mark anywhere. What
# the provider DOES guarantee, and what actually protects the code in
# transit, is the PKCE binding: a thief who intercepts the code but not
# the verifier exchanges nothing.
THIEFTOK="$($RAWCURL -X POST "$TOK_EP" -u "e2e-raw:$RSECRET" \
    -d "grant_type=authorization_code&code=$RCODE&redirect_uri=$RAWREDIRECT&code_verifier=stolen-code-no-verifier")"
if printf '%s' "$THIEFTOK" | grep -qE '"(access_token|id_token)"'; then
    die "raw leg: the code exchanged with a wrong PKCE verifier"
fi
echo "stolen code refused: $(printf '%s' "$THIEFTOK" | head -c 80)"

# ---------------------------------------------------------------------------
step "grappa door hardening (bogus state, garbage bearer, link idempotence)"
# grappa's half, no provider needed: the callback door must refuse without
# ever minting a session, and the link door must be idempotent.
$FLOW -o /dev/null -D runtime/hdr-bogus "$GRAPPA/auth/oidc/callback?code=x&state=bogus"
FRAG=$(grep -i '^location' runtime/hdr-bogus | tr -d '\r' | awk '{print $2}' | sed 's|^/login#oidc=||' || true)
[ "$(frag kind)" = "error" ] && [ "$(frag code)" = "invalid_state" ] \
    || die "hardening: bogus state got kind '$(frag kind)' code '$(frag code)' (want error/invalid_state)"

GCODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer not-a-bearer" "$GRAPPA/me/oidc")
[ "$GCODE" = "401" ] \
    || die "hardening: garbage bearer answered $GCODE on /me/oidc (want 401)"

# A SECOND link round trip for the same (account, person) pair is refused
# by name — the link door may be retried, never duplicated.
AURL="$($KURL -X POST "$GRAPPA/me/oidc/link" \
    -H "Authorization: Bearer $GTOK" -H 'Content-Type: application/json' -d '{}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["authorize_url"])')"
[ -n "$AURL" ] || die "hardening: no authorize_url from a second /me/oidc/link"
new_jar
wizard "$KUSER" "$AURL"
CB="$(callback)"
$FLOW -o /dev/null -D runtime/hdr-cb "$CB"
FRAG=$(grep -i '^location' runtime/hdr-cb | tr -d '\r' | awk '{print $2}' | sed 's|^/login#oidc=||' || true)
[ "$(frag kind)" = "error" ] && [ "$(frag code)" = "already_linked" ] \
    || die "hardening: second link got kind '$(frag kind)' code '$(frag code)' (want error/already_linked)"

# ---------------------------------------------------------------------------
step "gate de-flip: leaving $AGROUP closes the admin door again"
# The sync leg runs in BOTH directions (docs/oidc-kanidm.md §3): removing
# the newcomer from the admins group must flip is_admin back on the next
# login — an upgrade-only sync would strand admins forever.
# Fresh CLI login here too: the late legs sit past the token's lifetime
# on a slow host (see the retention leg below for the measured failure).
# The exec below is /sbin/kanidmd, the ONLY kanidm binary in the server
# image — a kanidm-tools-style /sbin/kanidm does not exist there, and the
# typo killed this leg with a silent rc=127 before any HTTP (measured
# 2026-09-12: no die message, no kcli traffic, dead at the PW assignment).
PW=$(docker exec grappa-oidc-kanidm /sbin/kanidmd recover-account \
    -c /etc/kanidm/server.toml idm_admin 2>&1 | grep -oE '[0-9a-z]{48}' | head -1 || true)
[ -n "$PW" ] || die "de-flip: no recovery password for the idm_admin re-login"
KANIDM_PASSWORD="$PW" kcli login -D idm_admin >/dev/null 2>&1 \
    || die "de-flip: idm_admin re-login failed"
kcli group remove-members "$AGROUP" "$NEWUSER" -D idm_admin >/dev/null \
    || die "de-flip: removing $NEWUSER from $AGROUP failed"
login_leg "$NEWUSER"
NTOK="$(frag token)"
[ -n "$NTOK" ] || die "de-flip: no token on the post-removal login"
NCODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $NTOK" "$GRAPPA/admin/me")
[ "$NCODE" = "403" ] \
    || die "de-flip: admin door still open after leaving $AGROUP ($NCODE)"

# The callback URL of that very login was consumed by login_leg above:
# replaying it must not re-mint a session (take-consumes-it semantics).
$FLOW -o /dev/null -D runtime/hdr-replay "$CB"
FRAG=$(grep -i '^location' runtime/hdr-replay | tr -d '\r' | awk '{print $2}' | sed 's|^/login#oidc=||' || true)
[ "$(frag kind)" = "error" ] \
    || die "de-flip: replayed callback got kind '$(frag kind)' (want error)"

# ---------------------------------------------------------------------------
step "gate retention: the LAST admin leaving the group logs in, not 500s"
# The de-flip above proves the healthy direction; this is its shadow case,
# and it is the one that crashed before the fix: the sync's
# {:error, :last_admin} had no else arm, the callback died with a
# WithClauseError, /auth/oidc/callback answered 500 and no fragment came
# back. The contract now: the login still mints a session (the human
# cannot fix the admin count), the guard still holds (flag retained), the
# door stays open, and the operator is TOLD — the warning is part of the
# acceptance, silence would paper over the retained flag.
# The leg lands past the CLI token's lifetime (the run is ~6 min old by
# now and an expired token makes kanidm prompt for the password on a
# dead tty — "not a terminal", measured); recover + re-login instead.
PW=$(docker exec grappa-oidc-kanidm /sbin/kanidmd recover-account \
    -c /etc/kanidm/server.toml idm_admin 2>&1 | grep -oE '[0-9a-z]{48}' | head -1 || true)
[ -n "$PW" ] || die "retention: no recovery password for the idm_admin re-login"
KANIDM_PASSWORD="$PW" kcli login -D idm_admin >/dev/null 2>&1 \
    || die "retention: idm_admin re-login failed"
kcli group add-members "$AGROUP" "$NEWUSER" -D idm_admin >/dev/null \
    || die "retention: re-adding $NEWUSER to $AGROUP failed"
login_leg "$NEWUSER"
[ "$(frag kind)" = "session" ] \
    || die "retention: re-joining $AGROUP got kind '$(frag kind)' (want session)"
# Demote the password-door admin while the newcomer holds the flag, so
# the next sync demotes the LAST admin (the guard's refusal case).
GID=$(curl -s -H "Authorization: Bearer $GTOK" "$GRAPPA/admin/users" \
    | python3 -c 'import json,sys;print(next(u["id"] for u in json.load(sys.stdin)["users"] if u["name"] == sys.argv[1]))' "$GUSER")
DCODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$GRAPPA/admin/users/$GID" \
    -H "Authorization: Bearer $GTOK" -H 'Content-Type: application/json' \
    -d '{"is_admin":false}')
[ "$DCODE" = "200" ] || die "retention: demoting $GUSER answered $DCODE (want 200)"
# -D idm_admin, like every kcli call above: the one bare invocation this
# used to be authenticated with the DEFAULT identity, whose token the
# re-login above never refreshed — kcli prompted for a password on a
# dead tty and died "not a terminal" (measured 2026-09-12, silently).
kcli group remove-members "$AGROUP" "$NEWUSER" -D idm_admin >/dev/null \
    || die "retention: removing $NEWUSER from $AGROUP failed"
login_leg "$NEWUSER"
[ "$(frag kind)" = "session" ] \
    || die "retention: last-admin login got kind '$(frag kind)' (want session, was a 500 crash)"
NTOK="$(frag token)"
[ -n "$NTOK" ] || die "retention: no token on the last-admin login"
RCODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $NTOK" "$GRAPPA/admin/me")
[ "$RCODE" = "200" ] \
    || die "retention: admin door answered $RCODE for the retained last admin (want 200)"
# Name the newcomer: the login leg's linked-account retention (oidc-ci,
# the lone password-door admin of the early run) logs the SAME phrase on
# every run, so a bare "is the last admin" grep is satisfied whatever
# this leg does — a mirror assertion, not a check.
$COMPOSE logs grappa 2>&1 | grep -q "$NEWUSER left $AGROUP but is the last admin" \
    || die "retention: no last-admin warning for $NEWUSER in grappa's logs — the retention was silent"

echo
echo "oidc-e2e: GREEN — link + login + gate + raw + hardening legs against Kanidm $KPORT, grappa :$GPORT"
