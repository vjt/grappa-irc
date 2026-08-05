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
# shellcheck disable=SC2016  # deferred expansion is the point (see above)
asdf_path_export='export PATH="$HOME/.local/bin:$HOME/.asdf/shims:$PATH"'

say "1/11 install_prereqs.sh"
"${SCRIPT_DIR}/install_prereqs.sh"

say "2/11 clone / update checkout at ${REPO_ROOT}"
if [ ! -d "${REPO_ROOT}/.git" ]; then
	# The target may sit below a root-owned parent (the default is
	# /home/grappa/grappa). Create the checkout directory itself with the
	# runtime user's ownership before cloning as that user.
	install -d -o "${GRAPPA_USER}" -g "${GRAPPA_USER}" -m 0755 "${REPO_ROOT}"
	run_as_grappa "git clone '${GIT_REMOTE_URL}' '${REPO_ROOT}'"
else
	echo "[install] ${REPO_ROOT} already a git checkout, leaving as-is"
fi
chown -R "${GRAPPA_USER}:${GRAPPA_USER}" "${REPO_ROOT}"

say "3/11 install_toolchain.sh (erlang build from source — can take 10-20 min)"
"${SCRIPT_DIR}/install_toolchain.sh" "${REPO_ROOT}"

say "4/11 first build (mix deps.get / compile / release)"
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

say "5/11 secrets bootstrap (${ENV_FILE})"
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
	# The grep -v >tmp && mv above replaces ENV_FILE with a fresh inode born
	# under root's umask (0644 root:root), dropping the 0640 root:grappa set
	# at creation — re-lock, or the secrets this file holds go world-readable
	# (chmod alone is not enough: the grappa daemon reads it via the group).
	chown "root:${GRAPPA_USER}" "${ENV_FILE}"
	chmod 0640 "${ENV_FILE}"
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
	# Re-lock after the tmp+mv rewrite (see set_env_if_blank). force_set_env
	# runs last (config values, after the secrets), so without this the final
	# ENV_FILE is left 0644 root:root with every secret world-readable.
	chown "root:${GRAPPA_USER}" "${ENV_FILE}"
	chmod 0640 "${ENV_FILE}"
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
#
# `gen_raw` is the shared run+fail-loud+strip-warnings step; `gen`
# additionally takes only the LAST line, which is correct for the
# single-line generators (phx.gen.secret, gen_encryption_key) but
# WRONG for `mix grappa.gen_vapid` — that task prints FOUR lines
# (VAPID_PUBLIC_KEY=, VAPID_PRIVATE_KEY=, then two comment lines), so
# routing it through `gen`'s `tail -n1` silently kept only the last
# comment line and discarded BOTH keys — found live 2026-07-24:
# VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY ended up empty in grappa.env,
# `Grappa.Push.boot/0`'s `System.get_env(...) || raise` didn't catch
# it either (an env var set to `""` is not `nil`, so the `||` never
# fires), so the app booted "fine" with a broken Web Push config —
# no crash, no log line, subscriptions just silently never worked.
# VAPID generation now calls `gen_raw` directly and greps each key
# out of the full multi-line output instead of going through `gen`.
gen_raw() {
	local out
	if ! out="$(run_as_grappa "${asdf_path_export}; cd '${REPO_ROOT}'; MIX_ENV=dev $1" 2>&1)"; then
		echo "[install] ERROR: 'MIX_ENV=dev $1' failed:" >&2
		echo "${out}" >&2
		exit 1
	fi
	printf '%s' "${out}" | tr -d '\r' | grep -v '^warning:'
}

gen() {
	gen_raw "$1" | tail -n1
}

# Capture, CHECK, then write — never `set_env_if_blank KEY "$(gen ...)"`.
#
# In argument position a command substitution's failure cannot stop this
# script: `gen_raw`'s `exit 1` exits the SUBSHELL, and the enclosing command's
# status is `set_env_if_blank`'s, so neither `set -e` nor `pipefail` ever sees
# it. So the loud ERROR the comment above promises got printed and the blank
# was written anyway. Worse than the noise: if the failing generator was not
# the VAPID one (whose explicit empty-check below is OUTSIDE a substitution,
# and is the only reason any of this ever aborted), the run continued to
# `systemctl start` and exited 0 announcing a healthy host — with
# GRAPPA_ENCRYPTION_KEY set to the empty string, i.e. a Cloak vault keyed on
# nothing. Measured, #441.
#
# Assigning first makes the failure real (`set -euo pipefail` fires on the
# assignment), and the emptiness check additionally catches a generator that
# exits 0 with nothing to say — the shape that killed VAPID in 2026-07-24.
require_nonempty() {
	local key="$1" what="$2" value="$3"
	if [ -z "${value}" ]; then
		echo "[install] ERROR: '${what}' produced an empty ${key} — refusing to write a blank secret" >&2
		exit 1
	fi
}

if ! grep -qE "^SECRET_KEY_BASE=.+$" "${ENV_FILE}" || grep -qE "^SECRET_KEY_BASE=REPLACE_ME$" "${ENV_FILE}"; then
	secret_key_base="$(gen 'mix phx.gen.secret')"
	require_nonempty SECRET_KEY_BASE 'mix phx.gen.secret' "${secret_key_base}"
	set_env_if_blank SECRET_KEY_BASE "${secret_key_base}"
