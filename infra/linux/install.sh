#!/usr/bin/env bash
# grappa — first-install orchestrator for a native Linux (systemd) host.
# Run as root. Idempotent — safe to re-run (e.g. after fixing an error
# partway through).
#
# Usage:
#   PHX_HOST=irc.example.org infra/linux/install.sh
#
# Required env:
#   PHX_HOST          public hostname (no default — fails loudly, same
#                      hard-require as config/runtime.exs itself)
#
# Optional env (defaults shown):
#   REPO_ROOT=/home/grappa/grappa
#   GIT_REMOTE_URL=https://github.com/vjt/grappa-irc
#   PORT=4000
#   ENV_FILE=/etc/grappa/grappa.env
#   GRAPPA_USER=grappa
#   LISTEN_ADDR=0.0.0.0:80          (nginx, see install_nginx.sh)
#   TRUSTED_UPSTREAM_CIDR=          (nginx, see install_nginx.sh)
#
# See infra/linux/README.md for the full runbook (what each step does,
# what to do once this finishes, exposing beyond localhost).

set -euo pipefail

if [ -z "${PHX_HOST:-}" ]; then
	echo "[install] ERROR: PHX_HOST is required (e.g. PHX_HOST=irc.example.org $0)" >&2
	exit 1
fi

REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"
GIT_REMOTE_URL="${GIT_REMOTE_URL:-https://github.com/vjt/grappa-irc}"
PORT="${PORT:-4000}"
ENV_FILE="${ENV_FILE:-/etc/grappa/grappa.env}"
GRAPPA_USER="${GRAPPA_USER:-grappa}"

export REPO_ROOT GRAPPA_USER ENV_FILE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

run_as_grappa() {
	sudo -u "${GRAPPA_USER}" -H bash -c "$1"
}

# $HOME resolves to grappa's own home once run_as_grappa's `sudo -u
# ... -H` has switched user — no need to look it up here.
asdf_path_export='export PATH="$HOME/.local/bin:$HOME/.asdf/shims:$PATH"'

say "1/10 install_prereqs.sh"
"${SCRIPT_DIR}/install_prereqs.sh"

say "2/10 clone / update checkout at ${REPO_ROOT}"
if [ ! -d "${REPO_ROOT}/.git" ]; then
	mkdir -p "$(dirname "${REPO_ROOT}")"
	run_as_grappa "git clone '${GIT_REMOTE_URL}' '${REPO_ROOT}'"
else
	echo "[install] ${REPO_ROOT} already a git checkout, leaving as-is"
fi
chown -R "${GRAPPA_USER}:${GRAPPA_USER}" "${REPO_ROOT}"

say "3/10 install_toolchain.sh (erlang build from source — can take 10-20 min)"
"${SCRIPT_DIR}/install_toolchain.sh" "${REPO_ROOT}"

say "4/10 first build (mix deps.get / compile / release)"
# Full `mix deps.get` (NOT --only prod) — the secrets bootstrap below
# (step 5) runs several mix tasks under MIX_ENV=dev (the FreeBSD/
# Docker-proven chicken-and-egg workaround: a prod-env mix task reads
# config/runtime.exs, which raises on the very secrets being created).
# Those dev-env invocations need dev-only deps (credo, dialyxir,
# sobelow, ...) on disk; `--only prod` would skip them and every one
# of those tasks fails with "the dependency is not available, run
# mix deps.get" (found live on a fresh native-Linux install, 2026-07-22 — this is
# exactly what INSTALL.md's Docker quickstart.sh already does: a full
# deps.get once, then MIX_ENV=dev for secret generation). The
# MIX_ENV=prod compile/release steps below only use the prod subset
# of what's fetched; the extra dev/test deps on disk are otherwise
# unused by the release, just harmless bytes.
run_as_grappa "
	${asdf_path_export}
	cd '${REPO_ROOT}'
	mix local.hex --force
	mix local.rebar --force
	mix deps.get
	export MIX_ENV=prod
	mix compile --warnings-as-errors
	mix release --overwrite
"

say "5/10 secrets bootstrap (${ENV_FILE})"
if [ ! -f "${ENV_FILE}" ]; then
	install -o root -g "${GRAPPA_USER}" -m 0640 "${REPO_ROOT}/infra/linux/grappa.env.example" "${ENV_FILE}"
