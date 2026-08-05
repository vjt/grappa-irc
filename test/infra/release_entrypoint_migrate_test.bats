#!/usr/bin/env bats
#
# Bats suite for infra/docker/release-entrypoint.sh BOOT-TIME MIGRATION
# (#867).
#
# With #862's secrets in place, `docker run <image> start` on a fresh volume
# got one step further and died on `no such table: admin_events` — the image
# ships the migrator but nothing on the bare-run path ever invoked it, and
# the operator has no other door (no mix, no checkout, no deploy script
# inside the image). Measured before the fix: the container exits; measured
# after: /healthz 200.
#
# Scope: the entrypoint's decision — WHEN it migrates, when it must not, and
# what it does when the migration fails. `bin/grappa` is a recorder stub that
# logs every invocation and the environment it inherited, so the assertions
# read what the RELEASE (and the migrator) would actually have seen.
#
# The four properties, in the order they can hurt:
#   1. a boot verb migrates BEFORE the release starts — otherwise #867 is
#      still open;
#   2. a FAILED migration refuses to boot. Starting on a half-applied schema
#      and reporting healthy is the exact class of defect #441 found in
#      install.sh (fail loud, exit 0, "healthy" with an empty Cloak key);
#   3. `eval` / `rpc` / `remote` / `stop` never migrate — deploy.sh's own
#      `eval 'Grappa.Release.migrate()'` runs through THIS entrypoint, and a
#      nested migrate would be a second BEAM racing the first;
#   4. an unparseable GRAPPA_AUTO_MIGRATE is rejected, never guessed:
#      reading `true` as false would silently reinstate the bug.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."

    APP="$BATS_TEST_TMPDIR/app"
    mkdir -p "$APP/bin"
    cp "$REPO_SRC/infra/docker/release-entrypoint.sh" "$APP/release-entrypoint.sh"
    cp "$REPO_SRC/infra/packaging/gen-secrets.sh" "$APP/gen-secrets.sh"
    chmod 0755 "$APP/release-entrypoint.sh" "$APP/gen-secrets.sh"

    DATA="$BATS_TEST_TMPDIR/data"
    mkdir -p "$DATA"
    export DATABASE_PATH="$DATA/grappa.db"
    export UPLOADS_STORAGE_ROOT="$DATA/uploads"

    # The release stub. One line per invocation in CALL_LOG (so ORDER is
    # observable), plus the inherited environment per verb in env.<verb> —
    # the migrator runs config/runtime.exs too, so it needs the secrets the
    # bootstrap above it exported.
    CALL_LOG="$BATS_TEST_TMPDIR/calls.log"
    ENV_DIR="$BATS_TEST_TMPDIR/env"
    export CALL_LOG ENV_DIR
    mkdir -p "$ENV_DIR"
    : > "$CALL_LOG"

    # MIGRATE_RC injects a failing migrator (a broken migration, a locked DB,
    # a read-only volume — all the same shape from out here).
    export MIGRATE_RC=0
    cat > "$APP/bin/grappa" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALL_LOG"
env > "$ENV_DIR/$1"
if [ "$1" = eval ] && [ "${MIGRATE_RC:-0}" -ne 0 ]; then
    echo "** (Exqlite.Error) some migration blew up" >&2
    exit "$MIGRATE_RC"
fi
EOF
    chmod 0755 "$APP/bin/grappa"

    STUB="$BATS_TEST_TMPDIR/stub"
    mkdir -p "$STUB"
    printf '#!/bin/sh\necho 4\n' > "$STUB/nproc"
    chmod 0755 "$STUB/nproc"
    PATH="$STUB:$PATH"

    unset SECRET_KEY_BASE SECRET_SIGNING_SALT RELEASE_COOKIE \
        GRAPPA_ENCRYPTION_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY PHX_HOST \
        GRAPPA_AUTO_MIGRATE
}

entrypoint() {
    cd "$APP" && ./release-entrypoint.sh "$@"
}

# Invocations of the release, in order, one per line.
calls() {
    cat "$CALL_LOG"
}

MIGRATE_CALL="eval Grappa.Release.migrate()"

@test "a bare start migrates, and does it BEFORE the release boots" {
    run entrypoint start
    [ "$status" -eq 0 ]

    # Both happened...
    grep -qF "$MIGRATE_CALL" "$CALL_LOG"
    grep -qx 'start' "$CALL_LOG"
    # ...and in the only order that helps: a start that precedes the
    # migration is #867 unchanged.
    [ "$(head -n1 "$CALL_LOG")" = "$MIGRATE_CALL" ]
    [ "$(tail -n1 "$CALL_LOG")" = "start" ]
}

