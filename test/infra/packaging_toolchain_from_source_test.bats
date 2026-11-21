#!/usr/bin/env bats
#
# infra/packaging/toolchain_from_source.sh (issue 2669) — the .rpm's OTP and
# Elixir, built from source inside the release job's Fedora container.
#
# What is held here is the part a network-free suite can hold: the script
# downloads the OTP named by .tool-versions; it unpacks and builds nothing from
# a tarball the release's SHA256.txt does not vouch for; and it stops when what
# it installed reports a version other than the pin. The build itself (a real
# configure + make of OTP) runs in CI only. So do the two checks that need the
# real binaries: the `ssl` start inside `erl -eval`, and the System.version/0
# call that a bare `--short-version` would answer without a compiled module.
# Here `erl` and `elixir` are stand-ins: `erl` records that it ran and exits
# with the code its fixture names, and `elixir` prints the version its fixture
# names. So the suite holds that the script stops when the installed erl exits
# non-zero, but not that the real erl does exit non-zero when ssl fails.
#
# `curl` and `tar` are PATH stubs that log every call, in order, to one file:
# curl serves fixtures by file name, tar execs the real one. The default
# fixture tarball is a REAL tar.gz whose `configure` records its argv and exits
# 42, so a case that must not build can tell configure ran. The two
# fail-closed cases assert that tar never ran and configure never ran; the
# positive case proves the check passes a good tarball by reaching configure.
# The cases that go past configure swap in a tarball whose configure exits 0
# and whose `make install` writes an OTP_VERSION and the `erl` stand-in, plus
# an Elixir archive whose `make install` writes the `elixir` one. The pins are
# fake on purpose (98.7 / 6.5.4), so a script that hard-coded today's versions
# would request the wrong URLs.

load ../bats_helpers

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/../../infra/packaging/toolchain_from_source.sh"

    REPO="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$REPO"
    printf 'elixir 6.5.4-otp-98\nerlang 98.7\n' > "$REPO/.tool-versions"

    SERVE="$BATS_TEST_TMPDIR/serve"
    mkdir -p "$SERVE"
    CONFIGURE_LOG="$BATS_TEST_TMPDIR/configure.argv"
    CALLS="$BATS_TEST_TMPDIR/calls"
    PREFIX="$BATS_TEST_TMPDIR/prefix"

    # Resolved before the stubs go on PATH: the fixtures are packed with the
    # real tar, so only the script's own calls reach the log.
    REAL_TAR="$(command -v tar)"

    otp_tarball 42 98.7 0

    FAKE="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE"
    cat > "$FAKE/curl" <<EOF
#!/bin/sh
out=""; url=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        -o) out="\$2"; shift 2 ;;
        http*) url="\$1"; shift ;;
        *) shift ;;
    esac
done
printf 'curl %s\n' "\$url" >> "$CALLS"
src="$SERVE/\${url##*/}"
[ -f "\$src" ] || exit 22
cp "\$src" "\$out"
EOF
    cat > "$FAKE/tar" <<EOF
#!/bin/sh
printf 'tar %s\n' "\$*" >> "$CALLS"
exec "$REAL_TAR" "\$@"
EOF
    # For the build's `make -j"$(nproc)"`: the CI container has nproc, a
    # macOS host running this suite does not.
    printf '#!/bin/sh\necho 2\n' > "$FAKE/nproc"
    chmod +x "$FAKE/curl" "$FAKE/tar" "$FAKE/nproc"
    export PATH="$FAKE:$PATH"
}

# The OTP source tree, served as otp_src_98.7.tar.gz. Its configure records its
# argv and its --prefix, then exits CONFIGURE_EXIT; its `make install` writes
# REPORTED as releases/98/OTP_VERSION, where a real install puts it, and the
# `erl` stand-in, which logs its call and exits ERL_EXIT.
otp_tarball() {
    local configure_exit="$1" reported="$2" erl_exit="$3"
    local src="$BATS_TEST_TMPDIR/build/otp_src_98.7"
    rm -rf "$src"
    mkdir -p "$src"
    cat > "$src/configure" <<EOF
#!/bin/sh
printf '%s\n' "\$@" > "$CONFIGURE_LOG"
for a in "\$@"; do
    case "\$a" in --prefix=*) printf '%s\n' "\${a#--prefix=}" > prefix ;; esac
