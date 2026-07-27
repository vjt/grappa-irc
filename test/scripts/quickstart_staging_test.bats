#!/usr/bin/env bats
#
# Bats suite for scripts/quickstart.sh — the staging-box surface (#469):
# a public hostname instead of the pinned localhost, an optional seeded
# account + network binding, and the rendered front-door nginx config.
#
# Scope: asserts what the script WRITES (.env, runtime/nginx-frontend.conf)
# and the SHAPE of the docker invocations it makes. `docker` is stubbed on
# PATH so no image is built and no container is touched — same recording
# shape as test/scripts/mix_env_db_test.bats.
#
# The script cds to its own repo root and writes .env there, so each test
# runs against a throwaway skeleton in BATS_TEST_TMPDIR rather than the
# real checkout.

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    BOX="$BATS_TEST_TMPDIR/box"
    mkdir -p "$BOX/scripts" "$BOX/infra"

    cp "$REPO_SRC/scripts/quickstart.sh" "$BOX/scripts/"
    cp "$REPO_SRC/infra/nginx-tls-frontend.example.conf" "$BOX/infra/"
    cp "$REPO_SRC/.env.example" "$BOX/.env.example"
    # Only its presence is checked (preflight), never its content.
    : > "$BOX/compose.yaml"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Fake `docker` — records every invocation, exits 0.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"
}

# Make `docker` fail for the invocation whose argv matches $1 (and only
# that one), so the "already seeded" path can be exercised.
stub_docker_failing_on() {
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
for a in "\$@"; do
  [ "\$a" = "$1" ] && exit 1
done
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
}

@test "default run keeps localhost and seeds nothing" {
    run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]

    grep -qE '^PHX_HOST=localhost$' "$BOX/.env"
    ! grep -q 'grappa.create_user' "$ARGV_LOG"
    ! grep -q 'grappa.bind_network' "$ARGV_LOG"
}

@test "an explicitly passed PHX_HOST overwrites what a previous run left in .env" {
    PHX_HOST=first.example.org run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]
    grep -qE '^PHX_HOST=first\.example\.org$' "$BOX/.env"

    PHX_HOST=second.example.org run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]

    # Exactly one PHX_HOST line, carrying the new value — a stale hostname
    # is the #468 failure mode (links minted for the wrong host, silently).
    [ "$(grep -c '^PHX_HOST=' "$BOX/.env")" -eq 1 ]
    grep -qE '^PHX_HOST=second\.example\.org$' "$BOX/.env"
}

@test "a pre-existing .env hostname survives a run that does not pass one" {
    PHX_HOST=pinned.example.org run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]

    run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]
    grep -qE '^PHX_HOST=pinned\.example\.org$' "$BOX/.env"
    # ...and the rendered front door describes the box as it really is,
    # not as this invocation defaulted.
    grep -q 'server_name pinned.example.org;' "$BOX/runtime/nginx-frontend.conf"
}

@test "an explicitly passed HTTP_BIND wins over what .env already carries" {
    # .env.example publishes on every interface; a fresh .env must not
    # inherit that when the caller asked for a specific bind.
    HTTP_BIND=127.0.0.1:3100 run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]
    [ "$(grep -c '^NGINX_PUBLISH=' "$BOX/.env")" -eq 1 ]
    grep -qE '^NGINX_PUBLISH=127\.0\.0\.1:3100:80$' "$BOX/.env"

    HTTP_BIND=127.0.0.1:3200 run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]
    [ "$(grep -c '^NGINX_PUBLISH=' "$BOX/.env")" -eq 1 ]
    grep -qE '^NGINX_PUBLISH=127\.0\.0\.1:3200:80$' "$BOX/.env"
    [[ "$output" == *"http://127.0.0.1:3200/"* ]]
}

@test "a fresh .env does not inherit the example's all-interfaces publish" {
    run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]
    grep -qE '^NGINX_PUBLISH=127\.0\.0\.1:3000:80$' "$BOX/.env"
}

@test "a bind pinned by an earlier run is reported and proxied to, not silently replaced" {
    HTTP_BIND=127.0.0.1:3100 run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]

    PHX_HOST=staging.example.org run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]
    grep -qE '^NGINX_PUBLISH=127\.0\.0\.1:3100:80$' "$BOX/.env"
    [[ "$output" == *"http://127.0.0.1:3100/"* ]]
    grep -q 'server 127.0.0.1:3100;' "$BOX/runtime/nginx-frontend.conf"
}

