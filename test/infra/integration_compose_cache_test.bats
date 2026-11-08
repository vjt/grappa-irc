#!/usr/bin/env bats
#
# issue 2603 — the `integration` workflow's docker compose plugin cache must be
# FOUND by the runs after the one that saved it, must be writable by any shard
# that downloaded it, and must miss on a version bump.
#
# The cache exists because a 504 from github.com/docker/compose/releases turned
# all four shards red at once (run 42465678187). Of its failure modes, the WRONG
# binary is already loud without this file: the step checks
# `docker compose version --short` against COMPOSE_VER, which reads the binary
# itself and so beats any reading of this YAML. What is NOT loud is a cache that
# never hits. Restore and save each take their own `path:` and `key:`, and
# actions/cache finds an entry by key AND by a version hashed from the `path:`
# TEXT, so a save that drifts from its restore writes entries nobody reads.
# Every run is then a miss that downloads, retries, goes green — and the next
# 504 reddens every shard again with nothing having said the cure was gone.
#
# Prose is kept out twice: comment lines are dropped before a step is
# selected, and every predicate is anchored on a KEY line (`key:`, `path:`,
# `restore-keys:` at line start), never on a substring of the block. The
# fixture's comment spells `${{ env.COMPOSE_VER }}` above a key that does not,
# and measured, that control goes red only with BOTH defences removed — either
# one alone keeps the comment from satisfying the bump predicate. Neither
# defence is exercised on its own.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    WORKFLOW="$REPO_ROOT/.github/workflows/integration.yml"
}

# Every step of FILE whose comment-stripped text contains BOTH needles, each
# followed by a `---` line. A step runs from its `      - ` line to the next
# one, or to the first line indented less than a step.
steps_with() {
    N1="$2" N2="$3" awk '
        function flush() {
            if (blk != "" && index(blk, ENVIRON["N1"]) && index(blk, ENVIRON["N2"])) printf "%s---\n", blk
            blk = ""
        }
        /^[[:space:]]*#/ { next }
        /^      - / { flush(); instep = 1 }
        instep && $0 ~ /[^ ]/ && match($0, /[^ ]/) - 1 < 6 { flush(); instep = 0 }
        instep { blk = blk $0 "\n" }
        END { flush() }
    ' "$1"
}

restore_step() { steps_with "$1" 'uses: actions/cache/restore@' 'id: compose-cache'; }
save_step() { steps_with "$1" 'uses: actions/cache/save@' 'steps.compose-cache.'; }

# A single-line `KEY: value` of a step block, trailing comment and space gone.
key_value() {
    sed -nE "s/^[[:space:]]+$1:[[:space:]]*//p" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//'
}

# THE pair predicate: restore and save name the same cache — one identical
# single-line `path:` (a `|` block would compare "|" to "|" and pass), and the
# save keyed on exactly the key the restore computed.
same_cache() {
    local rp sp sk
    rp="$(key_value path <<<"$1")"
    sp="$(key_value path <<<"$2")"
    sk="$(key_value key <<<"$2")"
    printf 'restore path: %s\nsave path:    %s\nsave key:     %s\n' "$rp" "$sp" "$sk"
    [ -n "$rp" ] && [[ "$rp" != [\|\>]* ]] && [ "$rp" = "$sp" ] &&
        [ "$sk" = '${{ steps.compose-cache.outputs.cache-primary-key }}' ]
}

# THE bump predicate, over the restore KEY value: misses when COMPOSE_VER
# moves, and is never shared across OS or architecture.
key_tracks_pin() {
    [[ "$1" == *'${{ env.COMPOSE_VER }}'* && "$1" == *'${{ runner.os }}'* && "$1" == *'${{ runner.arch }}'* ]]
}

declares_restore_keys() {
    grep -qE '^[[:space:]]+restore-keys:' <<<"$1"
}

# A save gated on ONE shard throws away whatever binary another shard won: on
# run 42469926842 the only writer lost the download and the shard that got a
# 200 was not allowed to save.
gated_on_one_shard() {
    grep -qE '^[[:space:]]+if:.*matrix\.shard' <<<"$1"
}

