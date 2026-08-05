#!/usr/bin/env bats
#
# Bats suite for infra/docker/release-entrypoint.sh FIRST-BOOT SECRET
# BOOTSTRAP (#862).
#
# `docker run ghcr.io/vjt/grappa:<tag> start` used to die on a missing
# SECRET_KEY_BASE — the image is deliberately secret-less and nothing on the
# bare-run path ever generated any. The entrypoint now fills the gap with the
# generator the .deb/.rpm hosts already use (infra/packaging/gen-secrets.sh,
# openssl-only, no BEAM), persisting to the /data volume so a restart reuses
# the same values.
#
# Scope: the entrypoint's env handling, exercised for real. `bin/grappa` is a
# recorder stub that dumps the environment it was exec'd with, so every
# assertion reads what the RELEASE would actually have seen. openssl, chmod
# and gen-secrets.sh run for real — the secrets are genuine, only the release
# is faked. `nproc` is stubbed because it is GNU-only and this suite must run
# on the maintainer's darwin box as well as the ubuntu CI runner.
#
# The three invariants this pins, in the order they can hurt:
#   1. operator-supplied env ALWAYS wins (`-e` / `--env-file` unchanged),
#   2. secrets are NEVER regenerated on a volume that has them (rotating
#      GRAPPA_ENCRYPTION_KEY makes every Cloak-encrypted credential
#      undecryptable — data loss, not an inconvenience),
#   3. PHX_HOST is never invented; a bare run still fails for that alone.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."

    # /app in the image: the entrypoint, the generator beside it, and the
    # release's bin/. The entrypoint execs `bin/grappa` relative to cwd.
    APP="$BATS_TEST_TMPDIR/app"
    mkdir -p "$APP/bin"
    cp "$REPO_SRC/infra/docker/release-entrypoint.sh" "$APP/release-entrypoint.sh"
    cp "$REPO_SRC/infra/packaging/gen-secrets.sh" "$APP/gen-secrets.sh"
    chmod 0755 "$APP/release-entrypoint.sh" "$APP/gen-secrets.sh"

    # The /data volume.
    DATA="$BATS_TEST_TMPDIR/data"
    mkdir -p "$DATA"
    SECRETS_FILE="$DATA/grappa.env"
    export DATABASE_PATH="$DATA/grappa.db"
    export UPLOADS_STORAGE_ROOT="$DATA/uploads"

    # The release stub: records argv + the environment it inherited.
    ENV_DUMP="$BATS_TEST_TMPDIR/env.dump"
    export ENV_DUMP
    cat > "$APP/bin/grappa" <<'EOF'
#!/usr/bin/env bash
{ printf 'ARGV=%s\n' "$*"; env; } > "$ENV_DUMP"
EOF
    chmod 0755 "$APP/bin/grappa"

    # `nproc` is GNU-only; the entrypoint sizes +SDcpu with it.
    STUB="$BATS_TEST_TMPDIR/stub"
    mkdir -p "$STUB"
    printf '#!/bin/sh\necho 4\n' > "$STUB/nproc"
    chmod 0755 "$STUB/nproc"
    PATH="$STUB:$PATH"

    # Never let the caller's own environment satisfy a secret.
    unset SECRET_KEY_BASE SECRET_SIGNING_SALT RELEASE_COOKIE \
          GRAPPA_ENCRYPTION_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY PHX_HOST
}

# Run the entrypoint the way the image does: cwd=/app, argv from CMD.
entrypoint() {
    cd "$APP" && ./release-entrypoint.sh "$@"
}

# Value of KEY as the exec'd release saw it ("" when unset).
exported() {
    sed -n "s/^$1=//p" "$ENV_DUMP"
}

REQUIRED_SECRETS="SECRET_KEY_BASE SECRET_SIGNING_SALT RELEASE_COOKIE GRAPPA_ENCRYPTION_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY"

@test "bare run: every secret runtime.exs raises on reaches the release" {
    run entrypoint start
    [ "$status" -eq 0 ]

    grep -q '^ARGV=start$' "$ENV_DUMP"
    for key in $REQUIRED_SECRETS; do
        val="$(exported "$key")"
        [ -n "$val" ] || {
            printf 'the release was exec\x27d without %s — a bare docker run still dies\n' "$key" >&2
            return 1
        }
    done
}

