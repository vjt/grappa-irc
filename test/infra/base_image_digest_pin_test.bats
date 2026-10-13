#!/usr/bin/env bats
#
# Bats suite for GH #103 — supply-chain: the moving base-image tags
# (`oven/bun` and `nginx:alpine`) MUST be pinned to a
# content digest (`image:tag@sha256:...`) for reproducible builds.
#
# `oven/bun:1` is a MAJOR-moving tag (it advances across bun majors) and
# `nginx:alpine` floats `alpine`; a bare tag means two builds a week apart can
# pull different bytes. Pinning the multi-arch INDEX digest (the tag's
# registry digest) still resolves per-platform, so linux/amd64 (CI) and
# linux/arm64 (dev host) both keep working — the pin only removes the drift.
#
# This is the drift GUARD, not the pin itself: it fails the moment any real
# image reference to those families loses its `@sha256:` — the regression the
# issue exists to prevent. It reads the worktree's tracked build files via
# `git grep`, so it verifies the change under test (not MAIN). Comment lines
# (prose, and the `# Refresh: docker buildx imagetools inspect …` hints) and
# the docs/test trees (which name the tags in prose) are excluded — only
# ACTUAL image references are held to the pin.
#
# Refresh a pin when intentionally bumping the base image:
#   docker buildx imagetools inspect <tag> --format '{{.Manifest.Digest}}'

REPO_ROOT="$BATS_TEST_DIRNAME/../.."

# The families this gate covers, as ONE string — the regex below and the
# runbook's description of it both read from here (#1408 D-S9).
#
# It is deliberately NOT every image reference in the tree, and the last
# test in this file is what stops the runbook from claiming otherwise.
# What is left out, and why:
#
#   - `elixir:1.19-otp-28-alpine` (Dockerfile, Dockerfile.release) — the
#     TAG carries the pin. It floats the alpine minor by design and the
#     Elixir PATCH as a side effect, which is the toolchain-carrier
#     problem, gated by test/infra/toolchain_pin_test.bats, not by a
#     digest.
#   - `alpine:3.24` (Dockerfile.release, Dockerfile.shottino) — an
#     argued FLOOR, not a mirror of the build base; a digest would
#     freeze it and stop security patches flowing. Proved instead by
#     infra/docker/assert-abi-lockstep.sh.
#   - locally built images (`grappa:latest`, `grappa:e2e`,
#     `grappa-shottino:latest`, `grappa-e2e-push-catcher:dev`) — never
#     pulled, so there are no bytes to pin.
#   - own-org tags resolved from a variable (`ghcr.io/vjt/bahamut`,
#     `ghcr.io/vjt/services`, `ghcr.io/vjt/grappa`) — a literal digest
#     cannot express `${BAHAMUT_TAG:-main}`.
#   - e2e-only third parties (`debian:trixie`, `node:22-alpine`,
#     `alpine:3.20`, `axllent/mailpit`, the playwright runner base) —
#     test-fixture images that never reach an operator.
#
# Adding a family here REQUIRES amending the runbook line the last test
# reads; that is the whole point of the pin.
PINNED_FAMILIES='oven/bun:|nginx:alpine'

# Every reference to a pinned family in tracked build files, minus comments
# and the docs/test prose trees. git grep -n → `path:line:content`.
matched_refs() {
    git -C "$REPO_ROOT" grep -nE "$PINNED_FAMILIES" -- \
        '*.sh' '*.yaml' '*.yml' '*Dockerfile*' ':!docs/**' ':!test/**' 2>/dev/null \
        | while IFS= read -r line; do
            content="${line#*:*:}"                        # strip `path:line:`
            trimmed="$(printf '%s' "$content" | sed 's/^[[:space:]]*//')"
            case "$trimmed" in
                \#*) continue ;;                          # comment line — prose
            esac
            printf '%s\n' "$line"
        done
}

