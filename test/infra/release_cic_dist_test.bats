#!/usr/bin/env bats
#
# issue 2642 — the attested cicchetto bundle a release carries, in two halves.
#
#   1. infra/packaging/release_cic_dist.sh, the logic: the per-file manifest, the
#      tarball that extracts to the same tree, and the attestation subjects.
#      Pure shell, exercised on a real directory tree.
#   2. release.yml's `cic` job, the wiring: tag push only, scoped permissions,
#      a full-history checkout, the pinned build, the subjects handed to the
#      attest action, and nothing uploaded past a failed attestation. Read off
#      the recipe with comment lines dropped, so a step that survives only as a
#      comment does not count.
#
# What these cases CANNOT claim: that the attest action accepts the subjects on
# a real runner, or that the runner's build matches a local one. Neither has
# run yet; the first tag push after this lands is the first run.

load ../bats_helpers

setup() {
    REPO_SRC="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    SCRIPT="$REPO_SRC/infra/packaging/release_cic_dist.sh"
    WORKFLOW="$REPO_SRC/.github/workflows/release.yml"

    # A dist shaped like vite's: hashed assets with their maps, the service
    # worker, a nested public dir. `Zeta` sorts BEFORE `alpha` in the C locale
    # and after it in most others, so the order assertion below can tell.
    DIST="$BATS_TEST_TMPDIR/dist"
    mkdir -p "$DIST/assets" "$DIST/radio-logos"
    printf '<!doctype html><script src="/assets/index-AbC1.js"></script>\n' > "$DIST/index.html"
    printf 'console.log("cic")\n' > "$DIST/assets/index-AbC1.js"
    printf '{"version":3}\n' > "$DIST/assets/index-AbC1.js.map"
    printf 'z\n' > "$DIST/assets/Zeta-Q9.js"
    printf 'a\n' > "$DIST/assets/alpha-R2.js"
    printf 'self.addEventListener("fetch",()=>{})\n' > "$DIST/service-worker.js"
    printf 'PNG\n' > "$DIST/radio-logos/soma.png"
}

# The bare sha256 hex of a file.
hex_of() {
    local out
    out="$(sha256sum "$1")"
    printf '%s' "${out%% *}"
}

@test "issue 2642 — manifest: one line per file, relative paths, C order, and sha256sum -c accepts it" {
    run "$SCRIPT" manifest "$DIST"
    [ "$status" -eq 0 ]

    expected="$(printf '%s  %s\n' \
        "$(hex_of "$DIST/assets/Zeta-Q9.js")" assets/Zeta-Q9.js \
        "$(hex_of "$DIST/assets/alpha-R2.js")" assets/alpha-R2.js \
        "$(hex_of "$DIST/assets/index-AbC1.js")" assets/index-AbC1.js \
        "$(hex_of "$DIST/assets/index-AbC1.js.map")" assets/index-AbC1.js.map \
        "$(hex_of "$DIST/index.html")" index.html \
        "$(hex_of "$DIST/radio-logos/soma.png")" radio-logos/soma.png \
        "$(hex_of "$DIST/service-worker.js")" service-worker.js)"
    [ "$output" = "$expected" ]

    # The outcome a verifier depends on: checked from inside the tree, it passes.
    printf '%s\n' "$output" > "$BATS_TEST_TMPDIR/m.sha256"
    (cd "$DIST" && sha256sum -c "$BATS_TEST_TMPDIR/m.sha256" >/dev/null)
}

@test "issue 2642 — manifest: the order is C's under a collating locale too" {
    # The manifest is compared ACROSS hosts (CI writes it, a deploy or a
    # third party checks against it), so the caller's locale must not reorder
    # it. Under the C collation every host already agrees, which is why this
    # needs a locale that sorts `alpha` before `Zeta` to mean anything.
    local loc="" l
    for l in en_US.UTF-8 en_US.utf8; do
        if [ "$(printf 'Zeta\nalpha\n' | LC_ALL="$l" sort | head -n 1)" = alpha ]; then
            loc="$l"
            break
        fi
    done
    [ -n "$loc" ] || skip "no collating locale on this host — the C-order arm cannot be falsified here"

    LC_ALL="$loc" run "$SCRIPT" manifest "$DIST"
    [ "$status" -eq 0 ]
    [ "$(head -n 2 <<<"$output" | sed 's/^[0-9a-f]*  //')" = "$(printf '%s\n' assets/Zeta-Q9.js assets/alpha-R2.js)" ]
}

