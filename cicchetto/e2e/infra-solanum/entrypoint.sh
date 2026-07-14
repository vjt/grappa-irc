#!/bin/sh
# #221 — solanum e2e node entrypoint. Runs as ROOT first (to repair
# resolv.conf for authd), then drops to the unprivileged `ircd` user via
# gosu before exec'ing solanum (which refuses to run as root). Mirror of
# the bahamut node's entrypoint shape, adapted to solanum's meson layout,
# CLI flags, and authd DNS requirement.
set -eu

: "${SERVER_NAME:?SERVER_NAME is required}"
: "${SERVER_SID:?SERVER_SID is required (3 chars, e.g. 2SO)}"
: "${SERVER_DESC:=grappa e2e solanum node}"
: "${OPER_NICK:=testoper}"
: "${OPER_PASS:=testoperpass}"
# EXPORT so envsubst (a child process) sees the defaulted values — `:=`
# assigns to the shell var but does NOT export, so an unset-then-defaulted
# var would render empty in the conf (solanum then fatals on e.g. an empty
# serverinfo description). compose.yaml passes these as real env vars, but
# the export keeps a bare `docker run` (no -e) booting too.
export SERVER_NAME SERVER_SID SERVER_DESC OPER_NICK OPER_PASS

PREFIX=/usr/local/solanum
ETC="${PREFIX}/etc"

# --- authd DNS repair (runs as root) ----------------------------------
# solanum's authd resolver reads /etc/resolv.conf ONCE at boot and DIES
# ("DNS: no name servers") if it finds no usable nameserver — and a dead
# authd STALLS every non-loopback client registration (a network peer gets
# zero bytes back, register times out). Two failure modes we repair:
#   1. docker adds `options ndots:0`, which authd's minimal parser chokes on.
#   2. authd REJECTS a loopback nameserver (docker's embedded 127.0.0.11),
#      so a resolv.conf with only that is "no name servers" to authd.
# Rewrite resolv.conf to a bare, non-loopback nameserver with no options.
# rDNS still fails gracefully per-connection ("Couldn't look up your
# hostname") — we only need authd ALIVE, not accurate. Compose also sets
# `dns:`/`dns_opt:` (honoured on Linux CI); this rewrite is the
# belt-and-braces that also works under Docker Desktop, which overrides
# `dns:` back to the loopback resolver.
if [ "$(id -u)" = "0" ]; then
    printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf || true
fi

# Render the conf (envsubst only the known vars so a stray `$` in the
# template is left alone) and make it readable by the ircd user.
VARS='$SERVER_NAME $SERVER_SID $SERVER_DESC $OPER_NICK $OPER_PASS'
envsubst "${VARS}" < /etc/solanum/ircd.conf.tmpl > "${ETC}/ircd.conf"

# solanum refuses to boot without a MOTD file at MPATH; a stub is enough.
if [ ! -s "${ETC}/ircd.motd" ]; then
    printf 'grappa e2e solanum node — %s\n' "${SERVER_NAME}" > "${ETC}/ircd.motd"
fi

# The etc/ files were just written as root; hand them back to ircd so the
# dropped-privilege solanum can read (and rewrite ircd.conf on rehash).
if [ "$(id -u)" = "0" ]; then
    chown -R ircd: "${ETC}" || true
fi

# Dump the rendered conf to stderr (modulo the oper password) for debugging.
printf '=== solanum ircd.conf (%s) ===\n' "${SERVER_NAME}" >&2
sed -e 's/password = "[^"]*"/password = "<redacted>"/' "${ETC}/ircd.conf" >&2
printf '=== end ircd.conf ===\n' >&2

# -foreground: stay attached (docker PID 1). -logfile /dev/stdout: logs to
# container stdout. -configfile: explicit path (we render there anyway).
# Drop to ircd via gosu when we started as root (solanum refuses root).
SOLANUM_CMD="${PREFIX}/bin/solanum -foreground -logfile /dev/stdout -configfile ${ETC}/ircd.conf"
if [ "$(id -u)" = "0" ]; then
    exec gosu ircd sh -c "exec ${SOLANUM_CMD}"
else
    exec sh -c "exec ${SOLANUM_CMD}"
fi