fi
chown "root:${GRAPPA_USER}" "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"

set_env_if_blank() {
	local key="$1" val="$2"
	if grep -qE "^${key}=.+$" "${ENV_FILE}" 2>/dev/null && ! grep -qE "^${key}=REPLACE_ME$" "${ENV_FILE}"; then
		return 0
	fi
	if grep -qE "^${key}=" "${ENV_FILE}"; then
		grep -v "^${key}=" "${ENV_FILE}" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "${ENV_FILE}"
	fi
	printf '%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}"
}

# Unlike secrets (never silently regenerate — set_env_if_blank), these
# are install.sh-computed config values that must always reflect THIS
# invocation's parameters. grappa.env.example ships non-blank,
# non-REPLACE_ME example values for readability (e.g.
# PHX_HOST=grappa.example.org) — set_env_if_blank would see those as
# "already set" and never overwrite them with the real PHX_HOST/PORT
# the operator actually passed in (found live on a native-Linux install,
# 2026-07-22: PHX_HOST stayed at the template's example.org forever).
force_set_env() {
	local key="$1" val="$2"
	if grep -qE "^${key}=" "${ENV_FILE}"; then
		grep -v "^${key}=" "${ENV_FILE}" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "${ENV_FILE}"
	fi
	printf '%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}"
}

# Generated under MIX_ENV=dev on purpose: prod-env mix tasks read
# config/runtime.exs, which raises on the very secrets being created
# (chicken-and-egg) — same workaround as INSTALL.md/quickstart.sh and
# the FreeBSD deploy comment block.
#
# Captures stderr instead of discarding it: with `set -e` active, a
# failing mix task inside this command substitution aborts the whole
# script immediately — and with stderr thrown away, that abort was
# SILENT (found live on a native-Linux install, 2026-07-22: three secrets got
# written as empty strings with zero indication anything had failed).
# Fail loud instead: print the captured error and exit non-zero rather
# than let a blank secret slip into the env file.
gen() {
	local out
	if ! out="$(run_as_grappa "${asdf_path_export}; cd '${REPO_ROOT}'; MIX_ENV=dev $1" 2>&1)"; then
		echo "[install] ERROR: 'MIX_ENV=dev $1' failed:" >&2
		echo "${out}" >&2
		exit 1
	fi
	printf '%s' "${out}" | tr -d '\r' | grep -v '^warning:' | tail -n1
}

if ! grep -qE "^SECRET_KEY_BASE=.+$" "${ENV_FILE}" || grep -qE "^SECRET_KEY_BASE=REPLACE_ME$" "${ENV_FILE}"; then
	set_env_if_blank SECRET_KEY_BASE "$(gen 'mix phx.gen.secret' | tail -n1)"
fi
if ! grep -qE "^SECRET_SIGNING_SALT=.+$" "${ENV_FILE}" || grep -qE "^SECRET_SIGNING_SALT=REPLACE_ME$" "${ENV_FILE}"; then
	set_env_if_blank SECRET_SIGNING_SALT "$(gen 'mix phx.gen.secret 32' | tail -n1)"
fi
if ! grep -qE "^GRAPPA_ENCRYPTION_KEY=.+$" "${ENV_FILE}" || grep -qE "^GRAPPA_ENCRYPTION_KEY=REPLACE_ME$" "${ENV_FILE}"; then
	set_env_if_blank GRAPPA_ENCRYPTION_KEY "$(gen 'mix grappa.gen_encryption_key' | tail -n1)"
fi
if ! grep -qE "^VAPID_PUBLIC_KEY=.+$" "${ENV_FILE}" || grep -qE "^VAPID_PUBLIC_KEY=REPLACE_ME$" "${ENV_FILE}"; then
	vapid="$(gen 'mix grappa.gen_vapid')"
	set_env_if_blank VAPID_PUBLIC_KEY "$(printf '%s\n' "${vapid}" | sed -n 's/^VAPID_PUBLIC_KEY=//p')"
	set_env_if_blank VAPID_PRIVATE_KEY "$(printf '%s\n' "${vapid}" | sed -n 's/^VAPID_PRIVATE_KEY=//p')"
fi
if ! grep -qE "^RELEASE_COOKIE=.+$" "${ENV_FILE}" || grep -qE "^RELEASE_COOKIE=REPLACE_ME$" "${ENV_FILE}"; then
	set_env_if_blank RELEASE_COOKIE "$(openssl rand -hex 32)"