@test "issue 2642 — manifest: one changed byte changes exactly that file's line" {
    "$SCRIPT" manifest "$DIST" > "$BATS_TEST_TMPDIR/before"
    printf 'console.log("cid")\n' > "$DIST/assets/index-AbC1.js"
    "$SCRIPT" manifest "$DIST" > "$BATS_TEST_TMPDIR/after"

    changed="$(diff "$BATS_TEST_TMPDIR/before" "$BATS_TEST_TMPDIR/after" | grep -c '^>' || true)"
    [ "$changed" -eq 1 ]
    diff "$BATS_TEST_TMPDIR/before" "$BATS_TEST_TMPDIR/after" | grep -q '^>.*  assets/index-AbC1\.js$'
}

@test "issue 2642 — manifest: a tree that is not a built dist, or holds a symlink, is refused" {
    rm "$DIST/index.html"
    run "$SCRIPT" manifest "$DIST"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no index.html"* ]]

    printf 'x\n' > "$DIST/index.html"
    ln -s index.html "$DIST/assets/alias.html"
    run "$SCRIPT" manifest "$DIST"
    [ "$status" -eq 1 ]
    [[ "$output" == *"neither a file nor a directory"* ]]
}

@test "issue 2642 — pack: the tarball extracts flat to the tree its manifest names" {
    out="$BATS_TEST_TMPDIR/out"
    run "$SCRIPT" pack "$DIST" "$out" 1.7.0
    [ "$status" -eq 0 ]

    # Exactly the two assets, named after the version.
    [ "$(ls "$out")" = "$(printf '%s\n' cicchetto-dist-1.7.0.sha256 cicchetto-dist-1.7.0.tar.gz)" ]

    # The manifest asset IS the manifest of the source tree…
    "$SCRIPT" manifest "$DIST" > "$BATS_TEST_TMPDIR/m"
    cmp "$BATS_TEST_TMPDIR/m" "$out/cicchetto-dist-1.7.0.sha256"

    # …and of what the tarball extracts to, at the top of the target dir.
    x="$BATS_TEST_TMPDIR/x"
    mkdir -p "$x"
    tar -xzf "$out/cicchetto-dist-1.7.0.tar.gz" -C "$x"
    [ -f "$x/index.html" ]
    "$SCRIPT" manifest "$x" > "$BATS_TEST_TMPDIR/mx"
    cmp "$BATS_TEST_TMPDIR/m" "$BATS_TEST_TMPDIR/mx"
}

@test "issue 2642 — pack: stdout is the subjects — every file, then the two assets" {
    out="$BATS_TEST_TMPDIR/out"
    "$SCRIPT" pack "$DIST" "$out" 1.7.0-rc1 > "$BATS_TEST_TMPDIR/subjects"

    files="$(wc -l < "$out/cicchetto-dist-1.7.0-rc1.sha256")"
    [ "$files" -eq 7 ]
    [ "$(wc -l < "$BATS_TEST_TMPDIR/subjects")" -eq $((files + 2)) ]

    # The first lines are the manifest, verbatim…
    head -n "$files" "$BATS_TEST_TMPDIR/subjects" | cmp - "$out/cicchetto-dist-1.7.0-rc1.sha256"
    # …the last two name the assets and hold their digests.
    tail -n 2 "$BATS_TEST_TMPDIR/subjects" > "$BATS_TEST_TMPDIR/assets.sha256"
    grep -q '  cicchetto-dist-1\.7\.0-rc1\.tar\.gz$' "$BATS_TEST_TMPDIR/assets.sha256"
    grep -q '  cicchetto-dist-1\.7\.0-rc1\.sha256$' "$BATS_TEST_TMPDIR/assets.sha256"
    (cd "$out" && sha256sum -c "$BATS_TEST_TMPDIR/assets.sha256" >/dev/null)
}

@test "issue 2642 — a missing dist is refused by name, and nothing names it a usage error" {
    run "$SCRIPT" manifest "$BATS_TEST_TMPDIR/no-such-dir"
    [ "$status" -eq 1 ]
    [[ "$output" == *"$BATS_TEST_TMPDIR/no-such-dir is not a directory"* ]]
    [[ "$output" != *usage:* ]]
}