@test "the migrator inherits the bootstrapped secrets" {
    # config/runtime.exs runs for `eval` as well, and raises on a missing
    # SECRET_KEY_BASE. A migration ordered before the #862 bootstrap would
    # die on the secrets wall instead of migrating.
    entrypoint start

    [ -f "$ENV_DIR/eval" ]
    for key in SECRET_KEY_BASE GRAPPA_ENCRYPTION_KEY VAPID_PRIVATE_KEY; do
        grep -qE "^${key}=.+$" "$ENV_DIR/eval" || {
            printf 'the migrator was run without %s — it would raise, not migrate\n' "$key" >&2
            return 1
        }
    done
}

@test "GRAPPA_AUTO_MIGRATE=0 boots without migrating" {
    export GRAPPA_AUTO_MIGRATE=0
    run entrypoint start
    [ "$status" -eq 0 ]

    refute grep -qF "$MIGRATE_CALL" "$CALL_LOG"
    [ "$(calls)" = "start" ]
}

@test "a failed migration refuses to start — no boot on a half-applied schema" {
    export MIGRATE_RC=1
    run entrypoint start

    [ "$status" -ne 0 ]
    grep -qF "$MIGRATE_CALL" "$CALL_LOG"
    # The release must NEVER have been exec'd: a container that boots here
    # answers /healthz 200 on a schema nobody vouched for.
    refute grep -qx 'start' "$CALL_LOG"
    [[ "$output" == *"MIGRATION FAILED"* ]]
}

@test "a failed migration leaves the volume's data alone" {
    # "Non-destructive" is the operator-facing half of the promise: the
    # entrypoint owns no rollback, no delete, no re-create. Whatever was on
    # /data before the attempt is still there after it.
    printf 'pre-existing sqlite bytes\n' > "$DATABASE_PATH"
    entrypoint start                     # first boot: writes the secrets file
    cp "$DATA/grappa.env" "$BATS_TEST_TMPDIR/before.env"

    export MIGRATE_RC=1
    run entrypoint start
    [ "$status" -ne 0 ]

    [ "$(cat "$DATABASE_PATH")" = "pre-existing sqlite bytes" ]
    cmp -s "$BATS_TEST_TMPDIR/before.env" "$DATA/grappa.env"
}

@test "eval does not migrate first — deploy.sh's own migrate is not nested" {
    run entrypoint eval 'Grappa.Release.migrate()'
    [ "$status" -eq 0 ]

    # Exactly one invocation, the operator's own.
    [ "$(wc -l < "$CALL_LOG")" -eq 1 ]
    [ "$(calls)" = "$MIGRATE_CALL" ]
}

@test "non-boot verbs never migrate" {
    for verb in rpc remote stop version pid; do
        : > "$CALL_LOG"
        run entrypoint "$verb"
        [ "$status" -eq 0 ]
        refute grep -qF "$MIGRATE_CALL" "$CALL_LOG"
        [ "$(calls)" = "$verb" ]
    done
}

@test "daemon boots like start — and migrates like it" {
    run entrypoint daemon
    [ "$status" -eq 0 ]
    [ "$(head -n1 "$CALL_LOG")" = "$MIGRATE_CALL" ]
    [ "$(tail -n1 "$CALL_LOG")" = "daemon" ]
}

@test "an unparseable GRAPPA_AUTO_MIGRATE is rejected, not guessed" {
    # Reading `true` as "not 1, so off" would silently reinstate #867 on a
    # box whose operator believes they turned it on.
    for value in true yes on 2 off; do
        : > "$CALL_LOG"
        GRAPPA_AUTO_MIGRATE="$value" run entrypoint start
        [ "$status" -ne 0 ] || {
            printf 'GRAPPA_AUTO_MIGRATE=%s was accepted\n' "$value" >&2
            return 1
        }
        [[ "$output" == *"GRAPPA_AUTO_MIGRATE"* ]]
        [ ! -s "$CALL_LOG" ]
    done
}

@test "an EMPTY GRAPPA_AUTO_MIGRATE means unset, as everywhere else here" {
    # `docker run -e GRAPPA_AUTO_MIGRATE=` sets it to "". The secrets block
    # above already reads empty as absent, and config/runtime.exs words the
    # same semantic for PHX_HOST — one meaning for "" in this file, not two.
    GRAPPA_AUTO_MIGRATE='' run entrypoint start
    [ "$status" -eq 0 ]
    grep -qF "$MIGRATE_CALL" "$CALL_LOG"
}

@test "the secret bootstrap and the resource caps still ride through" {
    export GRAPPA_MAX_USERS=7
    entrypoint start

    grep -qE '^SECRET_KEY_BASE=.+$' "$ENV_DIR/start"
    zflags="$(sed -n 's/^ERL_ZFLAGS=//p' "$ENV_DIR/start")"
    case "$zflags" in
        *"+Q 2800"*"+P 700"*) ;;
        *) printf 'ERL_ZFLAGS=%s lost the #503 caps\n' "$zflags" >&2; return 1 ;;
    esac
}
