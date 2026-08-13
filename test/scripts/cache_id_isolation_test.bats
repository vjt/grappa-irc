#!/usr/bin/env bats
#
# Bats suite for scripts/_lib.sh — GRAPPA_CACHE_ID, the opt-in per-worker
# build cache (#1263).
#
# WHY THIS EXISTS
#
# `_lib.sh` resolves REPO_ROOT through `--git-common-dir`, so every worktree
# on a host binds the MAIN repo's `_build`, `deps` and `priv/plts`. That
# sharing is deliberate, and it is also the reason two workers cannot compile
# at the same time: the orchestrator has to hand out an exclusive COMPILE
# lane and one worker sits idle. GRAPPA_CACHE_ID buys isolation for whoever
# asks for it, and changes NOTHING for whoever does not.
#
# Scope: asserts the SHAPE of the docker invocation — which host paths get
# bound over /app/_build, /app/deps, /app/priv/plts, and which env crosses
# the boundary. Stubs `docker` on PATH so no container is touched. This
# proves the MAPPING is isolated; it does not prove two real gates run
# concurrently, which only a live pair of runs can show.

load ../bats_helpers

setup() {
    MIX_SH="$BATS_TEST_DIRNAME/../../scripts/mix.sh"
    REPO="$(cd "$BATS_TEST_DIRNAME/../.." && git rev-parse --path-format=absolute --git-common-dir | sed 's|/\.git$||')"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"

    # Fake `docker` — records every invocation and, for `compose ... ps -q
    # grappa`, prints a container id so the live-exec branch of
    # in_container_or_oneshot is REACHABLE. Without that id every call
    # falls through to oneshot and a test asserting "no exec" would hold
    # vacuously.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
for a in "\$@"; do
    if [ "\$a" = "-q" ]; then
        printf 'fakecid\n'
        exit 0
    fi
done
exit 0
EOF
    chmod +x "$FAKE_DIR/docker"

    export PATH="$FAKE_DIR:$PATH"
    unset GRAPPA_CACHE_ID MIX_TEST_PARTITION
}

# A throwaway repo shaped like a MAIN checkout: `lib/` plus `.git` as a
# DIRECTORY (a worktree has `.git` as a FILE — that is the marker _lib.sh
# disambiguates on). Used by the two tests that need SRC_ROOT == REPO_ROOT,
# which is the only configuration where the live-exec branch is taken.
#
# The path must be PHYSICAL: on macOS $TMPDIR lives under /var/folders, a
# symlink to /private/var/folders. `pwd` in _lib.sh yields the logical path
# while `git rev-parse --path-format=absolute` yields the resolved one, so a
# logical fixture path makes SRC_ROOT != REPO_ROOT and the fixture silently
# becomes a WORKTREE — never reaching the branch it was built to exercise.
make_main_checkout() {
    local root
    root="$(cd "$BATS_TEST_TMPDIR" && pwd -P)/mainrepo"
    mkdir -p "$root/lib" "$root/scripts"
    git -C "$root" init -q
    cp "$BATS_TEST_DIRNAME/../../scripts/_lib.sh" "$root/scripts/_lib.sh"
    cp "$BATS_TEST_DIRNAME/../../scripts/mix.sh" "$root/scripts/mix.sh"
    chmod +x "$root/scripts/mix.sh"
    printf '%s' "$root"
}

# A throwaway WORKTREE, the sibling fixture: `lib/` plus `.git` as a FILE,
# produced by a real `git worktree add` so `--git-common-dir` resolves to the
# base repo exactly as it does in production. Same physical-path requirement
# as above, for the same reason.
make_worktree_checkout() {
    local base wt
    base="$(cd "$BATS_TEST_TMPDIR" && pwd -P)/wtbase"
    wt="$(cd "$BATS_TEST_TMPDIR" && pwd -P)/wtree"
    mkdir -p "$base/lib" "$base/scripts"
    : > "$base/lib/.keep"
    cp "$BATS_TEST_DIRNAME/../../scripts/_lib.sh" "$base/scripts/_lib.sh"
    cp "$BATS_TEST_DIRNAME/../../scripts/mix.sh" "$base/scripts/mix.sh"
    chmod +x "$base/scripts/mix.sh"
    git -C "$base" init -q
    git -C "$base" add -A
    git -C "$base" -c user.email=bats@example.invalid -c user.name=bats commit -q -m fixture
    git -C "$base" worktree add -q "$wt" -b probe
    printf '%s' "$wt"
}

# The knob-unset case is the ONLY one here whose docker branch depends on the
# checkout it runs FROM: every other case sets the knob, and the knob forces a
# oneshot in either layout. So this one has to say which layout it means, and
# it used to run from the ambient cwd instead — green on a worktree host,
# where `check.sh` runs, and RED in CI, where the checkout is a main tree and
# the stubbed `docker compose ps -q` hands back a container id, so
# `in_container_or_oneshot` took the exec branch and never emitted the oneshot
# form. Nothing was wrong with the code: unset means "today's invocation", and
# on a main checkout with a live container today's invocation IS the exec. The
# assertion was reading a property of the host, not of the knob.
@test "unset GRAPPA_CACHE_ID from a WORKTREE: no cache bind, no partition — today's invocation" {
    root="$(make_worktree_checkout)"
    cd "$root"
    run "$root/scripts/mix.sh" --env=dev compile
    [ "$status" -eq 0 ]
    refute grep -q '\.caches' "$ARGV_LOG"
    refute grep -q 'MIX_TEST_PARTITION' "$ARGV_LOG"
    # Still a oneshot with the worktree source overrides — unchanged. The
    # second grep is also the fixture's own witness: WORKTREE_VOLUMES is empty
    # unless SRC_ROOT != REPO_ROOT, so a fixture that silently resolved as a
    # main checkout would fail here instead of passing for the wrong reason.
    grep -q 'run --rm --no-deps' "$ARGV_LOG"
    grep -q -- "-v ${root}/lib:/app/lib" "$ARGV_LOG"
}

