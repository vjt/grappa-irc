#!/usr/bin/env bash
# first-boot.sh — the ONE provider-agnostic bootstrap for a cloud grappa box
# (#665). Everything that happens on the machine AFTER it boots — install the
# release .deb, force the operator's domain into the env file, stand up nginx,
# start the unit, and terminate TLS itself — lives HERE, consumed VERBATIM by:
#
#   - infra/aws/grappa-cloudformation.yaml  (today — CFN UserData curls this
#     script at a git ref and execs it; it is NOT inlined into the template)
#   - infra/terraform/*.tf                  (later — the same curl-at-ref+exec
#     from a Terraform `user_data`)
#
# So the "second cloud" costs a wrapper, not a rewrite. The two doors share
# THIS script + the parameter names in infra/cloud/params.contract, and
# nothing else; the resource graph (CFN YAML vs Terraform HCL) stays two
# hand-written files. The CI drift-guard (infra/cloud/check-drift.sh) proves
# both doors INVOKE this script from their bootstrap block, bind every knob
# marker to a real parameter, and export exactly the env this script requires.
#
# UNLIKE infra/linux/ (which sits BEHIND an upstream TLS box and runs a dumb
# HTTP reverse proxy), a cloud box is the whole world: it terminates TLS
# itself via nginx + certbot. See the TLS section below for why issuance is
# DEFERRED until DNS resolves.
#
# ── The knobs this script consumes (env, REQUIRED, no defaults) ─────────────
#   GRAPPA_DOMAIN       public hostname → PHX_HOST + nginx server_name + the
#                       Let's Encrypt cert SAN.
#   GRAPPA_ADMIN_EMAIL  admin contact → the ACME registration email AND
#                       VAPID_SUBJECT (mailto:), the two places grappa needs a
#                       human to reach.
# The other three shared knobs (instance type, SSH CIDR, disk size) shape the
# provider's resource graph, not this script — see params.contract.
#
# ── Version pin: LATEST, on purpose ─────────────────────────────────────────
# The .deb exists ONLY as a GitHub release asset (there is no apt repo), so
# first boot fetches the LATEST release's grappa_<ver>_amd64.deb. "Pinned
# version" therefore means *latest at launch time* — there is no pin. Same
# story as infra/docker/get.sh. amd64 only (the .deb is amd64-only).
#
# Idempotent: re-running re-applies the same config (apt install of the same
# deb is a no-op, the env force-set writes the same values). The nginx site is
# rewritten only until certbot has taken it over — once it is certbot-managed a
# re-run leaves the TLS vhost intact (see write_nginx_site). bash,
# `set -euo pipefail`, shellcheck -x clean.
# Ubuntu always ships bash, so this is bash (not the strict-POSIX sh of the
# shared deploy lib) for readable string handling.
#
# The uppercase paths below are genuine config defaults (correct in
# production); they exist as seams so test/infra/cloud_first_boot_test.bats can
# sandbox the filesystem, mirroring gen-secrets.sh's GRAPPA_ENV_FILE and
# get.sh's GRAPPA_HOME.

set -euo pipefail

# ── Required operator knobs ─────────────────────────────────────────────────
# The SHAPE below is load-bearing, not style: check-drift.sh reads the
# required-env set off these assignments — `GRAPPA_X="${GRAPPA_X:-}"`, an empty
# default, means every provider door must export it, while the non-empty
# defaults further down are config/test seams no door passes. It then fails CI
# unless each door exports exactly this set. A new required knob written any
# other way silently drops out of the handshake the guard defends (#746).
GRAPPA_DOMAIN="${GRAPPA_DOMAIN:-}"
GRAPPA_ADMIN_EMAIL="${GRAPPA_ADMIN_EMAIL:-}"