@test "issue 2642 — pack: a refused dist leaves the out dir untouched" {
    # The out dir would otherwise hold a 0-byte file under the real asset's
    # name, which is what an upload glob collects.
    run "$SCRIPT" pack "$BATS_TEST_TMPDIR/no-such-dir" "$BATS_TEST_TMPDIR/out" 1.7.0
    [ "$status" -eq 1 ]
    [[ "$output" == *"$BATS_TEST_TMPDIR/no-such-dir is not a directory"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/out" ]

    rm "$DIST/index.html"
    run "$SCRIPT" pack "$DIST" "$BATS_TEST_TMPDIR/out" 1.7.0
    [ "$status" -eq 1 ]
    [[ "$output" == *"no index.html"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/out" ]

    # An out dir that already exists keeps exactly what it held.
    mkdir -p "$BATS_TEST_TMPDIR/out"
    printf 'keep\n' > "$BATS_TEST_TMPDIR/out/other"
    run "$SCRIPT" pack "$DIST" "$BATS_TEST_TMPDIR/out" 1.7.0
    [ "$status" -eq 1 ]
    [ "$(ls "$BATS_TEST_TMPDIR/out")" = other ]
}

@test "issue 2642 — pack: a version that is not X.Y.Z or X.Y.Z-<pre> is refused" {
    for v in "" 1.7 v1.7.0 1.7.0/x '1.7.0~rc1'; do
        run "$SCRIPT" pack "$DIST" "$BATS_TEST_TMPDIR/out" "$v"
        [ "$status" -eq 1 ]
        [[ "$output" == *"neither X.Y.Z nor X.Y.Z-<pre>"* ]]
    done
    [ ! -e "$BATS_TEST_TMPDIR/out" ]
}

@test "issue 2642 — usage errors exit 2" {
    run "$SCRIPT"
    [ "$status" -eq 2 ]
    run "$SCRIPT" manifest
    [ "$status" -eq 2 ]
    run "$SCRIPT" pack "$DIST" "$BATS_TEST_TMPDIR/out"
    [ "$status" -eq 2 ]
    run "$SCRIPT" frobnicate "$DIST"
    [ "$status" -eq 2 ]
}

# ── release.yml wiring ──────────────────────────────────────────────────────

# A job's lines, from its key to the next job key. Comment lines are dropped:
# a commented-out step is not a step.
job_of() {
    awk -v key="  $2:" '$0 == key { on = 1; print; next }
         on && /^  [a-z][a-z0-9_-]*:$/ { exit }
         on && !/^[[:space:]]*#/' "$1"
}

# The attestation is minted on a tag push and nowhere else.
cic_tag_push_only() {
    job_of "$1" cic | grep -qxF "    if: \${{ github.event_name == 'push' }}"
}

# Exactly the three scopes the job needs, nothing that writes to the release.
cic_permissions_scoped() {
    local scopes
    scopes="$(job_of "$1" cic | awk '/^    permissions:$/ { on = 1; next }
        on && /^      [a-z-]+: [a-z]+$/ { sub(/^ +/, ""); print; next }
        on { exit }' | LC_ALL=C sort)"
    [ "$scopes" = "$(printf '%s\n' 'attestations: write' 'contents: read' 'id-token: write')" ]
}

# A full-history checkout (credits.sh) and the pinned build.
cic_builds_pinned() {
    local job
    job="$(job_of "$1" cic)"
    grep -qxF '          fetch-depth: 0' <<<"$job" &&
        grep -qxF '          scripts/bun.sh install --frozen-lockfile' <<<"$job" &&
        grep -qxF '          scripts/bun.sh run build' <<<"$job"
}

# pack writes the subjects, the pinned attest action reads them, the attest
# step comes before the upload, and no step can be skipped past.
cic_attests_before_upload() {
    local job
    job="$(job_of "$1" cic)"
    grep -qF 'infra/packaging/release_cic_dist.sh pack cicchetto/dist cic-release "$(infra/packaging/version.sh)" > "$RUNNER_TEMP/cic-subjects"' <<<"$job" &&
        grep -qE '^        uses: actions/attest-build-provenance@[0-9a-f]{40} # v[0-9.]+$' <<<"$job" &&
        grep -qxF '          subject-checksums: ${{ runner.temp }}/cic-subjects' <<<"$job" &&
        refute grep -qE '^      (- |  )(if|continue-on-error):' <<<"$job" &&
        awk '/release_cic_dist\.sh pack / && !p { p = NR }
             /uses: actions\/attest-build-provenance@/ && !a { a = NR }
             /uses: actions\/upload-artifact@/ && !u { u = NR }
             END { exit !(p && a && u && p < a && a < u) }' <<<"$job"
}

# publish waits for the job, or its artifact may not exist yet.
publish_needs_cic() {
    job_of "$1" publish | grep -qE '^    needs: \[([a-z, ]*, )?cic(, [a-z, ]*)?\]$'
}

@test "issue 2642 — the cic job attests on a tag push only, with scoped permissions" {
    cic_tag_push_only "$WORKFLOW" || {
        printf 'release.yml'"'"'s cic job is not gated to a tag push:\n' >&2
        job_of "$WORKFLOW" cic | grep -E '^    if:' >&2
        return 1
    }
    cic_permissions_scoped "$WORKFLOW" || {
        printf 'the cic job'"'"'s permissions are not exactly contents: read, id-token: write, attestations: write\n' >&2
        return 1
    }
}

@test "issue 2642 — the cic job builds pinned from full history and attests before it uploads" {
    cic_builds_pinned "$WORKFLOW" || {
        printf 'the cic job does not build with scripts/bun.sh from a fetch-depth 0 checkout\n' >&2
        return 1
    }
    cic_attests_before_upload "$WORKFLOW" || {
        printf 'the cic job does not hand pack'"'"'s subjects to the attest action before uploading,\n' >&2
        printf 'or one of its steps carries an if: / continue-on-error:\n' >&2
        return 1
    }
    publish_needs_cic "$WORKFLOW" || {
        printf 'publish does not list cic in its needs:\n' >&2
        job_of "$WORKFLOW" publish | grep -E '^    needs:' >&2
        return 1
    }
}

@test "issue 2642 — RED: the predicates reject a dispatch gate, a widened scope, a commented attest, a late attest" {
    local live="$BATS_TEST_TMPDIR/live.yml"
    cat > "$live" <<'EOF'
jobs:
  cic:
    if: ${{ github.event_name == 'push' }}
    permissions:
      contents: read
      id-token: write
      attestations: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - run: |
          scripts/bun.sh install --frozen-lockfile
          scripts/bun.sh run build
      - run: infra/packaging/release_cic_dist.sh pack cicchetto/dist cic-release "$(infra/packaging/version.sh)" > "$RUNNER_TEMP/cic-subjects"
      - name: Attest
        uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2
        with:
          subject-checksums: ${{ runner.temp }}/cic-subjects
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
  publish:
    needs: [deb, arch, rpm, cic]
EOF
    # POSITIVE control: predicates broken into always-false would report every
    # RED below as a pass.
    cic_tag_push_only "$live"
    cic_permissions_scoped "$live"
    cic_builds_pinned "$live"
    cic_attests_before_upload "$live"
    publish_needs_cic "$live"

    local v="$BATS_TEST_TMPDIR/v.yml"

    # A dispatch admitted next to the tag push.
    sed "s/    if: \${{ github.event_name == 'push' }}/    if: \${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}/" "$live" > "$v"
    refute cic_tag_push_only "$v"

    # The job handed the release-writing scope.
    sed 's/      contents: read/      contents: write/' "$live" > "$v"
    refute cic_permissions_scoped "$v"

    # A shallow checkout.
    sed 's/          fetch-depth: 0/          fetch-depth: 1/' "$live" > "$v"
    refute cic_builds_pinned "$v"

    # The attest action kept only as a comment.
    sed 's|^        uses: actions/attest-build-provenance@|        # uses: actions/attest-build-provenance@|' "$live" > "$v"
    refute cic_attests_before_upload "$v"

    # An attestation allowed to fail.
    awk '{ print } /^      - name: Attest$/ { print "        continue-on-error: true" }' "$live" > "$v"
    grep -qx '        continue-on-error: true' "$v"
    refute cic_attests_before_upload "$v"

    # The upload moved ahead of the attestation.
    awk '/upload-artifact/ { next } { print } /^      - run: infra\/packaging\/release_cic_dist\.sh/ { print "      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2" }' "$live" > "$v"
    refute cic_attests_before_upload "$v"

    # publish no longer waiting for it.
    sed 's/    needs: \[deb, arch, rpm, cic\]/    needs: [deb, arch, rpm]/' "$live" > "$v"
    refute publish_needs_cic "$v"
}