@test "every oven/bun and nginx:alpine image reference is digest-pinned (#103)" {
    refs="$(matched_refs)"

    # Guard against a vacuous pass: if the grep matches nothing the assertion
    # below would trivially "pass". We KNOW there are ≥4 real references
    # (scripts/bun.sh, compose.yaml, Dockerfile.release, e2e compose ×2).
    count="$(printf '%s\n' "$refs" | grep -c . || true)"
    [ "$count" -ge 4 ] || {
        echo "expected >=4 real base-image references, found $count — grep/filter is wrong:" >&2
        printf '%s\n' "$refs" >&2
        return 1
    }

    violations="$(printf '%s\n' "$refs" | grep -v '@sha256:' || true)"
    [ -z "$violations" ] || {
        echo "UNPINNED moving base-image reference(s) — pin to @sha256: (#103):" >&2
        printf '%s\n' "$violations" >&2
        return 1
    }
}

# Every `image:tag@sha256:<digest>` token in the reference set above, one per
# line. Splitting on `@sha256:` keeps `oven/bun:1.3.14` and `oven/bun:1.3.14-alpine`
# distinct families — they are different images and carry different digests.
pinned_tokens() {
    matched_refs | grep -oE '[a-z0-9./_-]+:[a-zA-Z0-9._-]+@sha256:[0-9a-f]{64}'
}

@test "all references to one image:tag carry the SAME digest (#1343)" {
    # `oven/bun:1.3.14` is transcribed four times (compose.yaml, scripts/bun.sh,
    # .github/workflows/ci.yml, cicchetto/e2e/compose.yaml) and ci.yml states
    # the equality in prose only — the shape #441 rejected. It matters beyond
    # tidiness: scripts/bun.sh and compose.yaml bind the SAME host bun cache
    # (runtime/bun-cache, docs/OPERATIONS.md), so a bump that touches three of
    # the four surfaces as a lockfile/cache disagreement in CI, never as a
    # "wrong image" error.
    tokens="$(pinned_tokens)"
    families="$(printf '%s\n' "$tokens" | sed 's/@sha256:.*//' | sort -u)"

    multi_ref_families=0
    conflicts=""

    for family in $families; do
        refs="$(printf '%s\n' "$tokens" | grep -cF -- "$family@sha256:")"
        digests="$(printf '%s\n' "$tokens" | grep -F -- "$family@sha256:" | sed 's/.*@sha256://' | sort -u)"

        [ "$refs" -ge 2 ] && multi_ref_families=$((multi_ref_families + 1))

        if [ "$(printf '%s\n' "$digests" | grep -c .)" -gt 1 ]; then
            # Name the FILES, not just the family (#1377). The four oven/bun:1.3.14
            # references are textually identical, so a report of "these two
            # digests disagree" leaves the reader to grep for which of four
            # surfaces was bumped and which were not — and the whole point of
            # the failure is that they are easy to miss one at a time.
            conflicts="${conflicts}${family}: $(printf '%s' "$digests" | tr '\n' ' ')
$(matched_refs | grep -F -- "$family@sha256:" | sed 's/^/    /')
"
        fi
    done

    # Guard against a vacuous pass, same reasoning as the count check above:
    # with every family down to a single reference this test asserts nothing.
    [ "$multi_ref_families" -ge 1 ] || {
        echo "no image:tag is referenced twice — the equality assertion is vacuous:" >&2
        printf '%s\n' "$tokens" >&2
        return 1
    }

    [ -z "$conflicts" ] || {
        echo "DIVERGENT digests for the same image:tag — bump every surface together (#1343):" >&2
        printf '%s' "$conflicts" >&2
        return 1
    }
}