fi
force_set_env DATABASE_PATH "${REPO_ROOT}/runtime/grappa_prod.db"
force_set_env UPLOADS_STORAGE_ROOT "${REPO_ROOT}/runtime/uploads"
force_set_env PHX_HOST "${PHX_HOST}"
force_set_env PORT "${PORT}"

mkdir -p "${REPO_ROOT}/runtime/uploads"
chown -R "${GRAPPA_USER}:${GRAPPA_USER}" "${REPO_ROOT}/runtime"

say "6/10 first migration"
# Plain `mix ecto.migrate`, NOT `release.sh eval 'Grappa.Release.migrate()'`.
# Found live on a native-Linux install (2026-07-22): the packaged release's `eval`
# (and `remote`/`rpc`, which share the same `--boot
# "$REL_VSN_DIR/$RELEASE_BOOT_SCRIPT_CLEAN"` code path in the
# mix-release-generated bin/grappa script) crashes the BEAM at kernel
# boot — "Kernel pid terminated (logger)", a persistent_term/code_server
# badarg — even for a trivial `eval '1 + 1'`. This is NOT a Grappa
# problem: raw `erl -eval` and, critically, `bin/grappa start` (the
# FULL boot, i.e. exactly what systemd's ExecStart uses) both work
# fine — it's isolated to the release's minimal "start_clean" boot
# variant specifically. Root cause not yet fully identified (see
# infra/linux/README.md "Day-2 operations"); `mix ecto.migrate` sidesteps it entirely and matches
# what Docker's own deploy path already does (docs/OPERATIONS.md:
# "Docker via `mix ecto.migrate`, the jail via
# `Grappa.Release.migrate()`") — this substrate keeps the full mix
# toolchain around (unlike a minimal prod container), so there's no
# reason to route through the release's eval mechanism at all here.
run_as_grappa "
	${asdf_path_export}
	set -a; . '${ENV_FILE}'; set +a
	export MIX_ENV=prod
	cd '${REPO_ROOT}'
	mix ecto.migrate
"

say "7/10 cic_build.sh"
"${SCRIPT_DIR}/cic_build.sh" "${REPO_ROOT}"

say "8/10 install_systemd.sh"
"${SCRIPT_DIR}/install_systemd.sh"

say "9/10 install_nginx.sh"
LISTEN_ADDR="${LISTEN_ADDR:-0.0.0.0:80}" TRUSTED_UPSTREAM_CIDR="${TRUSTED_UPSTREAM_CIDR:-}" REPO_ROOT="${REPO_ROOT}" "${SCRIPT_DIR}/install_nginx.sh"

say "10/10 starting grappa + healthcheck"
systemctl start grappa

deadline=$((SECONDS + 120))
until curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; do
	if [ "${SECONDS}" -ge "${deadline}" ]; then
		die "healthcheck timed out — inspect with: journalctl -u grappa -n 200"
	fi
	printf '.'
	sleep 2
done
printf '\n'

say "grappa is up and healthy"
cat <<EOF

  Health:   curl http://127.0.0.1:${PORT}/healthz
  Logs:     journalctl -u grappa -f
  Status:   systemctl status grappa

  IMPORTANT — back up ${ENV_FILE}'s GRAPPA_ENCRYPTION_KEY now, somewhere
  safe and separate. It encrypts stored IRC/NickServ passwords at rest —
  lose it and those credentials are unrecoverable.

  Phoenix binds 0.0.0.0:${PORT} (not env-configurable) — firewall
  ${PORT} to localhost-only before exposing this host publicly. Only
  nginx (127.0.0.1) and, at the network layer, the trusted upstream
  reverse-proxy box should be able to reach it.

  Create your first user (same mix task INSTALL.md uses for the Docker
  path — runs via the checkout's own toolchain, not the release, since
  it's a mix task rather than a Grappa.Release.* function):
    sudo -u ${GRAPPA_USER} -H bash -c '
      export PATH="\$HOME/.local/bin:\$HOME/.asdf/shims:\$PATH"
      set -a; . ${ENV_FILE}; set +a
      cd ${REPO_ROOT}
      MIX_ENV=prod mix grappa.create_user --name you --password "change-me"
    '

  Bind an IRC network: see README.md "Bind a network".
EOF
