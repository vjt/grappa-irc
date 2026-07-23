#!/usr/bin/env bash
# Install nginx config + snippets on a native Linux host, symlink the
# cicchetto dist, enable/reload the service.
#
# Port of infra/freebsd/jail_install_nginx.sh. Idempotent — re-run
# after `git pull` (or to change LISTEN_ADDR/TRUSTED_UPSTREAM_CIDR) to
# refresh the config.
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
# Shared anchor with every other substrate — Grappa.Cic.Bundle reads
# runtime/cicchetto-dist regardless of which deploy path built it.
CIC_DIST="${REPO_ROOT}/runtime/cicchetto-dist"
SPA_LINK="/var/www/grappa/cic"

if [ ! -d "${CIC_DIST}" ]; then
	echo "[install_nginx] ERROR: ${CIC_DIST} not present — run cic_build.sh first" >&2
	exit 1
fi

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
# Bash string substitution, not sed: @TRUSTED_UPSTREAM_BLOCK@ is
# multi-line (the allow/deny pair), and sed's `s|find|replace|`
# chokes on an unescaped embedded newline in the replacement text
# ("unterminated `s' command" — found live on a native-Linux install,
# 2026-07-22). `${var//find/replace}` handles multi-line values fine.
template_content="$(cat "${REPO_ROOT}/infra/linux/nginx.conf")"
template_content="${template_content//@LISTEN_ADDR@/${LISTEN_ADDR}}"
template_content="${template_content//@TRUSTED_UPSTREAM_BLOCK@/${trusted_block}}"
printf '%s\n' "${template_content}" >"${tmp_conf}"

echo "[install_nginx] installing config + snippets"
install -o root -g root -m 0644 "${tmp_conf}" "${NGINX_ETC}/nginx.conf"
mkdir -p "${NGINX_ETC}/snippets"
install -o root -g root -m 0644 "${REPO_ROOT}/infra/snippets/locations-api.conf" "${NGINX_ETC}/snippets/locations-api.conf"
install -o root -g root -m 0644 "${REPO_ROOT}/infra/snippets/security-headers.conf" "${NGINX_ETC}/snippets/security-headers.conf"

echo "[install_nginx] linking SPA dist -> ${SPA_LINK}"
mkdir -p "$(dirname "${SPA_LINK}")"
rm -f "${SPA_LINK}"
ln -sf "${CIC_DIST}" "${SPA_LINK}"

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
