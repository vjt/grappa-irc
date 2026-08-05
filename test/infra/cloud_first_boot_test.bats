#!/usr/bin/env bats
#
# Bats suite for infra/cloud/first-boot.sh — the #665 shared cloud bootstrap.
#
# Scope: the decision logic + the on-disk effects, NOT a live apt/systemd box.
# Every external tool (apt-get, systemctl, nginx, certbot, curl, getent) is
# stubbed on PATH and logs to $ARGV_LOG; all filesystem targets are redirected
# into $BATS_TEST_TMPDIR via the script's config-default env seams. The `curl`
# stub serves the LATEST-release JSON, the .deb download, the locations-api.conf
# snippet, and /healthz — mirroring the get.sh suite. The apt-get stub, on a
# local-.deb install, seeds the env file to mimic the .deb postinstall.
#
# Proves: domain/email hard-required, latest-.deb install path, enable+restart+
# health wait, PHX_HOST/VAPID_SUBJECT force-set + 0640 relock, nginx site +
# fetched snippet, grappa-tls helper + boot oneshot, and the LE-quota-safe
# TLS-deferred-until-DNS behaviour.

load ../bats_helpers

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    FBSH="$REPO_SRC/infra/cloud/first-boot.sh"

    # ── Filesystem sandbox (the script's config-default seams) ──────────────
    export GRAPPA_ENV_FILE="$BATS_TEST_TMPDIR/etc/grappa/grappa.env"
    export GRAPPA_NGINX_SITES_AVAILABLE="$BATS_TEST_TMPDIR/nginx/sites-available"
    export GRAPPA_NGINX_SITES_ENABLED="$BATS_TEST_TMPDIR/nginx/sites-enabled"
    export GRAPPA_NGINX_SNIPPETS="$BATS_TEST_TMPDIR/nginx/snippets"
    export GRAPPA_TLS_HELPER="$BATS_TEST_TMPDIR/sbin/grappa-tls"
    export GRAPPA_TLS_UNIT="$BATS_TEST_TMPDIR/systemd/grappa-tls.service"

    # ── Behaviour seams: fast health loop ───────────────────────────────────
    export GRAPPA_HEALTH_RETRIES=3
    export GRAPPA_HEALTH_SLEEP=0

    # ── Operator knobs ──────────────────────────────────────────────────────
    export GRAPPA_DOMAIN="irc.example.org"
    export GRAPPA_ADMIN_EMAIL="ops@example.org"

    # ── Stubs ────────────────────────────────────────────────────────────────
    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    ARGV_LOG="$FAKE_DIR/argv.log"
    export ARGV_LOG
    : > "$ARGV_LOG"

    export ENV_EXAMPLE="$REPO_SRC/infra/packaging/grappa.env.example"
    export SRC_LOCATIONS="$REPO_SRC/infra/snippets/locations-api.conf"

    # curl: serves the latest-release JSON, the .deb, the snippet, and healthz.
    cat > "$FAKE_DIR/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$ARGV_LOG"
url=''; dest=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    -*) shift ;;
    *)  url="$1"; shift ;;
  esac
done
case "$url" in
  */releases/latest)
    [ -n "${RELEASE_API_FAILS:-}" ] && exit 22
    # RELEASE_HAS_NO_DEB=1 → a real release that shipped no amd64 asset.
    [ -n "${RELEASE_HAS_NO_DEB:-}" ] \
      && { printf '{"tag_name":"v9.9.9","assets":[{"browser_download_url":"https://github.com/vjt/grappa-irc/releases/download/v9.9.9/grappa_9.9.9_arm64.deb"}]}\n'; exit 0; }
    printf '{"tag_name":"v9.9.9","assets":[{"browser_download_url":"https://github.com/vjt/grappa-irc/releases/download/v9.9.9/grappa_9.9.9_amd64.deb"}]}\n' ;;
  *_amd64.deb)
    [ -n "${DEB_FETCH_FAILS:-}" ] && exit 22
    [ -n "$dest" ] && printf 'FAKE DEB\n' > "$dest" ;;
  */infra/snippets/locations-api.conf)
    [ -n "$dest" ] && cp "$SRC_LOCATIONS" "$dest" ;;
  *healthz*)
    [ -n "${HEALTH_NEVER_OK:-}" ] && exit 7
    exit 0 ;;
  *) printf 'fake curl: unexpected url: %s\n' "$url" >&2; exit 1 ;;