@test "bare run: secrets persist beside the DB on the /data volume, at 0600" {
    entrypoint start

    [ -f "$SECRETS_FILE" ]
    for key in $REQUIRED_SECRETS; do
        grep -qE "^${key}=.+$" "$SECRETS_FILE"
    done

    # ls is portable where `stat` is not (BSD vs GNU flag split).
    perms="$(ls -l "$SECRETS_FILE" | cut -c1-10)"
    [ "$perms" = "-rw-------" ] || {
        printf 'secrets file is %s, expected -rw------- (0600)\n' "$perms" >&2
        return 1
    }
}

@test "operator-supplied secrets are never overwritten" {
    export SECRET_KEY_BASE="operator-supplied-key-base"
    export GRAPPA_ENCRYPTION_KEY="operator-supplied-encryption-key"

    entrypoint start

    [ "$(exported SECRET_KEY_BASE)" = "operator-supplied-key-base" ]
    [ "$(exported GRAPPA_ENCRYPTION_KEY)" = "operator-supplied-encryption-key" ]
    # ...and the ones the operator did NOT supply are still filled in.
    [ -n "$(exported VAPID_PUBLIC_KEY)" ]
}

@test "a fully-supplied environment writes nothing to the volume" {
    # deploy.sh's --env-file path: every secret already present, so the
    # entrypoint must stay entirely out of /data.
    for key in $REQUIRED_SECRETS; do
        export "$key=already-set-$key"
    done

    entrypoint start

    refute test -f "$SECRETS_FILE"
    [ "$(exported SECRET_KEY_BASE)" = "already-set-SECRET_KEY_BASE" ]
}

@test "a restart reuses the volume's secrets byte-for-byte (no rotation)" {
    entrypoint start
    first_key="$(exported SECRET_KEY_BASE)"
    first_cloak="$(exported GRAPPA_ENCRYPTION_KEY)"
    first_vapid="$(exported VAPID_PUBLIC_KEY)"
    cp "$SECRETS_FILE" "$BATS_TEST_TMPDIR/first.env"

    entrypoint start

    # Rotating GRAPPA_ENCRYPTION_KEY orphans every Cloak-encrypted
    # credential; rotating SECRET_KEY_BASE logs everyone out.
    [ "$(exported SECRET_KEY_BASE)" = "$first_key" ]
    [ "$(exported GRAPPA_ENCRYPTION_KEY)" = "$first_cloak" ]
    [ "$(exported VAPID_PUBLIC_KEY)" = "$first_vapid" ]
    cmp -s "$BATS_TEST_TMPDIR/first.env" "$SECRETS_FILE"
}

@test "a pre-seeded volume file is honoured verbatim" {
    umask 077
    {
        printf 'SECRET_KEY_BASE=preseeded-key-base\n'
        printf 'SECRET_SIGNING_SALT=preseeded-salt\n'
        printf 'RELEASE_COOKIE=preseeded-cookie\n'
        printf 'GRAPPA_ENCRYPTION_KEY=preseeded-cloak\n'
        printf 'VAPID_PUBLIC_KEY=preseeded-vapid-pub\n'
        printf 'VAPID_PRIVATE_KEY=preseeded-vapid-priv\n'
    } > "$SECRETS_FILE"
    cp "$SECRETS_FILE" "$BATS_TEST_TMPDIR/preseeded.env"

    entrypoint start

    [ "$(exported SECRET_KEY_BASE)" = "preseeded-key-base" ]
    [ "$(exported VAPID_PRIVATE_KEY)" = "preseeded-vapid-priv" ]
    cmp -s "$BATS_TEST_TMPDIR/preseeded.env" "$SECRETS_FILE"
}

@test "PHX_HOST is never invented — the bare run must still fail for it" {
    entrypoint start

    refute grep -q '^PHX_HOST=' "$ENV_DUMP"
    refute grep -q '^PHX_HOST=' "$SECRETS_FILE"
}

@test "base64 secrets survive the env-file round trip unmangled" {
    entrypoint start

    # SECRET_KEY_BASE is base64 with '+', '/' and '=' padding; a naive
    # `${line#*=}`-free parse or a `source` would mangle or execute it.
    file_val="$(sed -n 's/^SECRET_KEY_BASE=//p' "$SECRETS_FILE")"
    [ "$(exported SECRET_KEY_BASE)" = "$file_val" ]
    [ "${#file_val}" -ge 44 ]
}

@test "the BEAM resource caps still ride through unchanged" {
    export GRAPPA_MAX_USERS=7
    entrypoint start

    zflags="$(exported ERL_ZFLAGS)"
    case "$zflags" in
        *"+Q 2800"*"+P 700"*) ;;
        *) printf 'ERL_ZFLAGS=%s did not keep the #503 caps\n' "$zflags" >&2; return 1 ;;
    esac
}
