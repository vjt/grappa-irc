#!/usr/bin/env bats
#
# Bats suite for scripts/quickstart-update.sh (#469) — bringing an
# already-installed quickstart box up to the latest revision.
#
# Why a separate script at all: `deploy.sh` refuses anything that is not
# the main checkout on main (`require_main_checkout`), which is right for
# production and useless for a staging box that tracks a feature branch;
# and re-running `quickstart.sh` never pulls, so it can only ever
# re-install what is already on disk.
#
# Scope: asserts WHICH docker invocations the script makes for a given
# diff, and what it refuses to do. `docker` is stubbed on PATH — same
# recording shape as quickstart_staging_test.bats. `git`, by contrast, is
# REAL: the box is a genuine repository with a genuine upstream, because
# the whole point of this script is what it derives from a pull.

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Fake `docker` — records every invocation, exits 0.
    #
    # `docker inspect` is the one subcommand that has to answer rather
    # than only record: the ownership guard reads a compose label off the
    # container. Default is "no such container" (exit 1, as the real one
    # does), and FAKE_OWNER_DIR makes it exist, owned by that directory.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
if [ "\$1" = inspect ]; then
    [ -n "\${FAKE_OWNER_DIR:-}" ] || exit 1
    printf '%s\n' "\$FAKE_OWNER_DIR"
fi
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"

    export GIT_CONFIG_GLOBAL="$BATS_TEST_TMPDIR/gitconfig"
    export GIT_AUTHOR_NAME=bats GIT_AUTHOR_EMAIL=bats@example.org
    export GIT_COMMITTER_NAME=bats GIT_COMMITTER_EMAIL=bats@example.org

    # ---- upstream: what the box pulls FROM ----------------------------
    UPSTREAM="$BATS_TEST_TMPDIR/upstream"
    mkdir -p "$UPSTREAM"
    git -C "$UPSTREAM" init -q -b main
    mkdir -p "$UPSTREAM/scripts" "$UPSTREAM/cicchetto" \
             "$UPSTREAM/priv/repo/migrations"
    cp "$REPO_SRC/scripts/quickstart-update.sh" "$UPSTREAM/scripts/" 2>/dev/null || true
    # The real compose.yaml pins container_name on both long-lived
    # services; that pin is what makes two checkouts collide, so the
    # fixture has to carry it.
    cat > "$UPSTREAM/compose.yaml" <<'EOF'
services:
  grappa:
    container_name: grappa
  nginx:
    container_name: grappa-nginx
EOF
    printf 'FROM alpine\n'          > "$UPSTREAM/Dockerfile"
    printf '%%{}\n'                 > "$UPSTREAM/mix.lock"
    printf 'defmodule A do end\n'   > "$UPSTREAM/lib_a.ex"
    printf '{}\n'                   > "$UPSTREAM/cicchetto/package.json"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "base"

    # ---- the box: an installed quickstart checkout --------------------
    BOX="$BATS_TEST_TMPDIR/box"
    git clone -q "$UPSTREAM" "$BOX"
    # The script under test always runs from the source tree, so the box
    # gets a fresh copy rather than whatever the clone captured.
    mkdir -p "$BOX/scripts"
    cp "$REPO_SRC/scripts/quickstart-update.sh" "$BOX/scripts/"
    # An installed box has a .env — its absence is what "never installed"
    # means to this script.
    cat > "$BOX/.env" <<'EOF'
MIX_ENV=prod
PHX_HOST=staging.example.org
NGINX_PUBLISH=127.0.0.1:3100:80
EOF
}

# Commit $2 (a path, content $3) upstream so the box has something to pull.
upstream_commit() {
    local msg="$1" path="$2" content="$3"
    mkdir -p "$UPSTREAM/$(dirname "$path")"
    printf '%s\n' "$content" > "$UPSTREAM/$path"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "$msg"
}

@test "a box that was never installed is refused, not half-updated" {
    rm "$BOX/.env"
    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"quickstart.sh"* ]]
    # Nothing was pulled and no container was touched.
    [ ! -s "$ARGV_LOG" ]
}

@test "it fast-forwards the checkout and reports the revision it moved to" {
    upstream_commit "new code" lib_a.ex 'defmodule A do def x, do: 1 end'
    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]

    local head
    head="$(git -C "$BOX" rev-parse HEAD)"
    [ "$head" = "$(git -C "$UPSTREAM" rev-parse HEAD)" ]
    [[ "$output" == *"${head:0:7}"* ]]
}

@test "a diverged branch fails loud instead of merging" {
    upstream_commit "upstream moves" lib_a.ex 'defmodule A do def up, do: 1 end'
    # The box moves too, on the same file — no fast-forward possible.
    printf 'defmodule A do def local, do: 2 end\n' > "$BOX/lib_a.ex"
    git -C "$BOX" commit -qam "local divergence"

    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -ne 0 ]
    # It must not have gone on to recreate the stack on a failed pull.
    ! grep -q 'force-recreate' "$ARGV_LOG"
}

