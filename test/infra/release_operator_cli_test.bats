#!/usr/bin/env bats
#
# The operator CLI that ships AS `bin/grappa` in an assembled release (#1158).
#
# `infra/release/grappa.sh` is installed over the boot script `mix release`
# generates, which moves to `bin/grappa-release`. That makes it the first thing
# EVERY door executes — `docker run`'s entrypoint, a `docker exec`, the packaged
# /usr/bin/grappa, the jail's rc.d — so two properties matter equally:
#
#   * the account verbs reach `Grappa.Release.cli/1` with the operator's words
#     intact, as separate argv elements and never spliced into Elixir source;
#   * everything else reaches the real boot script UNCHANGED. `daemon` is how
#     production starts; a dispatcher that ate it would take the bouncer down
#     on the next restart, on every substrate at once.
#
# The delegate is a recorder stub, so the assertions read what the release
# boot script would actually have received — argv, one element per line, not
# a re-flattened string that would hide exactly the quoting bugs this door
# was written to make impossible.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."

    BIN="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$BIN"

    ARGV_LOG="$BATS_TEST_TMPDIR/argv.log"
    ENTRYPOINT_LOG="$BATS_TEST_TMPDIR/entrypoint.log"
    export ARGV_LOG ENTRYPOINT_LOG
    : >"$ARGV_LOG"
    : >"$ENTRYPOINT_LOG"

    cp "$REPO_SRC/infra/release/grappa.sh" "$BIN/grappa"
    chmod 0755 "$BIN/grappa"

    # The boot script `mix release` generates, recorded. One argv element per
    # line, bracketed, so an empty or space-bearing element is visible.
    cat >"$BIN/grappa-release" <<'EOF'
#!/bin/sh
for arg in "$@"; do printf '[%s]\n' "$arg" >>"$ARGV_LOG"; done
EOF
    chmod 0755 "$BIN/grappa-release"

    # `/app/release-entrypoint.sh` in the published image. A docker-exec'd
    # account verb starts outside that entrypoint, so the wrapper must re-enter
    # it when Docker's configured env has none of the secrets generated into
    # /data at first boot. Record argv here; the entrypoint's own suite pins
    # the safe line parser + operator-precedence behaviour.
    cat >"$BATS_TEST_TMPDIR/release-entrypoint.sh" <<'EOF'
#!/bin/sh
for arg in "$@"; do printf '[%s]\n' "$arg" >>"$ENTRYPOINT_LOG"; done
EOF
    chmod 0755 "$BATS_TEST_TMPDIR/release-entrypoint.sh"

    unset GRAPPA_SUBSTRATE SECRET_KEY_BASE SECRET_SIGNING_SALT RELEASE_COOKIE \
        GRAPPA_ENCRYPTION_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
}

argv() {
    cat "$ARGV_LOG"
}

