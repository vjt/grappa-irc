#!/usr/bin/env bats
#
# Bats suite for infra/packaging/gen-secrets.sh — the ONE secret generator
# (#862). It was written for the .deb/.rpm postinstall; the release image's
# entrypoint and infra/docker/deploy.sh now call the same file, so its
# contract has three consumers and drift is expensive.
#
# The claim under test is the one #862 flagged as contradicted in main:
# gen-secrets.sh says its openssl VAPID keypair is byte-for-byte the shape
# `mix grappa.gen_vapid` emits, while deploy.sh's write_env_file() said
# "host openssl cannot safely reproduce a raw P-256 point". Only one can be
# true. These tests decide it WITHOUT a BEAM, by checking the mathematics:
# the emitted private scalar must re-derive the emitted public point.
#
# The verifier's own derivation path is pinned first against the published
# FIPS 186-4 / RFC 6979 P-256 vector, so a passing property test is evidence
# about gen-secrets.sh and not about a broken oracle.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    GEN="$REPO_SRC/infra/packaging/gen-secrets.sh"
    ENV_FILE="$BATS_TEST_TMPDIR/grappa.env"
    export GRAPPA_ENV_FILE="$ENV_FILE"
    export GRAPPA_ENV_MODE=0600
}

# base64url (unpadded) -> lowercase hex.
b64url_hex() {
    b64="$1"
    case $(( ${#b64} % 4 )) in
        2) b64="${b64}==" ;;
        3) b64="${b64}=" ;;
    esac
    printf '%s' "$b64" | tr -- '-_' '+/' | base64 -d | od -An -tx1 -v | tr -d ' \n'
}

# hex scalar -> the uncompressed P-256 point openssl derives from it, hex.
# A SEC1 ECPrivateKey DER carrying ONLY the scalar + the curve OID; openssl
# recomputes the public point. Independent of how the scalar was produced.
derive_point() {
    der="$BATS_TEST_TMPDIR/scalar.der"
    printf '3031020101 0420%s a00a06082a8648ce3d030107' "$1" \
        | tr -d ' ' | xxd -r -p > "$der"
    openssl ec -inform DER -in "$der" -pubout -outform DER 2>/dev/null \
        | tail -c 65 | od -An -tx1 -v | tr -d ' \n'
}

@test "the verifier's own derivation matches the published P-256 vector" {
    # FIPS 186-4 / RFC 6979 A.2.5 example key. If this drifts, every other
    # assertion in this file is measuring a broken oracle.
    d=c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721
    want=0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299

    [ "$(derive_point "$d")" = "$want" ]
}

@test "the VAPID keypair is a real P-256 pair: the scalar re-derives the point" {
    # Ten fresh pairs — enough to catch a byte-extraction bug that only
    # bites on a scalar or coordinate with a leading zero (~1 in 256).
    for i in 1 2 3 4 5 6 7 8 9 10; do
        : > "$ENV_FILE"
        bash "$GEN" >/dev/null

        pub="$(sed -n 's/^VAPID_PUBLIC_KEY=//p' "$ENV_FILE")"
        priv="$(sed -n 's/^VAPID_PRIVATE_KEY=//p' "$ENV_FILE")"
        pub_hex="$(b64url_hex "$pub")"
        priv_hex="$(b64url_hex "$priv")"

        # mix grappa.gen_vapid emits Base.url_encode64 of :crypto's raw
        # {pub, priv}: a 65-byte uncompressed point (0x04||X||Y) and a
        # 32-byte big-endian scalar, both unpadded.
        [ "${#pub_hex}" -eq 130 ] || { printf 'pub is %s hex chars, want 130\n' "${#pub_hex}" >&2; return 1; }
        [ "${pub_hex%"${pub_hex#??}"}" = "04" ] || { printf 'pub does not start 0x04: %s\n' "${pub_hex%"${pub_hex#??}"}" >&2; return 1; }
        [ "${#priv_hex}" -eq 64 ] || { printf 'priv is %s hex chars, want 64\n' "${#priv_hex}" >&2; return 1; }
        refute grep -q '[=+/]' <<<"$pub$priv"

        [ "$(derive_point "$priv_hex")" = "$pub_hex" ] || {
            printf 'scalar does not derive the emitted point (iteration %s)\n' "$i" >&2
            return 1
        }
    done
}

@test "the four random secrets have the shapes runtime.exs decodes" {
    : > "$ENV_FILE"
    bash "$GEN" >/dev/null

    # GRAPPA_ENCRYPTION_KEY is Base.decode64!'d into a 32-byte AES-GCM key
    # by config/runtime.exs — a wrong length crashes the Vault at boot.
    key="$(sed -n 's/^GRAPPA_ENCRYPTION_KEY=//p' "$ENV_FILE")"
    [ "$(printf '%s' "$key" | base64 -d | wc -c | tr -d ' ')" = "32" ]

    # RELEASE_COOKIE: 64 hex chars, per .env.example / the runtime.exs hint.
    cookie="$(sed -n 's/^RELEASE_COOKIE=//p' "$ENV_FILE")"
    [ "${#cookie}" -eq 64 ]
    [ -z "$(printf '%s' "$cookie" | tr -d '0-9a-f')" ]

    [ -n "$(sed -n 's/^SECRET_KEY_BASE=//p' "$ENV_FILE")" ]
    [ -n "$(sed -n 's/^SECRET_SIGNING_SALT=//p' "$ENV_FILE")" ]
}

@test "idempotent: a second run rewrites nothing" {
    : > "$ENV_FILE"
    bash "$GEN" >/dev/null
    cp "$ENV_FILE" "$BATS_TEST_TMPDIR/first"

    run bash "$GEN"
    [ "$status" -eq 0 ]
    grep -q 'nothing to do' <<<"$output"
    cmp -s "$BATS_TEST_TMPDIR/first" "$ENV_FILE"
}

@test "runs unprivileged and honours the requested mode" {
    # The release container runs as the unprivileged `grappa` user and owns
    # /data already — there is nobody to chown to. Before #862 the
    # root-only chown ran unconditionally and set -e killed the script.
    : > "$ENV_FILE"
    chmod 0600 "$ENV_FILE"

    run bash "$GEN"
    [ "$status" -eq 0 ] || { printf 'gen-secrets died unprivileged:\n%s\n' "$output" >&2; return 1; }

    perms="$(ls -l "$ENV_FILE" | cut -c1-10)"
    [ "$perms" = "-rw-------" ] || { printf 'mode is %s, want -rw------- from GRAPPA_ENV_MODE=0600\n' "$perms" >&2; return 1; }
}

@test "the default mode stays 0640 for the packaged host" {
    # .deb/.rpm ship the env file root:grappa 0640 so the daemon reads it
    # group-only. #862 must not loosen or tighten that by accident.
    unset GRAPPA_ENV_MODE
    : > "$ENV_FILE"
    bash "$GEN" >/dev/null

    perms="$(ls -l "$ENV_FILE" | cut -c1-10)"
    [ "$perms" = "-rw-r-----" ] || { printf 'default mode is %s, want -rw-r----- (0640)\n' "$perms" >&2; return 1; }
}
