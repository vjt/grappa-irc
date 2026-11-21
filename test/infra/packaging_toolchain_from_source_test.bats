#!/usr/bin/env bats
#
# infra/packaging/toolchain_from_source.sh (issue 2669) — the .rpm's OTP and
# Elixir, built from source inside the release job's Fedora container.
#
# What is held here is the part a network-free suite can hold: the script
# downloads the OTP named by .tool-versions, and it builds nothing from a
# tarball the release's SHA256.txt does not vouch for. The build itself (a real
# configure + make of OTP) runs in CI only.
#
# `curl` is a PATH stub that serves fixtures by file name and logs every URL.
# The fixture tarball is a REAL tar.gz whose `configure` records its argv and
# exits 42. That makes every case discriminate: a script that skipped the
# checksum would unpack it and run that configure, and the two fail-closed
# cases assert it never ran; the positive case proves the check passes a good
# tarball by reaching it. The pins are fake on purpose (98.7 / 6.5.4), so a
# script that hard-coded today's versions would request the wrong URLs.

load ../bats_helpers

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/../../infra/packaging/toolchain_from_source.sh"

    REPO="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$REPO"
    printf 'elixir 6.5.4-otp-98\nerlang 98.7\n' > "$REPO/.tool-versions"

    SERVE="$BATS_TEST_TMPDIR/serve"
    mkdir -p "$SERVE"
    CONFIGURE_LOG="$BATS_TEST_TMPDIR/configure.argv"
    URL_LOG="$BATS_TEST_TMPDIR/curl.urls"

    # The tarball: otp_src_98.7/configure records its argv, then stops the run.
    local src="$BATS_TEST_TMPDIR/build/otp_src_98.7"
    mkdir -p "$src"
    printf '#!/bin/sh\nprintf "%%s\\n" "$@" > "%s"\nexit 42\n' "$CONFIGURE_LOG" > "$src/configure"
    chmod +x "$src/configure"
    tar -czf "$SERVE/otp_src_98.7.tar.gz" -C "$BATS_TEST_TMPDIR/build" otp_src_98.7

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
printf '%s\n' "\$url" >> "$URL_LOG"
src="$SERVE/\${url##*/}"
[ -f "\$src" ] || exit 22
cp "\$src" "\$out"
EOF
    chmod +x "$FAKE/curl"
    export PATH="$FAKE:$PATH"
}

# SHA256.txt in the release's own format: `<sha256>  <name>`, one per line.
publish_sums() {
    printf '%s\n' "$@" > "$SERVE/SHA256.txt"
}

genuine_sum() {
    printf '%s  otp_src_98.7.tar.gz' "$(sha256sum "$SERVE/otp_src_98.7.tar.gz" | cut -d' ' -f1)"
}

@test "a tarball the release's SHA256.txt vouches for reaches configure, with the prefix and the GUI left out" {
    publish_sums \
        "1111111111111111111111111111111111111111111111111111111111111111  otp_doc_man_98.7.tar.gz" \
        "$(genuine_sum)"

    cd "$REPO"
    run "$SCRIPT" /opt/beam
    [ "$status" -eq 42 ] || { printf 'status %s, output:\n%s\n' "$status" "$output" >&2; return 1; }

    grep -qx -- '--prefix=/opt/beam' "$CONFIGURE_LOG"
    grep -qx -- '--without-wx' "$CONFIGURE_LOG"
    grep -qx -- '--without-javac' "$CONFIGURE_LOG"
    grep -qx -- '--without-debugger' "$CONFIGURE_LOG"
    grep -qx -- '--without-observer' "$CONFIGURE_LOG"

    # Both downloads are named by the .tool-versions pin, not by a literal.
    grep -qx 'https://github.com/erlang/otp/releases/download/OTP-98.7/otp_src_98.7.tar.gz' "$URL_LOG"
    grep -qx 'https://github.com/erlang/otp/releases/download/OTP-98.7/SHA256.txt' "$URL_LOG"
}

@test "a tarball that does not match its published sha256 is never unpacked or configured" {
    publish_sums "0000000000000000000000000000000000000000000000000000000000000000  otp_src_98.7.tar.gz"

    cd "$REPO"
    run "$SCRIPT" /opt/beam
    [ "$status" -ne 0 ]
    [ "$status" -ne 42 ] || { printf 'configure ran on a tarball that failed its checksum\n' >&2; return 1; }
    grep -q 'does not match the SHA256.txt of OTP-98.7' <<<"$output"
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
    refute test -e "$CONFIGURE_LOG"
}
