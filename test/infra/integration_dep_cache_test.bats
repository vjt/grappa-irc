#!/usr/bin/env bats
#
# Bats suite for GH #1630 — the `integration` workflow's Elixir dep cache
# must never carry a branch-specific build artefact, and must never share a
# key namespace with `ci.yml`'s.
#
# Both invariants are one edit away from being lost, and both fail SILENTLY.
#
# 1. CONTAMINATION. CLAUDE.md documents the class: a `_build` shared between
#    worktrees produced a red that belonged to no branch (#1170 — a
#    `Grappa.Version` compiled from another tree's `VERSION`). A CI cache is
#    that same shape at GitHub scale. The step's defence is not a cleverer
#    key, it is that nothing branch-specific is ever WRITTEN: the cache holds
#    `deps/` and the deps' beams, both a pure function of files that are
#    themselves in the key. Widening the path list to a bare `_build` would
#    restore the whole class, and nothing would go red — a run would just
#    quietly be judging artefacts compiled from another commit's source.
#
# 2. ABI. These beams are built inside `elixir:1.19-otp-28-alpine`; ci.yml's
#    are built by setup-beam on glibc ubuntu. `exqlite` and `argon2_elixir`
#    ship NIFs, and mix rebuilds a NIF on ABSENCE, not on ABI — so a restore
#    that crossed the two would hand the alpine container a glibc `.so` that
#    mix considers built and will not replace. The namespaces are disjoint by
#    construction (`-mix-` vs `-e2e-musl-mix-`) and a `restore-keys` prefix
#    added on either side could quietly bridge them.
#
# The path-list checks compare the restore step's list against the save
# step's rather than against a transcribed copy: `actions/cache/save` takes
# its own `path:`, so the two can drift apart, and a cache saved over a wider
# path than it is restored from is exactly how the app's beams would sneak
# back in.
#
# STATED LIMIT of the collision check: it compares the key strings as WRITTEN,
# with `${{ }}` unexpanded. It therefore catches the namespace being widened
# or renamed into the other's — the way a collision would actually be
# introduced — but not two literals that differ in source and coincide only
# after expansion. Expanding them would need a runner.

load ../bats_helpers

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
    INTEGRATION="$REPO_ROOT/.github/workflows/integration.yml"
    CI="$REPO_ROOT/.github/workflows/ci.yml"
}

# Every `path: |` block scalar in a workflow, entries trimmed, blocks
# separated by a `---` line. The single-line `path:` of the four
# upload-artifact steps is a different shape and is deliberately not matched.
path_blocks() {
    awk '
        /^[[:space:]]*path:[[:space:]]*\|[[:space:]]*$/ {
            indent = match($0, /[^ ]/) - 1
            inblock = 1
            print "---"
            next
        }
        inblock {
            if ($0 ~ /^[[:space:]]*$/) { inblock = 0; next }
            if (match($0, /[^ ]/) - 1 <= indent) { inblock = 0; next }
            entry = $0
            sub(/^[[:space:]]+/, "", entry)
            print entry
            next
        }
    ' "$1"
}

# Every cache key literal: the `key:` one-liners plus every entry of a
# `restore-keys: |` block. One per line, leading/trailing space stripped.
cache_keys() {
    awk '
        /^[[:space:]]*key:[[:space:]]/ {
            entry = $0
            sub(/^[[:space:]]*key:[[:space:]]*/, "", entry)
            print entry
            next
        }
        /^[[:space:]]*restore-keys:[[:space:]]*\|[[:space:]]*$/ {
            indent = match($0, /[^ ]/) - 1
            inblock = 1
            next
        }
        inblock {
            if ($0 ~ /^[[:space:]]*$/) { inblock = 0; next }
            if (match($0, /[^ ]/) - 1 <= indent) { inblock = 0; next }
            entry = $0
            sub(/^[[:space:]]+/, "", entry)
            sub(/[[:space:]]+$/, "", entry)
            print entry
            next
        }
    ' "$1"
}

