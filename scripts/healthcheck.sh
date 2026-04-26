#!/bin/bash
# Curl the grappa /healthz endpoint.
#
# Usage:
#   scripts/healthcheck.sh                     # via the LAN IP
#                                              #   dev:  192.168.53.11:4000 (grappa direct)
#                                              #   prod: 192.168.53.11:80   (nginx → grappa)
#   scripts/healthcheck.sh --inside            # from inside the container
#
# Set GRAPPA_PROD=1 to probe the prod stack (nginx port 80). In dev,
# grappa owns vlan53 192.168.53.11 directly on :4000; in prod, nginx
# owns that IP on :80 and reverse-proxies /healthz to grappa.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

if [ "${1:-}" = "--inside" ]; then
    in_container curl -fsS http://localhost:4000/healthz
    echo
elif [ "${GRAPPA_PROD:-}" = "1" ]; then
    curl -fsS http://192.168.53.11/healthz
    echo
else
    curl -fsS http://192.168.53.11:4000/healthz
    echo
fi