done
exit $configure_exit
EOF
    cat > "$src/erl" <<EOF
#!/bin/sh
printf 'erl %s\n' "\$*" >> "$CALLS"
exit $erl_exit
EOF
    cat > "$src/install.sh" <<EOF
#!/bin/sh
set -e
p="\$(cat prefix)"
mkdir -p "\$p/lib/erlang/releases/98" "\$p/bin"
printf '%s\n' '$reported' > "\$p/lib/erlang/releases/98/OTP_VERSION"
cp erl "\$p/bin/erl"
EOF
    printf 'all:\n\t@:\ninstall:\n\tsh install.sh\n' > "$src/Makefile"
    chmod +x "$src/configure" "$src/erl"
    "$REAL_TAR" -czf "$SERVE/otp_src_98.7.tar.gz" -C "$BATS_TEST_TMPDIR/build" otp_src_98.7
}

# The Elixir tag archive, served as v6.5.4.tar.gz. Its `make install` writes an
# `elixir` stand-in that prints REPORTED.
elixir_archive() {
    local reported="$1"
    local src="$BATS_TEST_TMPDIR/build/elixir-6.5.4"
    rm -rf "$src"
    mkdir -p "$src"
    printf '#!/bin/sh\necho %s\n' "$reported" > "$src/elixir"
    chmod +x "$src/elixir"
    printf 'install:\n\tmkdir -p "$(PREFIX)/bin"\n\tcp elixir "$(PREFIX)/bin/elixir"\n' > "$src/Makefile"
    "$REAL_TAR" -czf "$SERVE/v6.5.4.tar.gz" -C "$BATS_TEST_TMPDIR/build" elixir-6.5.4
}

# SHA256.txt in the release's own format: `<sha256>  <name>`, one per line.
publish_sums() {
    printf '%s\n' "$@" > "$SERVE/SHA256.txt"
}

genuine_sum() {
    printf '%s  otp_src_98.7.tar.gz' "$(sha256sum "$SERVE/otp_src_98.7.tar.gz" | cut -d' ' -f1)"
}

# The line number of the first call in the log that matches the ERE.
first_call() {
    grep -nE "$1" "$CALLS" | head -n1 | cut -d: -f1
}

show_run() {
    printf 'status %s, output:\n%s\n' "$status" "$output" >&2
    if [ -f "$CALLS" ]; then
        printf 'calls:\n' >&2
        cat "$CALLS" >&2
    fi
}

@test "a tarball the release's SHA256.txt vouches for reaches configure, with the prefix and the GUI left out" {
    publish_sums \
        "1111111111111111111111111111111111111111111111111111111111111111  otp_doc_man_98.7.tar.gz" \
        "$(genuine_sum)"

    cd "$REPO"
    run "$SCRIPT" /opt/beam
    [ "$status" -eq 42 ] || { show_run; return 1; }

    grep -qx -- '--prefix=/opt/beam' "$CONFIGURE_LOG"
    grep -qx -- '--without-wx' "$CONFIGURE_LOG"
    grep -qx -- '--without-javac' "$CONFIGURE_LOG"
    grep -qx -- '--without-debugger' "$CONFIGURE_LOG"
    grep -qx -- '--without-observer' "$CONFIGURE_LOG"

    # Both downloads are named by the .tool-versions pin, not by a literal.
    grep -qx 'curl https://github.com/erlang/otp/releases/download/OTP-98.7/otp_src_98.7.tar.gz' "$CALLS"
    grep -qx 'curl https://github.com/erlang/otp/releases/download/OTP-98.7/SHA256.txt' "$CALLS"
}

