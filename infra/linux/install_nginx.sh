#!/usr/bin/env bash
# Install the dumb reverse-proxy nginx config + shared snippet on a native
# Linux host, enable/reload the service. The BEAM self-serves the SPA and
# owns every header (#485), so there is no cicchetto-dist symlink and no
# security-headers snippet — only the two substrate-agnostic snippets: the
# proxy locations and the shared access-log format (#1029).
#
# Idempotent — re-run after `git pull` (or to change
# LISTEN_ADDR/TRUSTED_UPSTREAM_CIDR) to refresh the config.
#
# Env overrides:
#   REPO_ROOT              default /home/grappa/grappa
#   LISTEN_ADDR             default 0.0.0.0:80
#   TRUSTED_UPSTREAM_CIDR   optional — if set, nginx only accepts
#                            connections from this CIDR (the upstream
#                            TLS-terminating box). If unset, installs
#                            with no source-IP restriction and prints a
#                            loud warning rather than silently
#                            defaulting open.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
LISTEN_ADDR="${LISTEN_ADDR:-0.0.0.0:80}"
TRUSTED_UPSTREAM_CIDR="${TRUSTED_UPSTREAM_CIDR:-}"

NGINX_ETC="/etc/nginx"

echo "[install_nginx] rendering nginx.conf (listen=${LISTEN_ADDR})"
if [ -n "${TRUSTED_UPSTREAM_CIDR}" ]; then
	trusted_block="        allow ${TRUSTED_UPSTREAM_CIDR};
        deny all;"
else
	echo "[install_nginx] WARNING: TRUSTED_UPSTREAM_CIDR not set — no source-IP restriction installed. Set it once the upstream reverse-proxy box's address is known and re-run." >&2
	trusted_block="        # TRUSTED_UPSTREAM_CIDR not set at install time — no source-IP allowlist."
fi

tmp_conf="$(mktemp)"
trap 'rm -f "${tmp_conf}"' EXIT
# Bash string substitution, not sed: @TRUSTED_UPSTREAM_BLOCK@ expands to a
# multi-line allow/deny pair, and sed's `s|find|replace|` chokes on an
# embedded newline in the replacement.
template_content="$(cat "${REPO_ROOT}/infra/linux/nginx.conf")"
template_content="${template_content//@LISTEN_ADDR@/${LISTEN_ADDR}}"
template_content="${template_content//@TRUSTED_UPSTREAM_BLOCK@/${trusted_block}}"
printf '%s\n' "${template_content}" >"${tmp_conf}"

echo "[install_nginx] installing config + snippets"
install -o root -g root -m 0644 "${tmp_conf}" "${NGINX_ETC}/nginx.conf"
mkdir -p "${NGINX_ETC}/snippets"
install -o root -g root -m 0644 "${REPO_ROOT}/infra/snippets/locations-api.conf" "${NGINX_ETC}/snippets/locations-api.conf"
# #1029 — nginx.conf includes this one too; miss it and `nginx -t` below
# fails AFTER the config has already been written to /etc/nginx.
install -o root -g root -m 0644 "${REPO_ROOT}/infra/snippets/log-format.conf" "${NGINX_ETC}/snippets/log-format.conf"

echo "[install_nginx] nginx -t"
nginx -t

echo "[install_nginx] enabling nginx"
systemctl enable nginx >/dev/null

if systemctl is-active --quiet nginx; then
	echo "[install_nginx] reloading nginx"
	systemctl reload nginx
else
	echo "[install_nginx] starting nginx"
	systemctl start nginx
fi

echo "[install_nginx] done. probe:"
curl -fsS -w "HTTP %{http_code}\n" "http://127.0.0.1/healthz" -o /dev/null || true