@test "create-user reaches Grappa.Release.cli with the operator's argv" {
    run "$BIN/grappa" create-user vjt --admin
    [ "$status" -eq 0 ]

    [ "$(argv)" = "[eval]
[Grappa.Release.cli(System.argv())]
[create-user]
[vjt]
[--admin]" ]
}

@test "docker exec account verb re-enters the image entrypoint when first-boot secrets are absent" {
    GRAPPA_SUBSTRATE=docker run "$BIN/grappa" create-user vjt --admin
    [ "$status" -eq 0 ]

    [ "$(cat "$ENTRYPOINT_LOG")" = "[create-user]
[vjt]
[--admin]" ]
    # The release must not boot on the secret-less first pass. The real
    # entrypoint loads /data/grappa.env, then execs this wrapper a second time.
    [ ! -s "$ARGV_LOG" ]
}

@test "a fully configured docker environment delegates directly — operator env wins" {
    export GRAPPA_SUBSTRATE=docker
    for key in SECRET_KEY_BASE SECRET_SIGNING_SALT RELEASE_COOKIE \
        GRAPPA_ENCRYPTION_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
        export "$key=operator-$key"
    done

    run "$BIN/grappa" create-user vjt --admin
    [ "$status" -eq 0 ]

    [ ! -s "$ENTRYPOINT_LOG" ]
    grep -qx '\[create-user\]' "$ARGV_LOG"
    grep -qx '\[--admin\]' "$ARGV_LOG"
}

@test "add-network and remove-network route the same way" {
    run "$BIN/grappa" add-network vjt azzurra --server irc.azzurra.chat:6697
    [ "$status" -eq 0 ]
    grep -qx '\[add-network\]' "$ARGV_LOG"
    grep -qx '\[irc.azzurra.chat:6697\]' "$ARGV_LOG"

    : >"$ARGV_LOG"
    run "$BIN/grappa" remove-network vjt azzurra
    [ "$status" -eq 0 ]
    grep -qx '\[remove-network\]' "$ARGV_LOG"
    grep -qx '\[Grappa.Release.cli(System.argv())\]' "$ARGV_LOG"
}

@test "a password with quotes and spaces survives as ONE argument" {
    # The whole reason the verbs travel as argv instead of being spliced into
    # the eval string. A quote in a password is not exotic, and under string
    # interpolation it would be either a syntax error or, worse, code.
    run "$BIN/grappa" create-user vjt --password "he said \"don't\" & \$RELEASE_COOKIE"
    [ "$status" -eq 0 ]

    grep -qxF '[he said "don'"'"'t" & $RELEASE_COOKIE]' "$ARGV_LOG"

    # And exactly six elements — eval, the expression, and the four the
    # operator typed: no word-splitting into extra arguments.
    [ "$(wc -l <"$ARGV_LOG")" -eq 6 ]
}

@test "daemon passes through untouched — this is how production boots" {
    run "$BIN/grappa" daemon
    [ "$status" -eq 0 ]
    [ "$(argv)" = "[daemon]" ]
}

@test "the release's own eval is not rewritten into another eval" {
    run "$BIN/grappa" eval 'Grappa.Release.migrate()'
    [ "$status" -eq 0 ]

    [ "$(argv)" = "[eval]
[Grappa.Release.migrate()]" ]
}

@test "an unknown verb is the release's to reject, not ours" {
    # The boot script's own error message ("Unknown command frobnicate") is
    # the one an operator has always seen; swallowing it here would make the
    # dispatcher the author of every future usage error.
    run "$BIN/grappa" frobnicate
    [ "$status" -eq 0 ]
    [ "$(argv)" = "[frobnicate]" ]
}

@test "help reaches the account verbs, not the boot script" {
    # `grappa help` is not a release verb — the boot script answers "Unknown
    # command help". Routing it inward is what makes the door discoverable.
    run "$BIN/grappa" help
    [ "$status" -eq 0 ]
    grep -qx '\[Grappa.Release.cli(System.argv())\]' "$ARGV_LOG"
    grep -qx '\[help\]' "$ARGV_LOG"
}

@test "a bare invocation advertises the account verbs and still delegates" {
    run "$BIN/grappa"
    [ "$status" -eq 0 ]

    [[ "$output" == *"create-user"* ]]
    [[ "$output" == *"add-network"* ]]
    # Delegated with NO arguments, so the release prints its own usage too.
    [ -z "$(argv)" ]
}

@test "a missing boot script fails loudly instead of looping" {
    rm "$BIN/grappa-release"
    run "$BIN/grappa" create-user vjt
    [ "$status" -ne 0 ]
    [[ "$output" == *"assembled wrong"* ]]
}

@test "the dispatcher resolves its delegate through a symlink" {
    # A distro that drops /usr/local/bin/grappa as a symlink would otherwise
    # send the dispatcher looking for the boot script in the wrong directory.
    ln -s "$BIN/grappa" "$BATS_TEST_TMPDIR/grappa-link"
    run "$BATS_TEST_TMPDIR/grappa-link" create-user vjt
    [ "$status" -eq 0 ]
    grep -qx '\[create-user\]' "$ARGV_LOG"
}