@test "a tarball that does not match its published sha256 is never unpacked or configured" {
    publish_sums "0000000000000000000000000000000000000000000000000000000000000000  otp_src_98.7.tar.gz"

    cd "$REPO"
    run "$SCRIPT" /opt/beam
    [ "$status" -ne 0 ]
    [ "$status" -ne 42 ] || { printf 'configure ran on a tarball that failed its checksum\n' >&2; return 1; }
    grep -q 'does not match the SHA256.txt of OTP-98.7' <<<"$output"
    refute grep -q '^tar ' "$CALLS"
    refute test -e "$CONFIGURE_LOG"
}

@test "a tarball SHA256.txt does not list is never unpacked or configured" {
    # The other files of the release are listed, ours is not: a filter that
    # matched nothing must stop the run, not hand sha256sum an empty list.
    publish_sums "1111111111111111111111111111111111111111111111111111111111111111  otp_doc_man_98.7.tar.gz"

    cd "$REPO"
    run "$SCRIPT" /opt/beam
    [ "$status" -ne 0 ]
    [ "$status" -ne 42 ] || { printf 'configure ran on a tarball SHA256.txt does not list\n' >&2; return 1; }
    grep -q 'does not list otp_src_98.7.tar.gz' <<<"$output"
    refute grep -q '^tar ' "$CALLS"
    refute test -e "$CONFIGURE_LOG"
}

@test "a build that reports the pinned pair runs to the end, unpacking the OTP tarball only after both its downloads" {
    otp_tarball 0 98.7 0
    elixir_archive 6.5.4
    publish_sums "$(genuine_sum)"

    cd "$REPO"
    run "$SCRIPT" "$PREFIX"
    [ "$status" -eq 0 ] || { show_run; return 1; }
    grep -qxF "toolchain_from_source: done — OTP 98.7 + Elixir 6.5.4 in $PREFIX" <<<"$output"

    # The installed erl is run. What it runs (the ssl start) is CI's to prove.
    grep -q '^erl -noshell -eval ' "$CALLS"

    # The tar stub sees the unpack — the two cases above that say it never ran
    # could not fail without this — and it comes after both downloads.
    local unpack tarball sums
    unpack="$(first_call '^tar -xzf .*/otp_src_98\.7\.tar\.gz ')"
    tarball="$(first_call '^curl .*/OTP-98\.7/otp_src_98\.7\.tar\.gz$')"
    sums="$(first_call '^curl .*/OTP-98\.7/SHA256\.txt$')"
    [ -n "$unpack" ] || { printf 'the OTP tarball was unpacked without the tar on PATH\n' >&2; show_run; return 1; }
    [ "$unpack" -gt "$tarball" ] && [ "$unpack" -gt "$sums" ] || {
        printf 'unpacked at call %s, downloads at %s and %s\n' "$unpack" "$tarball" "$sums" >&2
        return 1
    }
}

@test "an install whose OTP_VERSION is not the pin stops the run before Elixir is fetched" {
    otp_tarball 0 98.6 0
    publish_sums "$(genuine_sum)"

    cd "$REPO"
    run "$SCRIPT" "$PREFIX"
    [ "$status" -eq 1 ] || { show_run; return 1; }
    grep -qF "built OTP reports '98.6', expected '98.7'" <<<"$output"
    refute grep -q 'elixir-lang' "$CALLS"
}

@test "an Elixir that reports a version other than the pin stops the run" {
    otp_tarball 0 98.7 0
    elixir_archive 6.5.3
    publish_sums "$(genuine_sum)"

    cd "$REPO"
    run "$SCRIPT" "$PREFIX"
    [ "$status" -eq 1 ] || { show_run; return 1; }
    grep -qF "built Elixir reports '6.5.3', expected '6.5.4'" <<<"$output"
}

