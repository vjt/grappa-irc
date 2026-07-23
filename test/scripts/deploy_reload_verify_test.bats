#!/usr/bin/env bats
#
# Bats suite for scripts/deploy.sh HOT path — reload-verify + healthcheck.
#
# #364 docker S6: the Docker hot path just POSTed /admin/reload and printed
# "✓ hot-deploy complete" unconditionally. /admin/reload returns HTTP 200
# even when it reports per-module failures in-band
# (`{"reloaded":[...],"failed":[{"module":..,"reason":..},...]}` —
# :old_code_in_use / :not_purged), so a half-failed reload was declared a
# success and left the stack on stale code. The jail twin (infra/freebsd/deploy.sh)
# already fails the deploy on a non-empty "failed" list and runs a
# post-reload healthcheck. This ports that behavior to the Docker path
# (CLAUDE.md no-silent-swallow).
#
# Scope: shell-side hot-path logic. Runs deploy.sh --force-hot against a
# throwaway git clone (so _lib.sh derives a real SRC_ROOT==REPO_ROOT and
# `git pull --ff-only` is a no-op), with `docker` stubbed on PATH. The
# reload response body is the stubbed `docker compose exec … curl` output
# (deploy.sh reloads via in_container curl, so curl runs "inside" the
# stubbed container — no separate curl stub needed).

setup() {
    DEPLOY_SH="$BATS_TEST_DIRNAME/../../scripts/deploy.sh"
    LIB_SH="$BATS_TEST_DIRNAME/../../scripts/_lib.sh"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    : > "$ARGV_LOG"
    export ARGV_LOG

    # ---- throwaway upstream + clone (real git; only docker is stubbed) --
    # Physical (symlink-resolved) base: on macOS BATS_TEST_TMPDIR lives
    # under /var → /private/var, and _lib.sh derives SRC_ROOT via `pwd`
    # (logical) but REPO_ROOT via `git rev-parse` (physical) — they'd
    # mismatch and trip the worktree guard. pwd -P makes both agree.
    TMP="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    UPSTREAM="$TMP/upstream"
    git init -q -b main "$UPSTREAM"
    git -C "$UPSTREAM" config user.email test@grappa.local
    git -C "$UPSTREAM" config user.name "bats"
    mkdir -p "$UPSTREAM/scripts" "$UPSTREAM/lib" "$UPSTREAM/runtime"
    cp "$DEPLOY_SH" "$UPSTREAM/scripts/deploy.sh"
    cp "$LIB_SH" "$UPSTREAM/scripts/_lib.sh"
    : > "$UPSTREAM/compose.yaml"
    echo base > "$UPSTREAM/lib/base.ex"
    git -C "$UPSTREAM" add -A
    git -C "$UPSTREAM" commit -qm "base"

    REPO="$TMP/repo"
    git clone -q "$UPSTREAM" "$REPO"
    git -C "$REPO" config user.email test@grappa.local
    git -C "$REPO" config user.name "bats"

    # Fast healthcheck loop for tests (prod defaults stay in the script).
    export HOT_HEALTHCHECK_RETRIES=3 HOT_HEALTHCHECK_SLEEP=0

    # ---- docker stub ----------------------------------------------------
    # `ps -q grappa`  → a fake container id (so in_container proceeds).
    # `… reload`      → the reload JSON from $RELOAD_RESPONSE.
    # `… healthz`     → exit $HEALTHZ_RC (0 = ready).
    # everything else → exit 0.
    cat > "$FAKE_DIR/docker" <<EOF
#!/usr/bin/env bash
printf 'docker' >> "$ARGV_LOG"
for a in "\$@"; do printf ' %q' "\$a" >> "$ARGV_LOG"; done
printf '\n' >> "$ARGV_LOG"
args="\$*"
case "\$args" in
    *"ps -q grappa"*) echo "fakecontainerid"; exit 0 ;;
    *reload*)         printf '%s' "\${RELOAD_RESPONSE}"; exit 0 ;;
    *healthz*)        exit "\${HEALTHZ_RC:-0}" ;;
    *)                exit 0 ;;
esac
EOF
    chmod +x "$FAKE_DIR/docker"
    export PATH="$FAKE_DIR:$PATH"
}

run_hot() {
    cd "$REPO"
    run "$REPO/scripts/deploy.sh" --force-hot
}

@test "clean reload (failed:[]) completes and runs a post-reload healthcheck" {
    export RELOAD_RESPONSE='{"reloaded":[],"failed":[]}'
    export HEALTHZ_RC=0

    run_hot
    [ "$status" -eq 0 ]
    [[ "$output" == *"hot-deploy complete"* ]]
    # A post-reload healthcheck must have run (the jail path does one).
    grep -q 'healthz' "$ARGV_LOG"
    # Ordering: reload POST precedes the healthcheck.
    reload_line=$(grep -n 'admin/reload' "$ARGV_LOG" | head -1 | cut -d: -f1)
    hz_line=$(grep -n 'healthz' "$ARGV_LOG" | head -1 | cut -d: -f1)
    [ "$reload_line" -lt "$hz_line" ]
}

@test "reload reporting per-module failures FAILS the deploy (no success, no healthcheck)" {
    # Production shape from AdminController.reload/2: failed entries are
    # `%{module: "...", reason: "..."}` maps, not [mod,reason] pairs.
    export RELOAD_RESPONSE='{"reloaded":["Elixir.Foo"],"failed":[{"module":"Elixir.Bar","reason":":old_code_in_use"}]}'
    export HEALTHZ_RC=0

    run_hot
    [ "$status" -ne 0 ]
    [[ "$output" != *"hot-deploy complete"* ]]
    [[ "$output" == *"failures"* ]]
    # Must bail BEFORE healthchecking a stale-code stack.
    ! grep -q 'healthz' "$ARGV_LOG"
}

@test "reload ok but healthcheck never returns 200 FAILS the deploy" {
    export RELOAD_RESPONSE='{"reloaded":[],"failed":[]}'
    export HEALTHZ_RC=1

    run_hot
    [ "$status" -ne 0 ]
    [[ "$output" != *"hot-deploy complete"* ]]
    grep -q 'healthz' "$ARGV_LOG"
}