@test "the e2e dep cache restores and saves the SAME path list (#1630)" {
    blocks="$(path_blocks "$INTEGRATION")"

    # Anti-vacuity: two blocks, no more and no fewer. A third cache step, or
    # a parser that matched nothing, must not slip past the comparison below.
    count="$(printf '%s\n' "$blocks" | grep -c '^---$' || true)"
    [ "$count" -eq 2 ] || {
        echo "expected exactly 2 'path: |' blocks in integration.yml, found $count:" >&2
        printf '%s\n' "$blocks" >&2
        return 1
    }

    restore="$(printf '%s\n' "$blocks" | awk '/^---$/ { n++; next } n == 1')"
    save="$(printf '%s\n' "$blocks" | awk '/^---$/ { n++; next } n == 2')"

    [ -n "$restore" ] || { echo "the restore step's path list is empty" >&2; return 1; }
    [ "$restore" = "$save" ] || {
        echo "cache/restore and cache/save disagree on 'path:' (#1630)." >&2
        echo "A save wider than its restore is how the app's own beams get" >&2
        echo "into the cache without anything going red." >&2
        echo "--- restore ---" >&2; printf '%s\n' "$restore" >&2
        echo "--- save ---" >&2;    printf '%s\n' "$save" >&2
        return 1
    }
}

@test "the e2e dep cache never carries grappa's own build dir (#1630)" {
    # The app's beams are branch-specific — that is the #1170 class. They are
    # also worthless to cache: `actions/checkout` writes every source with
    # mtime=now, newer than any restored manifest, so mix recompiles the app
    # regardless. Excluding them costs nothing and closes the class.
    restore="$(path_blocks "$INTEGRATION" | awk '/^---$/ { n++; next } n == 1')"

    printf '%s\n' "$restore" | grep -qxF '!_build/dev/lib/grappa' || {
        echo "the '!_build/dev/lib/grappa' exclusion is gone (#1630):" >&2
        printf '%s\n' "$restore" >&2
        return 1
    }

    # Any UNNEGATED entry that contains the app's build dir reinstates it,
    # whichever spelling is used to get there.
    while IFS= read -r entry; do
        case "$entry" in
            '!'*) continue ;;
            _build | _build/ | _build/dev | _build/dev/ | _build/dev/lib/grappa*)
                echo "cache path '$entry' carries _build/dev/lib/grappa (#1630)." >&2
                echo "A CI cache of the app's own beams is #1170 at GitHub scale:" >&2
                echo "artefacts compiled from another commit's source, restored" >&2
                echo "onto yours, going green for reasons that are not yours." >&2
                return 1
                ;;
        esac
    done <<<"$restore"
}

@test "the e2e cache keys cannot collide with ci.yml's glibc ones (#1630)" {
    e2e_keys="$(cache_keys "$INTEGRATION")"
    ci_keys="$(cache_keys "$CI")"

    # Anti-vacuity on both sides: ci.yml carries the mix, PLT and bun caches;
    # integration.yml carries this one. An empty side would pass silently.
    # Counted by THIS cache's namespace, not by line: integration.yml also
    # carries the compose plugin's keys (issue 2603), which alone would
    # satisfy a bare count with the mix keys unparsed.
    [ "$(grep -cF -- '-e2e-musl-mix-' <<<"$e2e_keys" || true)" -ge 2 ] || {
        echo "found <2 e2e-musl-mix keys in integration.yml — the parser is wrong:" >&2
        printf '%s\n' "$e2e_keys" >&2
        return 1
    }
    [ "$(printf '%s\n' "$ci_keys" | grep -c . || true)" -ge 4 ] || {
        echo "found <4 cache keys in ci.yml — the parser is wrong:" >&2
        printf '%s\n' "$ci_keys" >&2
        return 1
    }

    # `restore-keys` is PREFIX matching, so the two namespaces collide the
    # moment either side's key starts with the other side's. Compare both
    # directions over the full cross product — a one-directional check would
    # miss a prefix added on the ci.yml side.
    while IFS= read -r a; do
        [ -n "$a" ] || continue
        while IFS= read -r b; do
            [ -n "$b" ] || continue
            case "$a" in "$b"*) ;; *) case "$b" in "$a"*) ;; *) continue ;; esac ;; esac
            echo "cache key namespaces overlap (#1630):" >&2
            echo "  integration.yml: $a" >&2
            echo "  ci.yml:          $b" >&2
            echo "One set of beams is built under alpine/musl and the other" >&2
            echo "by setup-beam on glibc; exqlite and argon2_elixir ship NIFs" >&2
            echo "that mix rebuilds on absence, not on ABI." >&2
            return 1
        done <<<"$ci_keys"
    done <<<"$e2e_keys"
}