@test "an installed erl that fails stops the run before Elixir is fetched" {
    # The real erl failing its `ssl` start is CI's to see (see the header);
    # what holds here is that the script does not go on past a failing erl.
    otp_tarball 0 98.7 3
    elixir_archive 6.5.4
    publish_sums "$(genuine_sum)"

    cd "$REPO"
    run "$SCRIPT" "$PREFIX"
    [ "$status" -ne 0 ] || { show_run; return 1; }
    # It stopped AT erl, not earlier: the stand-in was reached.
    grep -q '^erl -noshell -eval ' "$CALLS"
    refute grep -q 'elixir-lang' "$CALLS"
}

# ── release.yml wiring ──────────────────────────────────────────────────────
#
# The rpm job never runs on a pull request (release.yml fires on a tag and on
# workflow_dispatch), so this is its PR-time half, read off the workflow text:
# the job runs whenever the deb job does, installs no distro erlang or elixir,
# builds the pinned pair from the recipe of the DISPATCHED ref before build.sh
# runs, and stops at the PATH step when what it restored is not that pair.

WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/release.yml"

rpm_job() {
    awk '/^  rpm:$/ { f = 1; next } f && /^  [a-z]/ { exit } f' "$WORKFLOW"
}

# A job's own `if:` line, the one at job level. Comments never match: the
# pattern wants `if:` right after the four spaces.
job_if() {
    awk -v key="  $1:" '$0 == key { on = 1; next }
         on && /^  [a-z][a-z0-9_-]*:$/ { exit }
         on && /^    if: / { print }' "$WORKFLOW"
}

# The `run: |` body of one rpm-job step, de-indented to column 0. Blank lines
# inside the body are kept; the body ends at the first line indented less.
rpm_step_run() {
    rpm_job | awk -v name="      - name: $1" '
        $0 == name { s = 1; next }
        s && !r && /^      - / { exit }
        s && $0 == "        run: |" { r = 1; next }
        r && /^          / { print substr($0, 11); next }
        r && /^[[:space:]]*$/ { print ""; next }
        r { exit }'
}

# Every package a `dnf install` in the rpm job names, one per line: comments
# dropped, backslash continuations joined, flags and the verb removed.
rpm_dnf_packages() {
    rpm_job | sed 's/#.*$//' \
        | awk '{ if (sub(/\\[[:space:]]*$/, "")) { buf = buf $0 " "; next } print buf $0; buf = "" }' \
        | grep -E '^[[:space:]]*dnf install' \
        | tr -s ' \t' '\n' | awk 'NF && !/^-/ && $0 != "dnf" && $0 != "install"'
}

@test "the rpm job runs whenever the deb job does, the deb_validation dry-run included" {
    local deb rpm
    deb="$(job_if deb)"
    rpm="$(job_if rpm)"

    # One job-level condition each, or the comparison below proves nothing.
    [ -n "$deb" ] && [ "$(grep -c . <<<"$deb")" -eq 1 ] || { printf 'deb job if: %s\n' "$deb" >&2; return 1; }
    [ -n "$rpm" ] && [ "$(grep -c . <<<"$rpm")" -eq 1 ] || { printf 'rpm job if: %s\n' "$rpm" >&2; return 1; }

    # The comment above the rpm job's `if:` promises the deb job's, word for word.
    [ "$rpm" = "$deb" ] || { printf 'rpm: %s\ndeb: %s\n' "$rpm" "$deb" >&2; return 1; }

    # And that shared condition keeps the package dry-run: skipping it there
    # leaves the rpm build provable only by a tag, the gap issue 2669 closed.
    refute grep -qF '!inputs.deb_validation' <<<"$rpm"
}

@test "the rpm job installs no distro erlang or elixir — its OTP is the pinned one, built in the job" {
    local pkgs
    pkgs="$(rpm_dnf_packages)"

    # The scan reads both dnf lines, or it proves nothing: the first carries
    # git, the cache-miss one carries the OTP build deps.
    grep -qx git <<<"$pkgs"
    grep -qx gcc-c++ <<<"$pkgs"
    grep -qx perl <<<"$pkgs"

    refute grep -qE '^(erlang|elixir)(-.*)?$' <<<"$pkgs"
}