# ── Config defaults (production-correct; overridable for tests) ──────────────
GRAPPA_RAW_BASE="${GRAPPA_RAW_BASE:-https://raw.githubusercontent.com/vjt/grappa-irc/main}"
GITHUB_API="${GRAPPA_GITHUB_API:-https://api.github.com/repos/vjt/grappa-irc/releases/latest}"
GRAPPA_ENV_FILE="${GRAPPA_ENV_FILE:-/etc/grappa/grappa.env}"
GRAPPA_USER="${GRAPPA_USER:-grappa}"
NGINX_SITES_AVAILABLE="${GRAPPA_NGINX_SITES_AVAILABLE:-/etc/nginx/sites-available}"
NGINX_SITES_ENABLED="${GRAPPA_NGINX_SITES_ENABLED:-/etc/nginx/sites-enabled}"
NGINX_SNIPPETS="${GRAPPA_NGINX_SNIPPETS:-/etc/nginx/snippets}"
TLS_HELPER="${GRAPPA_TLS_HELPER:-/usr/local/sbin/grappa-tls}"
TLS_UNIT="${GRAPPA_TLS_UNIT:-/etc/systemd/system/grappa-tls.service}"
HEALTH_URL="${GRAPPA_HEALTH_URL:-http://127.0.0.1:4000/healthz}"
HEALTH_RETRIES="${GRAPPA_HEALTH_RETRIES:-60}"
HEALTH_SLEEP="${GRAPPA_HEALTH_SLEEP:-2}"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# ── Preconditions ───────────────────────────────────────────────────────────
require_env() {
	[ -n "$GRAPPA_DOMAIN" ] || die "GRAPPA_DOMAIN is required (the public hostname → PHX_HOST). Refusing to boot a grappa with no host — it would mint dead links and reject every WebSocket."
	[ -n "$GRAPPA_ADMIN_EMAIL" ] || die "GRAPPA_ADMIN_EMAIL is required (ACME registration + VAPID_SUBJECT)."
	# Validate format in the SHARED script, not only in a provider's param
	# constraints — both doors consume this verbatim, and the values are
	# interpolated into an nginx server_name and the baked grappa-tls heredoc,
	# so a value carrying a quote/space/'$'/backtick must be rejected HERE.
	[[ "$GRAPPA_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
		|| die "GRAPPA_DOMAIN ('$GRAPPA_DOMAIN') is not a valid fully-qualified domain name."
	[[ "$GRAPPA_ADMIN_EMAIL" =~ ^[^@[:space:]\'\"\$\`]+@[^@[:space:]\'\"\$\`]+\.[^@[:space:]\'\"\$\`]+$ ]] \
		|| die "GRAPPA_ADMIN_EMAIL ('$GRAPPA_ADMIN_EMAIL') is not a valid email address."
}

# No test escape hatch here on purpose: an env var that skips the privilege
# check ships to production, where anything able to set it walks straight past
# the check — and because the suite set it unconditionally, the check itself
# was never once exercised (#747). The suite stubs `id` on PATH like it stubs
# apt-get and systemctl, so this runs verbatim under test.
require_root() {
	[ "$(id -u)" -eq 0 ] || die "first-boot.sh must run as root (apt, systemctl, /etc/grappa all need it)."
}

# fetch URL DEST — download to a temp then move into place, so a failed
# download never leaves a half-written file behind (mirrors get.sh).
fetch() {
	say "Fetching $1"
	curl -fsSL "$1" -o "$2.tmp" || die "download failed: $1"
	mv "$2.tmp" "$2"
}

# ── Package install (.deb = LATEST release asset) ───────────────────────────
# The latest release's amd64 .deb download URL, grep+sed (no jq on stock
# Ubuntu). Empty stdout ⇒ no matching asset (caller dies). curl is consumed
# fully into a var FIRST (not piped) so no early-terminating stage can SIGPIPE
# the download under `set -o pipefail`; `sed -n '1p'` reads all input, so it
# picks the first match without closing the pipe early either.
# Non-zero means "could not read the API"; empty stdout means "read it, no
# such asset". Keeping those apart needs the trailing `|| true`: no match makes
# grep exit 1, `set -o pipefail` promotes that to the pipeline's status, and in
# the caller's command substitution `set -e` then killed the whole script — so
# the die naming the problem was unreachable and a release without an amd64
# asset aborted first boot with exit 1 and not one word of explanation (#748).
latest_deb_url() {
	local json
	json="$(curl -fsSL "$GITHUB_API")" || return 1
	printf '%s\n' "$json" \
		| grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*_amd64\.deb"' \
		| sed 's/.*"\(https[^"]*_amd64\.deb\)".*/\1/' \
		| sed -n '1p' || true
}

install_grappa_deb() {
	export DEBIAN_FRONTEND=noninteractive
	say "apt-get update + TLS/proxy prerequisites"
	apt-get update -q
	# nginx + certbot are only Recommends of the .deb (the bouncer self-serves
	# without them); on a single TLS-terminating box we need them, so install
	# explicitly. ca-certificates + curl are pulled by the .deb Depends too,
	# but a minbase cloud image may lack curl before the .deb lands.
	apt-get install -y -q nginx certbot python3-certbot-nginx ca-certificates curl

	deb_url="$(latest_deb_url)" || die "could not read the latest release from $GITHUB_API"
	[ -n "$deb_url" ] || die "no grappa_*_amd64.deb asset in the latest release ($GITHUB_API)"
	say "Latest .deb: $deb_url"

	tmp_dir="$(mktemp -d)"
	tmp_deb="$tmp_dir/grappa.deb"
	fetch "$deb_url" "$tmp_deb"
	# apt (not dpkg -i) so the .deb's Depends resolve from the Ubuntu archive.
	# A path with a slash is treated as a local file, not a package name.
	apt-get install -y -q "$tmp_deb"
	rm -rf "$tmp_dir"
}

# ── Env file: force the operator's domain + contact in ──────────────────────
# The .deb postinstall created $GRAPPA_ENV_FILE from the template (PHX_HOST left
# REPLACE_ME) and filled the secrets via gen-secrets.sh. We force-set the two
# operator knobs, then RE-LOCK: a tmp+mv rewrite is born 0644 root:root under
# root's umask, which would drop the 0640 root:grappa lock and leak secrets
# (same discipline as gen-secrets.sh).
relock_env() {
	chown "root:${GRAPPA_USER}" "$GRAPPA_ENV_FILE" 2>/dev/null \
		|| chown root:root "$GRAPPA_ENV_FILE" 2>/dev/null || true
	chmod 0640 "$GRAPPA_ENV_FILE"
}

force_set_env() {
	local key="$1" val="$2" tmp
	tmp="$(mktemp)"
	grep -vE "^${key}=" "$GRAPPA_ENV_FILE" >"$tmp" || true
	printf '%s=%s\n' "$key" "$val" >>"$tmp"
	cat "$tmp" >"$GRAPPA_ENV_FILE"
	rm -f "$tmp"
	relock_env
}

configure_env() {
	[ -f "$GRAPPA_ENV_FILE" ] || die "$GRAPPA_ENV_FILE missing — the .deb postinstall should have created it. Aborting rather than booting a half-installed box."
	say "Setting PHX_HOST=$GRAPPA_DOMAIN + VAPID_SUBJECT in $GRAPPA_ENV_FILE"
	force_set_env PHX_HOST "$GRAPPA_DOMAIN"
	force_set_env VAPID_SUBJECT "mailto:${GRAPPA_ADMIN_EMAIL}"
}

# ── nginx: single-box HTTP front (certbot upgrades it to HTTPS) ──────────────
# The proxy surface is the #485 SSOT snippet, FETCHED at the same git ref this
# script came from (the .deb does not ship it). certbot --nginx later injects
# the 443 server + the 80→443 redirect INTO this same site file (marking its
# edits `# managed by Certbot`). So a re-run must NOT blindly overwrite the site
# once certbot owns it — that would strip TLS until maybe_issue_cert re-runs.
# The included snippet is always safe to refresh (certbot never touches it).
write_nginx_site() {
	local site="$NGINX_SITES_AVAILABLE/grappa"
	mkdir -p "$NGINX_SNIPPETS" "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED"
	fetch "$GRAPPA_RAW_BASE/infra/snippets/locations-api.conf" "$NGINX_SNIPPETS/grappa-locations-api.conf"

	# Idempotency vs certbot: once the site is certbot-managed, leave its TLS
	# vhost intact rather than reverting to HTTP-only.
	if grep -q "managed by Certbot" "$site" 2>/dev/null; then
		say "nginx site is certbot-managed — leaving the TLS vhost intact (refreshed snippet only)"
		nginx -t
		systemctl reload nginx 2>/dev/null || systemctl restart nginx
		return 0
	fi

	say "Writing nginx site for $GRAPPA_DOMAIN"
	cat >"$site" <<EOF
# grappa — single-box TLS-terminating front (#665). Written by first-boot.sh.
# certbot --nginx adds the listen 443 ssl server + the 80→443 redirect here.
upstream grappa_upstream {
    server 127.0.0.1:4000;
    keepalive 32;
}
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${GRAPPA_DOMAIN};

    # #485 SSOT dumb-proxy surface (fetched, not copied). The BEAM self-serves
    # the SPA + owns every header; nginx just forwards.
    include snippets/grappa-locations-api.conf;
}
EOF

	ln -sf "$site" "$NGINX_SITES_ENABLED/grappa"
	# Drop the stock default so our server_name wins the ACME challenge.
	rm -f "$NGINX_SITES_ENABLED/default"

	nginx -t
	systemctl reload nginx 2>/dev/null || systemctl restart nginx
}

# ── Start grappa + wait for health ──────────────────────────────────────────
wait_health() {
	local i=0
	while [ "$i" -lt "$HEALTH_RETRIES" ]; do
		if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
			say "grappa is healthy ($HEALTH_URL)"
			return 0
		fi
		i=$((i + 1))
		sleep "$HEALTH_SLEEP"
	done
	die "grappa did not become healthy at $HEALTH_URL after $HEALTH_RETRIES tries"
}

start_grappa() {
	say "Starting grappa"
	systemctl daemon-reload 2>/dev/null || true
	systemctl enable grappa.service 2>/dev/null || true
	systemctl restart grappa.service
	wait_health
}

# ── TLS: helper + boot oneshot + conditional first issue ────────────────────
# The Elastic IP is not known until the stack's Outputs show it, so DNS cannot
# resolve at first boot. Issuing certbot blind would burn Let's Encrypt's
# 5-failed-validations-per-hour quota, so we DEFER: install grappa-tls (domain
# + email baked in), enable a boot oneshot that runs it best-effort (so a
# reboot AFTER the operator points DNS self-issues), and issue NOW only if DNS
# already resolves.
install_tls_helper() {
	say "Installing $TLS_HELPER"
	mkdir -p "$(dirname "$TLS_HELPER")"
	cat >"$TLS_HELPER" <<EOF
#!/usr/bin/env bash
# grappa-tls — issue/renew this box's Let's Encrypt cert. Baked at first boot
# (#665) with the stack's domain + admin email. Idempotent: certbot skips
# re-issue inside the renewal window, and installs its own renew timer.
set -euo pipefail
DOMAIN='${GRAPPA_DOMAIN}'
EMAIL='${GRAPPA_ADMIN_EMAIL}'
if ! getent hosts "\$DOMAIN" >/dev/null 2>&1; then
	echo "grappa-tls: DNS for \$DOMAIN does not resolve yet." >&2
	echo "            Point an A record at this box's Elastic IP, then re-run: sudo grappa-tls" >&2
	exit 1
fi
exec certbot --nginx -d "\$DOMAIN" --non-interactive --agree-tos -m "\$EMAIL" --redirect
EOF
	chmod 0755 "$TLS_HELPER"
}

install_tls_unit() {
	say "Installing $TLS_UNIT (self-issue on reboot-after-DNS)"
	mkdir -p "$(dirname "$TLS_UNIT")"
	cat >"$TLS_UNIT" <<EOF
[Unit]
Description=grappa: issue Let's Encrypt cert once DNS resolves (#665)
After=network-online.target nginx.service grappa.service
Wants=network-online.target
[Service]
Type=oneshot
# Best-effort: pre-DNS this exits non-zero and boot continues; the first boot
# AFTER the operator points DNS at the Elastic IP self-issues the cert.
ExecStart=${TLS_HELPER}
[Install]
WantedBy=multi-user.target
EOF
	systemctl daemon-reload 2>/dev/null || true
	systemctl enable grappa-tls.service 2>/dev/null || true
}

maybe_issue_cert() {
	if getent hosts "$GRAPPA_DOMAIN" >/dev/null 2>&1; then
		say "DNS for $GRAPPA_DOMAIN resolves — issuing the TLS cert now"
		"$TLS_HELPER" || say "grappa-tls failed (see above) — re-run 'sudo grappa-tls' once DNS settles"
	else
		say "DNS for $GRAPPA_DOMAIN does not resolve yet — TLS DEFERRED (not burning LE quota)."
		say "Point an A record at this box's Elastic IP, then run: sudo grappa-tls"
	fi
}

final_notice() {
	cat <<EOF

grappa first-boot complete.

  Domain : $GRAPPA_DOMAIN
  Health : $HEALTH_URL
  Logs   : journalctl -u grappa -f

  If TLS was deferred: create an A record ($GRAPPA_DOMAIN → this box's
  Elastic IP, shown in the stack Outputs), then run:  sudo grappa-tls

  Back up $GRAPPA_ENV_FILE's GRAPPA_ENCRYPTION_KEY — it encrypts stored IRC
  credentials at rest; lose it and they are unrecoverable.
EOF
}

main() {
	require_env
	require_root
	install_grappa_deb
	configure_env
	write_nginx_site
	start_grappa
	install_tls_helper
	install_tls_unit
	maybe_issue_cert
	final_notice
}

main "$@"
