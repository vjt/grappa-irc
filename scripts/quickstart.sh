#!/usr/bin/env bash
# grappa — one-command vanilla Docker install (full stack on localhost).
#
# Clones-and-goes: generates every secret, writes .env, builds the image,
# runs migrations, brings up the full prod profile (bouncer + cicchetto
# PWA behind nginx), and polls /healthz until the stack is green.
#
# This is the STANDALONE install path — deliberately plain `docker
# compose -f compose.yaml`, NO scripts/_lib.sh, NO compose.override.yaml,
# NO per-host machinery. It is independent of the operator deploy tooling
# (scripts/deploy.sh, deploy-m42.sh) which targets a specific production
# host. Re-running it is safe: existing secrets in .env are never
# regenerated, and an already-up stack is just reconciled.
#
# Usage:
#   scripts/quickstart.sh           # install + start + validate
#
# After it finishes the bouncer's web UI is at http://localhost:3000.
# Tear down with:  docker compose -f compose.yaml --profile prod down

set -euo pipefail

# ---- locate repo root (this script lives in scripts/) -----------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Pin to the committed compose file only — no override auto-merge. Every
# compose invocation in this script reuses this array.
COMPOSE=(docker compose -f compose.yaml)

# Host port the PWA is served on (nginx → grappa). Loopback-only by
# default; override before running to expose on a LAN IP.
HTTP_BIND="${HTTP_BIND:-127.0.0.1:3000}"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# ---- 0. preflight -----------------------------------------------------
say "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "docker not found — install Docker Engine first."
docker compose version >/dev/null 2>&1 || die "docker compose v2 not found — install the Compose plugin."
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon — is it running / do you have permission?"
[ -f compose.yaml ] || die "compose.yaml not in $REPO_ROOT — run this from a grappa checkout."

# ---- 1. host-owned runtime dirs (avoid root-owned bind-mount mkdir) ---
# Compose would auto-create missing bind-mount sources as root; pre-make
# them so the container (UID = you) can write.
mkdir -p runtime/cicchetto-dist runtime/bun-cache runtime/uploads

# ---- 2. .env scaffolding ----------------------------------------------
# set_env KEY VALUE — set KEY only if it is absent or blank in .env.
set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=.+" .env 2>/dev/null; then
    return 0  # already has a non-empty value — leave it
  fi
  if grep -qE "^${key}=" .env 2>/dev/null; then
    # present but blank — fill in place (portable sed: write temp, swap)
    grep -v "^${key}=" .env > .env.tmp && mv .env.tmp .env
  fi
  printf '%s=%s\n' "$key" "$val" >> .env
}

if [ ! -f .env ]; then
  say "Creating .env from .env.example"
  cp .env.example .env
fi

say "Configuring .env for a localhost full-stack run"
set_env MIX_ENV prod
set_env CONTAINER_UID "$(id -u)"
set_env CONTAINER_GID "$(id -g)"
set_env PHX_HOST localhost
set_env GRAPPA_PUBLISH 127.0.0.1:4000
set_env NGINX_PUBLISH "${HTTP_BIND}:80"

# ---- 3. build the image -----------------------------------------------
# First build pulls the elixir alpine base + compiles deps (~5-10 min).
say "Building the grappa image (first run downloads + compiles — be patient)"
"${COMPOSE[@]}" build grappa

# ---- 4. bootstrap toolchain + deps against the bind-mount -------------
# compose mounts ./:/app, shadowing the image's baked hex/deps with the
# host tree. A fresh clone has neither, so install them into the mounted
# tree once (dev env — these tasks never read prod secrets).
say "Installing hex/rebar + fetching deps into the checkout"
"${COMPOSE[@]}" run --rm --no-deps -T -e MIX_ENV=dev grappa \
  mix do local.hex --force, local.rebar --force, deps.get, compile

# ---- 5. generate secrets (only the blank ones) ------------------------
# Generated in dev env on purpose: a prod-env mix task would evaluate
# config/runtime.exs, which raises on the very secrets we are about to
# create (chicken-and-egg).
gen() { "${COMPOSE[@]}" run --rm --no-deps -T -e MIX_ENV=dev grappa "$@" 2>/dev/null | tr -d '\r'; }

needs_secret() { ! grep -qE "^$1=.+" .env; }

if needs_secret SECRET_KEY_BASE; then
  say "Generating SECRET_KEY_BASE"
  set_env SECRET_KEY_BASE "$(gen mix phx.gen.secret | tail -n1)"
fi
if needs_secret SECRET_SIGNING_SALT; then
  say "Generating SECRET_SIGNING_SALT"
  set_env SECRET_SIGNING_SALT "$(gen mix phx.gen.secret 64 | tail -n1)"
fi
if needs_secret GRAPPA_ENCRYPTION_KEY; then
  say "Generating GRAPPA_ENCRYPTION_KEY (back this up — losing it loses stored creds)"
  set_env GRAPPA_ENCRYPTION_KEY "$(gen mix grappa.gen_encryption_key | tail -n1)"
fi
if needs_secret VAPID_PUBLIC_KEY || needs_secret VAPID_PRIVATE_KEY; then
  say "Generating VAPID keypair (Web Push)"
  vapid="$(gen mix grappa.gen_vapid)"
  set_env VAPID_PUBLIC_KEY  "$(printf '%s\n' "$vapid" | sed -n 's/^VAPID_PUBLIC_KEY=//p')"
  set_env VAPID_PRIVATE_KEY "$(printf '%s\n' "$vapid" | sed -n 's/^VAPID_PRIVATE_KEY=//p')"
fi
if needs_secret RELEASE_COOKIE; then
  say "Generating RELEASE_COOKIE (Erlang distribution cookie)"
  set_env RELEASE_COOKIE "$(gen elixir -e 'IO.puts(Base.encode16(:crypto.strong_rand_bytes(32), case: :lower))' | tail -n1)"
fi

# ---- 6. migrate the database ------------------------------------------
# Runs to completion BEFORE the long-running container starts so Bootstrap
# never races a pending migration. Prod env here — secrets now exist.
say "Running database migrations"
"${COMPOSE[@]}" run --rm --no-deps grappa mix ecto.migrate

# ---- 7. bring up the full stack ---------------------------------------
say "Starting the stack (grappa + cicchetto build + nginx)"
"${COMPOSE[@]}" --profile prod up -d

# ---- 8. wait for health ----------------------------------------------
# Probe /healthz via nginx from inside the container — independent of the
# host port binding. First boot recompiles prod from the mounted tree, so
# the window is generous.
say "Waiting for /healthz (first boot compiles prod — up to ~10 min)"
deadline=$((SECONDS + 600))
until "${COMPOSE[@]}" exec -T nginx wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    warn "stack did not become healthy in time. Inspect with:"
    warn "  ${COMPOSE[*]} --profile prod logs --tail=200 grappa"
    die "health check timed out"
  fi
  printf '.'; sleep 3
done
printf '\n'

# ---- 9. done ----------------------------------------------------------
say "grappa is up and healthy 🎉"
cat <<EOF

  Web UI:   http://${HTTP_BIND}/
  Health:   curl http://${HTTP_BIND}/healthz

  Create your first user (then log in via the web UI):
    ${COMPOSE[*]} run --rm grappa mix grappa.create_user --name you --password 'change-me'

  Bind an IRC network: see README.md "Bind a network".
  Stop the stack:      ${COMPOSE[*]} --profile prod down
EOF