esac
EOF
    chmod +x "$FAKE_DIR/curl"

    # apt-get: logs; on a local-.deb install, seed the env file (mimics the
    # .deb postinstall creating /etc/grappa/grappa.env from the template).
    cat > "$FAKE_DIR/apt-get" <<'EOF'
#!/usr/bin/env bash
printf 'apt-get %s\n' "$*" >> "$ARGV_LOG"
case "$*" in
  *install*.deb*)
    if [ -z "${SKIP_ENV_SEED:-}" ]; then
      mkdir -p "$(dirname "$GRAPPA_ENV_FILE")"
      cp "$ENV_EXAMPLE" "$GRAPPA_ENV_FILE"
    fi ;;
esac
exit 0
EOF
    chmod +x "$FAKE_DIR/apt-get"

    # id: root, like the box the script is written for. Stubbed on PATH
    # rather than skipped through an env var, so require_root runs verbatim
    # here and production carries no bypass (#747). A test that wants a
    # non-root run overrides this stub.
    cat > "$FAKE_DIR/id" <<'EOF'
#!/usr/bin/env bash
printf 'id %s\n' "$*" >> "$ARGV_LOG"
printf '%s\n' "${FAKE_UID:-0}"
EOF
    chmod +x "$FAKE_DIR/id"

    # certbot: separate from the log-only stubs because grappa-tls execs it,
    # and CERTBOT_FAILS=1 is how a test drives the likeliest real failure —
    # the Let's Encrypt rate limit.
    cat > "$FAKE_DIR/certbot" <<'EOF'
#!/usr/bin/env bash
printf 'certbot %s\n' "$*" >> "$ARGV_LOG"
[ -n "${CERTBOT_FAILS:-}" ] && exit 1
exit 0
EOF
    chmod +x "$FAKE_DIR/certbot"

    for tool in systemctl nginx; do
        cat > "$FAKE_DIR/$tool" <<EOF
#!/usr/bin/env bash
printf '$tool %s\n' "\$*" >> "$ARGV_LOG"
exit 0
EOF
        chmod +x "$FAKE_DIR/$tool"
    done

    # getent: DNS does NOT resolve by default (the deferred-TLS path). A test
    # opts into "resolves now" with GETENT_RESOLVES=1.
    cat > "$FAKE_DIR/getent" <<'EOF'
#!/usr/bin/env bash
printf 'getent %s\n' "$*" >> "$ARGV_LOG"
[ -n "${GETENT_RESOLVES:-}" ] && exit 0
exit 2
EOF
    chmod +x "$FAKE_DIR/getent"

    export PATH="$FAKE_DIR:$PATH"
}

# ───────────────────────────── required knobs ────────────────────────────────

@test "hard-fails when GRAPPA_DOMAIN is unset" {
    unset GRAPPA_DOMAIN
    run "$FBSH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"GRAPPA_DOMAIN is required"* ]]
}

@test "hard-fails when GRAPPA_ADMIN_EMAIL is unset" {
    unset GRAPPA_ADMIN_EMAIL
    run "$FBSH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"GRAPPA_ADMIN_EMAIL is required"* ]]
}

# ───────────────────────────── privilege ─────────────────────────────────────

# Until #747 this could not even be written: the suite exported
# GRAPPA_SKIP_PRIVCHECK=1 in setup, so require_root returned before reading
# the uid and no test could reach the refusal.
@test "refuses to run as a non-root user" {
    FAKE_UID=1000 run "$FBSH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"must run as root"* ]]
    # It refuses BEFORE touching the box.
    refute grep -q "^apt-get " "$ARGV_LOG"
}

@test "checks the uid rather than trusting an env var" {
    GRAPPA_SKIP_PRIVCHECK=1 FAKE_UID=1000 run "$FBSH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"must run as root"* ]]
}

# ───────────────────────────── install path ──────────────────────────────────

@test "installs the LATEST release .deb via apt (no pin)" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    grep -q "curl .*/releases/latest" "$ARGV_LOG"
    grep -q "curl .*grappa_9.9.9_amd64.deb" "$ARGV_LOG"
    grep -qE "apt-get install .*grappa\.deb" "$ARGV_LOG"
}