@test "GRAPPA_CACHE_ID binds _build, deps and priv/plts under a per-id root" {
    GRAPPA_CACHE_ID=w2 run "$MIX_SH" --env=dev compile
    [ "$status" -eq 0 ]
    grep -q -- "-v ${REPO}/.caches/w2/_build:/app/_build" "$ARGV_LOG"
    grep -q -- "-v ${REPO}/.caches/w2/deps:/app/deps" "$ARGV_LOG"
    grep -q -- "-v ${REPO}/.caches/w2/priv/plts:/app/priv/plts" "$ARGV_LOG"
}

@test "GRAPPA_CACHE_ID creates the cache root on the host before binding it" {
    # Docker would otherwise create the missing path itself — as root on
    # Linux, which the UID-dropped container then cannot write.
    GRAPPA_CACHE_ID=mkdirprobe run "$MIX_SH" --env=dev compile
    [ "$status" -eq 0 ]
    [ -d "$REPO/.caches/mkdirprobe/_build" ]
    [ -d "$REPO/.caches/mkdirprobe/deps" ]
    [ -d "$REPO/.caches/mkdirprobe/priv/plts" ]
    rm -rf "${REPO:?}/.caches/mkdirprobe"
}

@test "two ids never reach into each other's cache root" {
    GRAPPA_CACHE_ID=w1 run "$MIX_SH" --env=dev compile
    [ "$status" -eq 0 ]
    grep -q -- "${REPO}/.caches/w1/_build" "$ARGV_LOG"
    refute grep -q -- "${REPO}/.caches/w2/" "$ARGV_LOG"
    # And the shared root is no longer what /app/_build resolves to.
    refute grep -q -- "-v ${REPO}/_build:/app/_build" "$ARGV_LOG"
}

@test "GRAPPA_CACHE_ID crosses into the container as MIX_TEST_PARTITION" {
    # config/test.exs builds the sqlite path from MIX_TEST_PARTITION, but
    # nothing on the shell side ever set or FORWARDED it — so two isolated
    # caches would still have fought over one runtime/grappa_test.db.
    GRAPPA_CACHE_ID=w2 run "$MIX_SH" --env=test test
    [ "$status" -eq 0 ]
    grep -q -- '-e MIX_TEST_PARTITION=w2' "$ARGV_LOG"
}

@test "an explicit MIX_TEST_PARTITION wins over the id-derived one" {
    GRAPPA_CACHE_ID=w2 MIX_TEST_PARTITION=custom run "$MIX_SH" --env=test test
    [ "$status" -eq 0 ]
    grep -q -- '-e MIX_TEST_PARTITION=custom' "$ARGV_LOG"
    refute grep -q -- '-e MIX_TEST_PARTITION=w2' "$ARGV_LOG"
}

@test "a traversing GRAPPA_CACHE_ID is refused BEFORE docker is invoked" {
    GRAPPA_CACHE_ID='../../etc' run "$MIX_SH" --env=dev compile
    [ "$status" -ne 0 ]
    [[ "$output" == *"GRAPPA_CACHE_ID"* ]]
    # The refusal must precede the side effect, not follow it.
    [ ! -s "$ARGV_LOG" ]
}

@test "a GRAPPA_CACHE_ID with a shell metacharacter is refused" {
    GRAPPA_CACHE_ID='w2;touch /tmp/pwned' run "$MIX_SH" --env=dev compile
    [ "$status" -ne 0 ]
    [ ! -s "$ARGV_LOG" ]
}

@test "on a MAIN checkout with a live container and NO knob, the container is exec'd" {
    # The reference box for the next test: proves this fixture DOES reach
    # the live-exec branch, so "no exec" below is a real observation.
    root="$(make_main_checkout)"
    cd "$root"
    run "$root/scripts/mix.sh" --env=dev compile
    [ "$status" -eq 0 ]
    grep -q 'compose .* exec' "$ARGV_LOG"
}

@test "on a MAIN checkout with a live container, the knob FORCES a oneshot" {
    # An exec enters a container whose /app/_build is already bound to the
    # shared tree; there is no remounting an existing container. Asking for
    # an isolated cache and silently getting the shared one is the one
    # failure this knob must never have.
    root="$(make_main_checkout)"
    cd "$root"
    GRAPPA_CACHE_ID=w2 run "$root/scripts/mix.sh" --env=dev compile
    [ "$status" -eq 0 ]
    refute grep -q 'compose .* exec' "$ARGV_LOG"
    grep -q 'run --rm --no-deps' "$ARGV_LOG"
    grep -q -- "-v ${root}/.caches/w2/_build:/app/_build" "$ARGV_LOG"
}
