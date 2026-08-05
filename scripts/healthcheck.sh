#!/usr/bin/env bash
# Curl the grappa /healthz endpoint.
#
# Usage:
#   scripts/healthcheck.sh
#
# #485 dropped the nginx container — grappa self-serves everything now, so
# this probes grappa directly. The probe runs from INSIDE the container, so
# it's independent of host port binding.

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

in_container curl -fsS http://localhost:4000/healthz
echo