@test "installs nginx + certbot for single-box TLS termination" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    grep -qE "apt-get install .*nginx.*certbot.*python3-certbot-nginx" "$ARGV_LOG"
}

@test "enables + restarts grappa, then waits on /healthz" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    grep -q "systemctl enable grappa.service" "$ARGV_LOG"
    grep -q "systemctl restart grappa.service" "$ARGV_LOG"
    grep -q "curl .*healthz" "$ARGV_LOG"
}

@test "fails loud if the env file is missing after install" {
    SKIP_ENV_SEED=1 run "$FBSH"
    [ "$status" -ne 0 ]
    # Pin the PATH, not just the word: "missing" appears in more than one
    # die, so the bare substring passed for a refusal it never saw.
    [[ "$output" == *"$GRAPPA_ENV_FILE missing"* ]]
}

# ───────────────────────────── failure paths ─────────────────────────────────
#
# The happy path was covered and every way the bootstrap can FAIL was not, so
# a box could report a successful first boot while serving nothing. Each of
# these asserts the die AND that the run stopped there.

# Both of these used to abort with a bare exit 1 and NO message: under
# `set -o pipefail` a no-match grep failed the pipeline, and `set -e` killed
# the script at the command substitution — before the die that names the
# problem. An operator read a cloud-init that failed for no stated reason.
@test "a release with no amd64 .deb asset says so instead of dying mute" {
    RELEASE_HAS_NO_DEB=1 run "$FBSH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"no grappa_*_amd64.deb asset"* ]]
    refute grep -qE "apt-get install .*grappa\.deb" "$ARGV_LOG"
}

@test "an unreachable release API is reported as such, not as a missing asset" {
    RELEASE_API_FAILS=1 run "$FBSH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"could not read the latest release"* ]]
    refute grep -qE "apt-get install .*grappa\.deb" "$ARGV_LOG"
}

@test "a failed .deb download aborts instead of installing a half-file" {
    DEB_FETCH_FAILS=1 run "$FBSH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"download failed"* ]]
    refute grep -qE "apt-get install .*grappa\.deb" "$ARGV_LOG"
}

@test "health that never comes up is a failed boot, not a quiet one" {
    HEALTH_NEVER_OK=1 run "$FBSH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"did not become healthy"* ]]
    # Exhausted the budget rather than giving up on the first miss.
    [ "$(grep -c "curl .*healthz" "$ARGV_LOG")" -eq "$GRAPPA_HEALTH_RETRIES" ]
    # And it stopped: TLS never got installed on a box that serves nothing.
    [ ! -e "$GRAPPA_TLS_HELPER" ]
}

@test "a grappa-tls failure leaves the box up with a re-run instruction" {
    # The likeliest real failure is the Let's Encrypt quota, and it must NOT
    # fail the boot: grappa itself is already serving, only the cert is late.
    GETENT_RESOLVES=1 CERTBOT_FAILS=1 run "$FBSH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"grappa-tls failed"* ]]
    [[ "$output" == *"sudo grappa-tls"* ]]
}

# ───────────────────────────── env force-set ─────────────────────────────────

@test "force-sets PHX_HOST and VAPID_SUBJECT from the knobs" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    grep -qx "PHX_HOST=irc.example.org" "$GRAPPA_ENV_FILE"
    grep -qx "VAPID_SUBJECT=mailto:ops@example.org" "$GRAPPA_ENV_FILE"
    # The template's REPLACE_ME host is gone.
    refute grep -q "^PHX_HOST=REPLACE_ME$" "$GRAPPA_ENV_FILE"
}

@test "relocks the env file to 0640 after rewriting it" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    [ "$(file_mode "$GRAPPA_ENV_FILE")" = "640" ]
}

# ───────────────────────────── nginx site ────────────────────────────────────

