#!/bin/sh
# Install nginx config + snippets in jail, symlink cic dist, enable + start service.
#
# Invoke from m42 host:
#   sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_install_nginx.sh
#
# Idempotent — re-run after `git pull` to refresh nginx config.

set -eu

REPO_ROOT="/home/grappa/grappa"
NGINX_ETC="/usr/local/etc/nginx"
# Shared with the Docker substrate (`compose.yaml` bind-mounts
# `./runtime/cicchetto-dist`) so `Grappa.Cic.Bundle.@bundle_path`
# reads the same anchor everywhere. jail_cic_build.sh writes here via
# `npm run build -- --outDir ../runtime/cicchetto-dist`.
CIC_DIST="${REPO_ROOT}/runtime/cicchetto-dist"
# Jail-writable path — bastille thin-jail mounts /usr/share read-only,
# so the Docker side's /usr/share/nginx/html convention is off-limits.
# nginx.conf's `root` directive points here.
SPA_LINK="/usr/local/www/cic"

echo "[install_nginx] copying config + snippets"
install -o root -g wheel -m 0644 "${REPO_ROOT}/infra/freebsd/nginx.conf" "${NGINX_ETC}/nginx.conf"
mkdir -p "${NGINX_ETC}/snippets"
install -o root -g wheel -m 0644 "${REPO_ROOT}/infra/snippets/locations-api.conf" "${NGINX_ETC}/snippets/locations-api.conf"
install -o root -g wheel -m 0644 "${REPO_ROOT}/infra/snippets/security-headers.conf" "${NGINX_ETC}/snippets/security-headers.conf"

echo "[install_nginx] linking SPA dist -> ${SPA_LINK}"
if [ ! -d "${CIC_DIST}" ]; then
	echo "[install_nginx] ERROR: ${CIC_DIST} not present — run jail_cic_build.sh first" >&2
	exit 1
fi
mkdir -p "$(dirname "${SPA_LINK}")"
rm -f "${SPA_LINK}"
ln -sf "${CIC_DIST}" "${SPA_LINK}"

echo "[install_nginx] nginx -t"
nginx -t

echo "[install_nginx] sysrc nginx_enable=YES"
sysrc nginx_enable=YES

if service nginx status >/dev/null 2>&1; then
	echo "[install_nginx] reloading nginx"
	service nginx reload
else
	echo "[install_nginx] starting nginx"
	service nginx start
fi

echo "[install_nginx] done. probe:"
curl -fsS -w "HTTP %{http_code}\n" http://10.66.6.7/healthz -o /dev/null || true
