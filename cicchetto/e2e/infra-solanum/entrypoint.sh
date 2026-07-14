#!/bin/sh
# #221 — solanum e2e node entrypoint. Expands the conf template and execs
# solanum in the foreground (docker PID 1). Mirror of the bahamut node's
# entrypoint shape, adapted to solanum's meson layout + CLI flags.
set -eu

: "${SERVER_NAME:?SERVER_NAME is required}"
: "${SERVER_SID:?SERVER_SID is required (3 chars, e.g. 2SO)}"
: "${SERVER_DESC:=grappa e2e solanum node}"
: "${OPER_NICK:=testoper}"
: "${OPER_PASS:=testoperpass}"

PREFIX=/usr/local/solanum
ETC="${PREFIX}/etc"

# Expand only the known vars so any stray `$` in the template is left alone.
VARS='$SERVER_NAME $SERVER_SID $SERVER_DESC $OPER_NICK $OPER_PASS'
envsubst "${VARS}" < /etc/solanum/ircd.conf.tmpl > "${ETC}/ircd.conf"

# solanum refuses to boot without a MOTD file at MPATH; a stub is enough.
if [ ! -s "${ETC}/ircd.motd" ]; then
    printf 'grappa e2e solanum node — %s\n' "${SERVER_NAME}" > "${ETC}/ircd.motd"
fi

# Dump the rendered conf to stderr (modulo the oper password) for debugging.
printf '=== solanum ircd.conf (%s) ===\n' "${SERVER_NAME}" >&2
sed -e 's/password = "[^"]*"/password = "<redacted>"/' "${ETC}/ircd.conf" >&2
printf '=== end ircd.conf ===\n' >&2

# -foreground: stay attached (docker PID 1). -logfile /dev/stdout: logs to
# container stdout. -configfile: explicit path (we render there anyway).
exec "${PREFIX}/bin/solanum" \
    -foreground \
    -logfile /dev/stdout \
    -configfile "${ETC}/ircd.conf"