@test "a bare-port publish from .env is normalised to loopback in output and upstream" {
    run "$BOX/scripts/quickstart.sh"   # creates .env
    [ "$status" -eq 0 ]
    # Simulate the compose short form a hand-edited .env may carry.
    grep -v '^NGINX_PUBLISH=' "$BOX/.env" > "$BOX/.env.tmp"
    mv "$BOX/.env.tmp" "$BOX/.env"
    printf 'NGINX_PUBLISH=8080:80\n' >> "$BOX/.env"

    PHX_HOST=staging.example.org run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"http://127.0.0.1:8080/"* ]]
    grep -q 'server 127.0.0.1:8080;' "$BOX/runtime/nginx-frontend.conf"
}

@test "front-door config is rendered with hostname, upstream and cert paths filled in" {
    PHX_HOST=staging.example.org HTTP_BIND=127.0.0.1:3100 \
        FRONTEND_SSL_CERT=/tmp/cert.pem FRONTEND_SSL_KEY=/tmp/key.pem \
        run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]

    conf="$BOX/runtime/nginx-frontend.conf"
    [ -f "$conf" ]
    ! grep -q '<your-domain>' "$conf"
    [ "$(grep -c 'server_name staging.example.org;' "$conf")" -eq 2 ]
    grep -q 'server 127.0.0.1:3100;' "$conf"
    grep -q 'ssl_certificate     /tmp/cert.pem;' "$conf"
    grep -q 'ssl_certificate_key /tmp/key.pem;' "$conf"

    # The upgrade path a front door must carry, kept from the example.
    grep -q 'proxy_set_header Upgrade \$http_upgrade;' "$conf"
    grep -q 'proxy_set_header X-Forwarded-Proto \$scheme;' "$conf"
}

@test "a wildcard bind is rewritten to loopback in the rendered upstream" {
    PHX_HOST=staging.example.org HTTP_BIND=0.0.0.0:3000 \
        run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]

    grep -q 'server 127.0.0.1:3000;' "$BOX/runtime/nginx-frontend.conf"
    ! grep -q 'server 0.0.0.0:3000;' "$BOX/runtime/nginx-frontend.conf"
}

@test "SEED_USER creates the account and binds the network before the stack comes up" {
    SEED_USER=tester SEED_PASSWORD=hunter2222 SEED_NICK=tester-box \
        SEED_AUTOJOIN='#grappa' run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]

    grep -q "grappa.create_user --name tester --password hunter2222" "$ARGV_LOG"
    # argv is recorded through %q, so the channel's '#' comes back escaped.
    grep -q -- "grappa.bind_network --user tester --network azzurra --server irc.azzurra.chat:6697 --nick tester-box --auth none --autojoin \\\\#grappa" "$ARGV_LOG"

    # Bootstrap reads the binding at boot, so seeding must precede `up`.
    seed_line="$(grep -n 'grappa.bind_network' "$ARGV_LOG" | head -n1 | cut -d: -f1)"
    up_line="$(grep -n 'up -d' "$ARGV_LOG" | head -n1 | cut -d: -f1)"
    [ -n "$seed_line" ] && [ -n "$up_line" ] && [ "$seed_line" -lt "$up_line" ]
}

@test "seeding overrides reach the bind_network call" {
    SEED_USER=tester SEED_PASSWORD=hunter2222 SEED_NETWORK=libera \
        SEED_SERVER=irc.libera.chat:6697 SEED_AUTH=sasl \
        SEED_NICK_PASSWORD=s3cret run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]

    grep -q -- "--network libera --server irc.libera.chat:6697 --nick tester --auth sasl --password s3cret" "$ARGV_LOG"
}

@test "an already-seeded box is a warning, not a failed install" {
    stub_docker_failing_on grappa.create_user

    SEED_USER=tester SEED_PASSWORD=hunter2222 run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]

    # The binding is still attempted, and the stack still comes up.
    grep -q 'grappa.bind_network' "$ARGV_LOG"
    grep -q 'up -d' "$ARGV_LOG"
}

@test "a generated seed password is printed and is not the empty string" {
    SEED_USER=tester run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]

    # `Seeded account:  tester / <password>` — the password must be there.
    line="$(printf '%s\n' "$output" | grep 'Seeded account:')"
    pass="${line##*/ }"
    [ -n "$pass" ]
    [ "${#pass}" -ge 8 ]
    grep -q "grappa.create_user --name tester --password $pass" "$ARGV_LOG"
}

@test "off-localhost runs warn about the secure-context trap" {
    PHX_HOST=staging.example.org run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"service workers refuse to register"* ]]

    run "$BOX/scripts/quickstart.sh"
    [ "$status" -eq 0 ]
}