@test "writes the nginx site with server_name + the fetched proxy snippet" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    grep -q "server_name irc.example.org;" "$GRAPPA_NGINX_SITES_AVAILABLE/grappa"
    grep -q "include snippets/grappa-locations-api.conf;" "$GRAPPA_NGINX_SITES_AVAILABLE/grappa"
    # The #485 SSOT snippet was fetched, not re-typed.
    grep -q "grappa_upstream" "$GRAPPA_NGINX_SNIPPETS/grappa-locations-api.conf"
    grep -q "curl .*/infra/snippets/locations-api.conf" "$ARGV_LOG"
}

# Writing sites-available and never linking it leaves nginx serving the stock
# default: the site file reads perfect on disk, the box answers nothing, and
# the ACME challenge goes to the wrong server_name.
@test "enables the site and drops the stock default" {
    mkdir -p "$GRAPPA_NGINX_SITES_ENABLED"
    printf 'stock default\n' > "$GRAPPA_NGINX_SITES_ENABLED/default"

    run "$FBSH"
    [ "$status" -eq 0 ]

    [ -L "$GRAPPA_NGINX_SITES_ENABLED/grappa" ]
    [ "$(readlink "$GRAPPA_NGINX_SITES_ENABLED/grappa")" = "$GRAPPA_NGINX_SITES_AVAILABLE/grappa" ]
    [ ! -e "$GRAPPA_NGINX_SITES_ENABLED/default" ]
}

# ───────────────────────────── TLS helper + defer ────────────────────────────

@test "installs the grappa-tls helper with domain + email baked in" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    [ -x "$GRAPPA_TLS_HELPER" ]
    grep -q "DOMAIN='irc.example.org'" "$GRAPPA_TLS_HELPER"
    grep -q "EMAIL='ops@example.org'" "$GRAPPA_TLS_HELPER"
    grep -q "certbot --nginx" "$GRAPPA_TLS_HELPER"
}

@test "installs + enables the boot oneshot (self-issue on reboot-after-DNS)" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    grep -q "ExecStart=$GRAPPA_TLS_HELPER" "$GRAPPA_TLS_UNIT"
    grep -q "systemctl enable grappa-tls.service" "$ARGV_LOG"
}

@test "DEFERS TLS when DNS does not resolve (does NOT burn LE quota)" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    [[ "$output" == *"DEFERRED"* ]]
    # certbot must NOT have been invoked at first boot.
    refute grep -q "^certbot " "$ARGV_LOG"
}

@test "issues TLS immediately when DNS already resolves" {
    GETENT_RESOLVES=1 run "$FBSH"
    [ "$status" -eq 0 ]
    grep -q "certbot --nginx -d irc.example.org" "$ARGV_LOG"
}

# ───────────────────────────── idempotency ───────────────────────────────────

@test "idempotent: a second run re-applies cleanly with one PHX_HOST line" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    run "$FBSH"
    [ "$status" -eq 0 ]
    [ "$(grep -c "^PHX_HOST=" "$GRAPPA_ENV_FILE")" -eq 1 ]
    [ "$(grep -c "^VAPID_SUBJECT=" "$GRAPPA_ENV_FILE")" -eq 1 ]
}

@test "re-run does NOT strip certbot's TLS vhost from the nginx site" {
    run "$FBSH"
    [ "$status" -eq 0 ]
    # Simulate certbot --nginx having taken the site over (it appends a 443
    # server + marks its edits '# managed by Certbot').
    cat >> "$GRAPPA_NGINX_SITES_AVAILABLE/grappa" <<'EOF'
server {
    listen 443 ssl; # managed by Certbot
    server_name irc.example.org;
    ssl_certificate /etc/letsencrypt/live/irc.example.org/fullchain.pem; # managed by Certbot
}
EOF
    run "$FBSH"
    [ "$status" -eq 0 ]
    # The TLS vhost must survive the re-run.
    grep -q "listen 443 ssl; # managed by Certbot" "$GRAPPA_NGINX_SITES_AVAILABLE/grappa"
    [[ "$output" == *"certbot-managed"* ]]
}

# ───────────────────────────── input validation ──────────────────────────────

@test "rejects a malformed domain (SSOT-side validation)" {
    GRAPPA_DOMAIN="not a domain'; rm -rf /" run "$FBSH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"not a valid fully-qualified domain name"* ]]
}

@test "rejects a malformed admin email" {
    GRAPPA_ADMIN_EMAIL="nope" run "$FBSH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"not a valid email address"* ]]
}