@test "the rpm job builds the pair from the DISPATCHED ref's recipe, before build.sh" {
    local job fetch run build
    job="$(rpm_job)"

    # From the dispatched ref: a repair builds a tag that predates the script.
    fetch="$(grep -nF 'git show "${GITHUB_SHA}:infra/packaging/toolchain_from_source.sh"' <<<"$job" | cut -d: -f1)"
    run="$(grep -nF '"$RUNNER_TEMP/toolchain_from_source.sh" "$BEAM_PREFIX"' <<<"$job" | cut -d: -f1)"
    build="$(grep -n 'infra/packaging/build.sh$' <<<"$job" | head -n1 | cut -d: -f1)"

    [ -n "$fetch" ] || { printf 'the rpm job does not take the recipe from GITHUB_SHA\n' >&2; return 1; }
    [ -n "$run" ] || { printf 'the rpm job never runs the recipe it fetched\n' >&2; return 1; }
    [ -n "$build" ] || { printf 'no build.sh step found in the rpm job — the scan is broken\n' >&2; return 1; }
    [ "$fetch" -lt "$run" ] && [ "$run" -lt "$build" ] || {
        printf 'out of order: fetch line %s, run line %s, build.sh line %s\n' "$fetch" "$run" "$build" >&2
        return 1
    }
}

# The PATH step, run for real under the `sh -e` the container gives it, from a
# checkout holding the fake pins, against a prefix laid out as a build leaves
# it. On a cache hit this step is the only check of what was restored.
path_step() {
    local body
    body="$(rpm_step_run 'Put the OTP + Elixir on PATH')"
    [ -n "$body" ] || { printf 'no run: body found for the PATH step — the scan is broken\n' >&2; return 1; }
    printf '%s\n' "$body" > "$BATS_TEST_TMPDIR/path_step.sh"
}

# A restored prefix: releases/98/OTP_VERSION reading OTP, and an elixir that
# prints ELIXIR.
restored_prefix() {
    rm -rf "$PREFIX"
    mkdir -p "$PREFIX/lib/erlang/releases/98" "$PREFIX/bin"
    printf '%s\n' "$1" > "$PREFIX/lib/erlang/releases/98/OTP_VERSION"
    printf '#!/bin/sh\necho %s\n' "$2" > "$PREFIX/bin/elixir"
    chmod +x "$PREFIX/bin/elixir"
}

run_path_step() {
    cd "$REPO"
    export BEAM_PREFIX="$PREFIX" GITHUB_PATH="$BATS_TEST_TMPDIR/github_path"
    run sh -e "$BATS_TEST_TMPDIR/path_step.sh"
}

@test "the PATH step puts a restored prefix holding the pinned pair on PATH" {
    path_step
    restored_prefix 98.7 6.5.4

    run_path_step
    [ "$status" -eq 0 ] || { show_run; return 1; }
    grep -qxF "$PREFIX/bin" "$BATS_TEST_TMPDIR/github_path"
}

@test "the PATH step stops the job when the restored elixir does not start" {
    path_step
    restored_prefix 98.7 6.5.4
    printf '#!/bin/sh\nexit 1\n' > "$PREFIX/bin/elixir"

    run_path_step
    [ "$status" -ne 0 ] || { show_run; return 1; }
}

@test "the PATH step stops the job when the restored OTP is not the pin" {
    path_step
    restored_prefix 98.6 6.5.4

    run_path_step
    [ "$status" -ne 0 ] || { show_run; return 1; }
    grep -qF "'98.6'" <<<"$output"
}

@test "the PATH step stops the job when the restored Elixir is not the pin" {
    path_step
    restored_prefix 98.7 6.5.3

    run_path_step
    [ "$status" -ne 0 ] || { show_run; return 1; }
    grep -qF "'6.5.3'" <<<"$output"
}