@test "pinned base-image digests are well-formed sha256:<64 lowercase hex> (#103)" {
    # A truncated or typo'd digest would fail the pull loudly at build time,
    # but catching it here turns a slow CI-build failure into a fast unit fail.
    # NB: `git grep -o` prefixes a line number (`<n>:<match>`) even with -h, so
    # extract the token with a plain `grep -oE` over the matching lines instead.
    bad="$(git -C "$REPO_ROOT" grep -hE '@sha256:' -- \
              '*.sh' '*.yaml' '*.yml' '*Dockerfile*' ':!docs/**' ':!test/**' 2>/dev/null \
           | grep -oE '@sha256:[0-9a-zA-Z]+' \
           | grep -vE '^@sha256:[0-9a-f]{64}$' || true)"
    [ -z "$bad" ] || {
        echo "malformed digest(s) — expected sha256:<64 lowercase hex>:" >&2
        printf '%s\n' "$bad" >&2
        return 1
    }
}

@test "the runbook quotes this gate's family pattern verbatim (#1408)" {
    # D-S9: the runbook used to describe this suite as failing "if any real
    # image reference in a tracked build file loses its @sha256:". It covers
    # two families. Ten-odd references sit outside them — the Elixir
    # toolchain base among them — each for a reason recorded above, and none
    # of them guarded by this file.
    #
    # An over-claimed gate is worse than a narrow one: the narrow gate at
    # least tells the truth about what it will catch. So the runbook now
    # carries the pattern ITSELF, byte-for-byte, and this is the pin that
    # keeps the two equal. Widen PINNED_FAMILIES and the sentence describing
    # it must move in the same commit.
    local runbook="$REPO_ROOT/docs/OPERATIONS.md"

    grep -qF -- "$PINNED_FAMILIES" "$runbook" || {
        printf 'docs/OPERATIONS.md does not quote this gate'"'"'s pattern.\n' >&2
        printf 'expected the literal string: %s\n' "$PINNED_FAMILIES" >&2
        printf 'nearby runbook text:\n' >&2
        grep -n 'base_image_digest_pin_test' "$runbook" >&2 || true
        return 1
    }
}

@test "every oven/bun reference names ONE exact bun version in its tag (issue 2364)" {
    # A digest pins bytes, but a MOVING tag in front of it hides which bun the
    # bytes are. Dockerfile.release pinned `oven/bun:1-alpine` at a digest
    # that was bun 1.4.2 while CI and scripts/bun.sh tested on a
    # `oven/bun:1` digest that was 1.3.14 — two pins, two versions, and
    # nothing that could compare them, because the debian and alpine
    # variants of one release carry DIFFERENT digests by construction (the
    # same-digest test above cannot span them). The release bundle was built
    # with a bun the test suite never ran on.
    #
    # So every oven/bun tag must spell the exact version, `X.Y.Z` or
    # `X.Y.Z-alpine`, and they must all spell the SAME one. What this cannot
    # prove offline is that a digest really belongs to its tag; the refresh
    # command in each file's comment is what keeps that honest.
    tags="$(pinned_tokens | grep -E '^oven/bun:' | sed -e 's/@sha256:.*//' -e 's|^oven/bun:||')"

    [ "$(printf '%s\n' "$tags" | grep -c .)" -ge 2 ] || {
        echo "expected >=2 oven/bun references, found: $tags" >&2
        return 1
    }

    loose="$(printf '%s\n' "$tags" | grep -vE '^[0-9]+\.[0-9]+\.[0-9]+(-alpine)?$' || true)"
    [ -z "$loose" ] || {
        echo "oven/bun tag(s) without an exact X.Y.Z version — the digest hides which bun it is:" >&2
        matched_refs | grep -E 'oven/bun:' | grep -vE 'oven/bun:[0-9]+\.[0-9]+\.[0-9]+(-alpine)?@' | sed 's/^/    /' >&2
        return 1
    }

    versions="$(printf '%s\n' "$tags" | sed 's/-alpine$//' | sort -u)"
    [ "$(printf '%s\n' "$versions" | grep -c .)" -eq 1 ] || {
        echo "oven/bun references disagree on the bun version: $(printf '%s' "$versions" | tr '\n' ' ')" >&2
        matched_refs | grep -E 'oven/bun:' | sed 's/^/    /' >&2
        return 1
    }
}