fi
if ! grep -qE "^SECRET_SIGNING_SALT=.+$" "${ENV_FILE}" || grep -qE "^SECRET_SIGNING_SALT=REPLACE_ME$" "${ENV_FILE}"; then
	signing_salt="$(gen 'mix phx.gen.secret 32')"
	require_nonempty SECRET_SIGNING_SALT 'mix phx.gen.secret 32' "${signing_salt}"
	set_env_if_blank SECRET_SIGNING_SALT "${signing_salt}"
fi
if ! grep -qE "^GRAPPA_ENCRYPTION_KEY=.+$" "${ENV_FILE}" || grep -qE "^GRAPPA_ENCRYPTION_KEY=REPLACE_ME$" "${ENV_FILE}"; then
	encryption_key="$(gen 'mix grappa.gen_encryption_key')"
	require_nonempty GRAPPA_ENCRYPTION_KEY 'mix grappa.gen_encryption_key' "${encryption_key}"
	set_env_if_blank GRAPPA_ENCRYPTION_KEY "${encryption_key}"
fi
# Regeneration trigger checks BOTH keys, not just the public one — a
# guard on VAPID_PUBLIC_KEY alone would leave a
# public-set/private-blank state (however it arose) permanently stuck,
# since install.sh's idempotency means this block would never run
# again once the public half looked fine.
vapid_key_needs_gen() {
	! grep -qE "^${1}=.+$" "${ENV_FILE}" || grep -qE "^${1}=REPLACE_ME$" "${ENV_FILE}"
}

if vapid_key_needs_gen VAPID_PUBLIC_KEY || vapid_key_needs_gen VAPID_PRIVATE_KEY; then
	vapid="$(gen_raw 'mix grappa.gen_vapid')"
	vapid_public="$(printf '%s\n' "${vapid}" | sed -n 's/^VAPID_PUBLIC_KEY=//p')"
	vapid_private="$(printf '%s\n' "${vapid}" | sed -n 's/^VAPID_PRIVATE_KEY=//p')"
	# Belt-and-braces: `gen_raw` already fails loud on a non-zero exit,
	# but a future change to gen_vapid's output shape (or a truncated
	# capture) could still hand back exit 0 with an empty match here —
	# catch that explicitly rather than silently writing a blank key.
	if [ -z "${vapid_public}" ] || [ -z "${vapid_private}" ]; then
		echo "[install] ERROR: 'mix grappa.gen_vapid' produced an empty key — raw output:" >&2
		echo "${vapid}" >&2
		exit 1
	fi
	# force_set_env (not set_env_if_blank): once regeneration is
	# triggered, the fresh pair MUST land as a matched unit. If only one
	# key needed regenerating, set_env_if_blank would skip the
	# already-valid half and keep it paired with a brand-new,
	# unrelated other half — a mismatched public/private pair is
	# unusable, worse than either being blank.
	force_set_env VAPID_PUBLIC_KEY "${vapid_public}"
	force_set_env VAPID_PRIVATE_KEY "${vapid_private}"
fi
if ! grep -qE "^RELEASE_COOKIE=.+$" "${ENV_FILE}" || grep -qE "^RELEASE_COOKIE=REPLACE_ME$" "${ENV_FILE}"; then
	# Same capture-check-write shape as the mix generators above: openssl in
	# argument position could fail into a blank cookie just as silently.
	release_cookie="$(openssl rand -hex 32)"
	require_nonempty RELEASE_COOKIE 'openssl rand -hex 32' "${release_cookie}"
	set_env_if_blank RELEASE_COOKIE "${release_cookie}"
fi
force_set_env DATABASE_PATH "${REPO_ROOT}/runtime/grappa_prod.db"
force_set_env UPLOADS_STORAGE_ROOT "${REPO_ROOT}/runtime/uploads"
force_set_env PHX_HOST "${PHX_HOST}"
force_set_env PORT "${PORT}"

mkdir -p "${REPO_ROOT}/runtime/uploads"
chown -R "${GRAPPA_USER}:${GRAPPA_USER}" "${REPO_ROOT}/runtime"

say "6/11 first migration"
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

say "7/11 seed built-in themes"
run_as_grappa "
	${asdf_path_export}
	set -a; . '${ENV_FILE}'; set +a
	cd '${REPO_ROOT}'
	MIX_ENV=prod mix grappa.seed_themes
"

say "8/11 cic_build.sh"
"${SCRIPT_DIR}/cic_build.sh" "${REPO_ROOT}"

say "9/11 install_systemd.sh"
"${SCRIPT_DIR}/install_systemd.sh"

say "10/11 install_nginx.sh"
LISTEN_ADDR="${LISTEN_ADDR:-0.0.0.0:80}" TRUSTED_UPSTREAM_CIDR="${TRUSTED_UPSTREAM_CIDR:-}" REPO_ROOT="${REPO_ROOT}" "${SCRIPT_DIR}/install_nginx.sh"

say "11/11 starting grappa + healthcheck"
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