@test "a code-only change recreates the stack without rebuilding or migrating" {
    upstream_commit "code only" lib_a.ex 'defmodule A do def x, do: 2 end'
    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]

    grep -q 'force-recreate' "$ARGV_LOG"
    ! grep -q 'build' "$ARGV_LOG"
    ! grep -q 'deps.get' "$ARGV_LOG"
    ! grep -q 'ecto.migrate' "$ARGV_LOG"
    ! grep -q 'cicchetto-build' "$ARGV_LOG"
}

@test "a Dockerfile change rebuilds the image" {
    upstream_commit "toolchain" Dockerfile 'FROM alpine:3.20'
    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]
    grep -qE 'docker compose .*build' "$ARGV_LOG"
}

@test "a mix.lock change fetches deps" {
    upstream_commit "bump dep" mix.lock '%{"phoenix" => "1.8.0"}'
    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]
    grep -q 'deps.get' "$ARGV_LOG"
}

@test "a new migration runs ecto.migrate" {
    upstream_commit "add migration" \
        priv/repo/migrations/20260727000000_add_thing.exs 'defmodule M do end'
    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]
    grep -q 'ecto.migrate' "$ARGV_LOG"
}

@test "a cicchetto change rebuilds the PWA bundle" {
    upstream_commit "frontend" cicchetto/src/main.ts 'export const x = 1'
    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]
    grep -q 'cicchetto-build' "$ARGV_LOG"
}

@test "an already-current box still ensures the stack is up, cheaply" {
    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"already up to date"* ]]
    grep -qE 'docker compose .*up' "$ARGV_LOG"
    ! grep -q 'deps.get' "$ARGV_LOG"
    ! grep -q 'ecto.migrate' "$ARGV_LOG"
}

@test "--no-pull updates from the working tree and leaves git alone" {
    upstream_commit "not wanted yet" lib_a.ex 'defmodule A do def x, do: 3 end'
    local before
    before="$(git -C "$BOX" rev-parse HEAD)"

    run "$BOX/scripts/quickstart-update.sh" --no-pull
    [ "$status" -eq 0 ]
    [ "$(git -C "$BOX" rev-parse HEAD)" = "$before" ]
    grep -qE 'docker compose .*up' "$ARGV_LOG"
}

@test "it updates a box parked on a branch that is not main" {
    git -C "$BOX" checkout -q -b feat/staging
    git -C "$BOX" branch -q --set-upstream-to=origin/main feat/staging
    upstream_commit "code" lib_a.ex 'defmodule A do def x, do: 4 end'

    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]
    [ "$(git -C "$BOX" rev-parse --abbrev-ref HEAD)" = "feat/staging" ]
    grep -q 'force-recreate' "$ARGV_LOG"
}

@test "the URL it prints is the one .env actually publishes" {
    upstream_commit "code" lib_a.ex 'defmodule A do def x, do: 5 end'
    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"http://127.0.0.1:3100/"* ]]
}

@test "a box owned by another checkout is refused, and the owner is named" {
    # compose.yaml pins container_name, so the names are global rather
    # than project-scoped: the second checkout would get docker's bare
    # "container name /grappa is already in use", which names neither the
    # owner nor the fix.
    export FAKE_OWNER_DIR="$BATS_TEST_TMPDIR/some-other-checkout"
    upstream_commit "code" lib_a.ex 'defmodule A do def x, do: 6 end'

    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"$FAKE_OWNER_DIR"* ]]
    # Refused BEFORE any side effect: nothing pulled, nothing recreated.
    [ "$(git -C "$BOX" rev-parse HEAD)" != "$(git -C "$UPSTREAM" rev-parse HEAD)" ]
    ! grep -q 'force-recreate' "$ARGV_LOG"
}

@test "a box owned by this very checkout is updated, not refused" {
    export FAKE_OWNER_DIR="$BOX"
    upstream_commit "code" lib_a.ex 'defmodule A do def x, do: 7 end'

    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]
    grep -q 'force-recreate' "$ARGV_LOG"
}

@test "no running box at all is not mistaken for a foreign one" {
    # FAKE_OWNER_DIR unset — `docker inspect` exits non-zero, the way it
    # does when the container does not exist. A first update after a
    # `down` must still work.
    upstream_commit "code" lib_a.ex 'defmodule A do def x, do: 8 end'

    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -eq 0 ]
    grep -q 'force-recreate' "$ARGV_LOG"
}

@test "a dirty working tree is refused before anything is pulled or recreated" {
    printf 'scribble\n' >> "$BOX/lib_a.ex"
    upstream_commit "code" mix.lock '%{"phoenix" => "1.9.0"}'

    run "$BOX/scripts/quickstart-update.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"uncommitted"* ]]
    # The ownership guard reads a label off the running container before
    # this check, so the docker log is not empty — but it must contain
    # nothing that CHANGES anything.
    # (the guard's own inspect mentions the compose label namespace, so
    # match the invocation shape, not the word)
    ! grep -q '^docker compose' "$ARGV_LOG"
}