# A minimal workflow carrying the pair, for aiming the predicates at shapes
# that must fail. $1 = restore key, $2 = restore path, $3 = save path,
# $4 = extra restore line.
fixture() {
    cat >"$BATS_TEST_TMPDIR/wf.yml" <<EOF
jobs:
  e2e:
    steps:
      - name: Restore docker compose plugin
        # keyed on \${{ env.COMPOSE_VER }}, and there is NO restore-keys
        id: compose-cache
        uses: actions/cache/restore@SHA # v6.1.0
        with:
          path: $2
          key: $1
$4
      - name: Save docker compose plugin
        if: steps.compose-cache.outputs.cache-hit != 'true'
        uses: actions/cache/save@SHA # v6.1.0
        with:
          path: $3
          key: \${{ steps.compose-cache.outputs.cache-primary-key }}
EOF
    printf '%s\n' "$BATS_TEST_TMPDIR/wf.yml"
}

GOOD_KEY='${{ runner.os }}-${{ runner.arch }}-docker-compose-${{ env.COMPOSE_VER }}'
GOOD_PATH='~/.docker/cli-plugins/docker-compose'

@test "issue 2603 — the compose plugin is saved under the cache it is restored from" {
    local restore save
    restore="$(restore_step "$WORKFLOW")"
    save="$(save_step "$WORKFLOW")"

    # Exactly one of each: a renamed id would hand the predicate nothing, and
    # two would let it judge the wrong pair.
    [ "$(grep -c '^---$' <<<"$restore")" -eq 1 ]
    [ "$(grep -c '^---$' <<<"$save")" -eq 1 ]

    same_cache "$restore" "$save"

    # Controls through the same extractor: the good pair passes, a drifted
    # save path does not, and neither does a `|` block on BOTH sides — the
    # one-line reader sees "|" twice, so only the block-scalar clause can
    # refuse it.
    wf="$(fixture "$GOOD_KEY" "$GOOD_PATH" "$GOOD_PATH" '')"
    same_cache "$(restore_step "$wf")" "$(save_step "$wf")"
    wf="$(fixture "$GOOD_KEY" "$GOOD_PATH" '~/.docker/cli-plugins/' '')"
    refute same_cache "$(restore_step "$wf")" "$(save_step "$wf")"
    wf="$(fixture "$GOOD_KEY" '|' '|' '')"
    refute same_cache "$(restore_step "$wf")" "$(save_step "$wf")"
}

@test "issue 2603 — any shard that downloaded the compose plugin may save it" {
    local save
    save="$(save_step "$WORKFLOW")"
    [ "$(grep -c '^---$' <<<"$save")" -eq 1 ]

    refute gated_on_one_shard "$save"

    # The shape this replaced, as a control: the predicate must fire on it.
    gated_on_one_shard "        if: matrix.shard == 1 && steps.compose-cache.outputs.cache-hit != 'true'"
}

@test "issue 2603 — a COMPOSE_VER bump misses the compose cache" {
    local restore
    restore="$(restore_step "$WORKFLOW")"
    [ "$(grep -c '^---$' <<<"$restore")" -eq 1 ]

    key_tracks_pin "$(key_value key <<<"$restore")"
    # A prefix match would restore the previous version's binary on a bump.
    refute declares_restore_keys "$restore"

    # The key deleted, its comment kept: the comment still spells
    # `${{ env.COMPOSE_VER }}`, and the predicate must not hear it.
    wf="$(fixture '${{ runner.os }}-${{ runner.arch }}-docker-compose' "$GOOD_PATH" "$GOOD_PATH" '')"
    refute key_tracks_pin "$(key_value key <<<"$(restore_step "$wf")")"
    # The predicate fires on a real restore-keys line and on nothing else.
    wf="$(fixture "$GOOD_KEY" "$GOOD_PATH" "$GOOD_PATH" '')"
    refute declares_restore_keys "$(restore_step "$wf")"
    wf="$(fixture "$GOOD_KEY" "$GOOD_PATH" "$GOOD_PATH" '          restore-keys: ${{ runner.os }}-')"
    declares_restore_keys "$(restore_step "$wf")"
}
