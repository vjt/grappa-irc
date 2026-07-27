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
# Tear down with:  scripts/quickstart-stop.sh
#
# ---- Serving it under a real hostname (staging box) -------------------
#
# The stack's own nginx listens on plain HTTP on HTTP_BIND — that IS the
# listener you put your own TLS front door in front of. Nothing here
# terminates TLS or installs a vhost on your host; the script only RENDERS
# a ready-to-include front-door config from the shipped example, with your
# values filled in, and tells you where it wrote it.
#
#   PHX_HOST=grappa.example.org scripts/quickstart.sh
#
# PHX_HOST is load-bearing: it is the source of the host-alias set the app
# derives upload links and origin checks from (lib/grappa/http_hosts.ex).
# Leaving it at `localhost` while serving the box under a real name mints
# links pointing at the wrong host, silently (#468). Pass it explicitly and
# it overwrites a previously-written value in .env.
#
# ---- Seeding a network + user (optional) ------------------------------
#
# Set SEED_USER to get an instance that is already connected when you log
# in, instead of an empty one you have to wire by hand:
#
#   PHX_HOST=grappa.example.org SEED_USER=you SEED_AUTOJOIN='#grappa' \
#     scripts/quickstart.sh
#
# Knobs (all optional except SEED_USER):
#   SEED_USER      account name — setting it enables seeding
#   SEED_PASSWORD  account password (generated and printed when unset)
#   SEED_NETWORK   network slug            (default: azzurra)
#   SEED_SERVER    host:port               (default: irc.azzurra.chat:6697)
#   SEED_NICK      IRC nick                (default: $SEED_USER)
#   SEED_AUTH      auto|sasl|server_pass|nickserv_identify|none (default: none)
#   SEED_NICK_PASSWORD  upstream auth password, when SEED_AUTH needs one
#   SEED_AUTOJOIN  comma-separated channels (default: none)
#
# Seeding is idempotent in the sense that re-running never breaks a live
# box: an existing account or an existing binding is reported and skipped,
# not overwritten. The seeded account is test-grade — do not reuse a
# password you care about.

set -euo pipefail

# ---- locate repo root (this script lives in scripts/) -----------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Pin to the committed compose file only — no override auto-merge. Every
# compose invocation in this script reuses this array.
COMPOSE=(docker compose -f compose.yaml)

# Host port the PWA is served on (nginx → grappa). Loopback-only by
# default; override before running to expose on a LAN IP. Same rule as
# PHX_HOST below: a value passed on this run must win over whatever a
# previous run (or .env.example, which publishes on ALL interfaces) left
# behind, otherwise the box quietly serves somewhere else than asked.
HTTP_BIND_EXPLICIT=0
[ -n "${HTTP_BIND+x}" ] && HTTP_BIND_EXPLICIT=1
HTTP_BIND="${HTTP_BIND:-127.0.0.1:3000}"

# Public hostname the box is served under. `localhost` keeps the plain
# localhost install working (browsers treat http://localhost as a secure
# context, so the PWA works without TLS). Anything else means a front door
# is in play — remember whether the caller asked for it, because a value
# passed explicitly must WIN over what a previous run left in .env.
PHX_HOST_EXPLICIT=0
[ -n "${PHX_HOST+x}" ] && PHX_HOST_EXPLICIT=1
PHX_HOST="${PHX_HOST:-localhost}"

# Front-door rendering: cert paths are placeholders in the shipped example
# and get substituted here so the emitted file is directly includable.
FRONTEND_SSL_CERT="${FRONTEND_SSL_CERT:-/etc/ssl/grappa/fullchain.pem}"
FRONTEND_SSL_KEY="${FRONTEND_SSL_KEY:-/etc/ssl/grappa/privkey.pem}"

# Optional seeding (see the header). SEED_USER is the switch.
SEED_USER="${SEED_USER:-}"
SEED_NETWORK="${SEED_NETWORK:-azzurra}"
SEED_SERVER="${SEED_SERVER:-irc.azzurra.chat:6697}"
SEED_NICK="${SEED_NICK:-$SEED_USER}"
SEED_AUTH="${SEED_AUTH:-none}"
SEED_NICK_PASSWORD="${SEED_NICK_PASSWORD:-}"
SEED_AUTOJOIN="${SEED_AUTOJOIN:-}"
# #475 — the seeded account is an admin by DEFAULT. The admin console is
# the only place some install-level switches live (visitor access, chiefly),
# so a box seeded without it is one you cannot finish configuring from the
# UI it just handed you. SEED_ADMIN=0 for a box that should deliberately
# start with no administrator.
SEED_ADMIN="${SEED_ADMIN:-1}"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# ---- 0. preflight -----------------------------------------------------
say "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "docker not found — install Docker Engine first."
docker compose version >/dev/null 2>&1 || die "docker compose v2 not found — install the Compose plugin."
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon — is it running / do you have permission?"
[ -f compose.yaml ] || die "compose.yaml not in $REPO_ROOT — run this from a grappa checkout."

# compose.yaml pins `container_name`, so those names belong to the docker
# daemon and not to a compose project: a second checkout that installs its
# own box collides with the first at `up` — "The container name /grappa is
# already in use" — after this script has already written .env, built the
# image and seeded an account. Say who owns it now, while nothing has
# happened yet. Asking the container for its own compose label beats
# guessing the project name, which is the directory basename and can
# coincide across checkouts.
for cname in $(sed -n 's/^[[:space:]]*container_name:[[:space:]]*//p' compose.yaml); do
  owner="$(docker inspect --format \
    '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
    "$cname" 2>/dev/null)" || continue      # not running: nothing to clash with
  if [ -n "$owner" ] && [ "$owner" != "$REPO_ROOT" ]; then
    warn "container '$cname' is already up, but it belongs to another checkout:"
    warn "  $owner"
    die "one box per host: update that one with $owner/scripts/quickstart-update.sh, or stop it first ($owner/scripts/quickstart-stop.sh)."
  fi
done

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

# force_env KEY VALUE — set KEY unconditionally, replacing any existing
# value. Used only for what the caller passed on this run: a second run
# with a different PHX_HOST must actually move the box, not silently keep
# the first run's hostname (the #468 failure mode is a stale, wrong host).
force_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env 2>/dev/null; then
    grep -v "^${key}=" .env > .env.tmp && mv .env.tmp .env
  fi
  printf '%s=%s\n' "$key" "$val" >> .env
}

ENV_CREATED_NOW=0
if [ ! -f .env ]; then
  say "Creating .env from .env.example"
  cp .env.example .env
  ENV_CREATED_NOW=1
fi

say "Configuring .env for a full-stack run under ${PHX_HOST}"
set_env MIX_ENV prod
set_env CONTAINER_UID "$(id -u)"
set_env CONTAINER_GID "$(id -g)"
if [ "$PHX_HOST_EXPLICIT" -eq 1 ] || [ "$ENV_CREATED_NOW" -eq 1 ]; then
  # A .env just copied from the example carries the example's hostname,
  # which is someone else's host — inheriting it is the copy-trap that
  # mints upload links pointing away from this box (#468). Whatever this
  # run resolved to (the caller's value, or `localhost`) wins over it.
  force_env PHX_HOST "$PHX_HOST"
else
  set_env PHX_HOST "$PHX_HOST"
  # An earlier run (or a hand-edited .env) may already pin a different
  # host; the rendered front-door config below must describe the box as it
  # will actually behave, not as this invocation defaulted.
  PHX_HOST="$(sed -n 's/^PHX_HOST=//p' .env | tail -n1)"
  PHX_HOST="${PHX_HOST:-localhost}"
fi
set_env GRAPPA_PUBLISH 127.0.0.1:4000
if [ "$HTTP_BIND_EXPLICIT" -eq 1 ] || [ "$ENV_CREATED_NOW" -eq 1 ]; then
  force_env NGINX_PUBLISH "${HTTP_BIND}:80"
else
  set_env NGINX_PUBLISH "${HTTP_BIND}:80"
  # Report (and proxy to) the port the stack will really publish, which an
  # earlier run may have pinned elsewhere.
  published="$(sed -n 's/^NGINX_PUBLISH=//p' .env | tail -n1)"
  published="${published%:80}"
  case "$published" in
    '')      ;;                                   # nothing pinned — keep ours
    *:*)     HTTP_BIND="$published" ;;            # addr:port, as-is
    *)       HTTP_BIND="127.0.0.1:${published}" ;;  # bare port (compose's short form)
  esac
fi

# ---- 3. build the image -----------------------------------------------
# Toolchain image (#364 docker S1) — just the base + apk packages, no
# deps baked, so the first build only pulls/extracts layers (~1-2 min).
say "Building the grappa toolchain image (first run downloads the base — be patient)"
"${COMPOSE[@]}" build grappa

# ---- 4. bootstrap toolchain + deps against the bind-mount -------------
# compose mounts ./:/app, and hex/deps/_build all live under /app. The
# image ships no baked deps (they would be shadowed by the mount), so a
# fresh clone must install them into the mounted tree once here (dev env —
# these tasks never read prod secrets). This is the standalone twin of the
# bin/start.sh first-boot self-heal; running it up front keeps the later
# `up` fast + healthy inside the health-timeout.
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

# ---- 6b. seed an account + network (optional) -------------------------
# Runs BEFORE the stack comes up on purpose: Bootstrap reads the binding at
# boot, so seeding first means the very first `up` already dials out and the
# operator's first login lands on a connected session.
#
# Neither task is destructive on a second run — `create_user` fails on a
# duplicate name and `bind_network` fails on an existing (user, network)
# credential — so both failures are downgraded to a note instead of
# aborting an otherwise healthy install.
if [ -n "$SEED_USER" ]; then
  if [ -z "${SEED_PASSWORD:-}" ]; then
    SEED_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-20)"
  fi

  # #475 — `--admin` is part of the same command, not a second step:
  # `create_user` grants the bit through `Accounts.update_admin_flags/2`
  # right after creation. Note this only fires on CREATION — an account
  # that already exists keeps whatever flags it has, which is why the
  # re-run path below cannot promote anything.
  create_args=(mix grappa.create_user --name "$SEED_USER" --password "$SEED_PASSWORD")
  [ "$SEED_ADMIN" != "0" ] && create_args+=(--admin)

  if [ "$SEED_ADMIN" != "0" ]; then
    say "Seeding account '${SEED_USER}' (admin)"
  else
    say "Seeding account '${SEED_USER}'"
  fi

  SEED_ACCOUNT_EXISTED=0
  if ! "${COMPOSE[@]}" run --rm --no-deps -T grappa "${create_args[@]}"; then
    SEED_ACCOUNT_EXISTED=1
    warn "account '${SEED_USER}' was not created (it most likely already exists) — keeping the existing one."
    warn "the password printed below is then NOT the account's password, and its admin flag is unchanged."
  fi

  say "Binding ${SEED_USER} → ${SEED_NETWORK} (${SEED_SERVER}) as ${SEED_NICK}"
  bind_args=(mix grappa.bind_network
    --user "$SEED_USER" --network "$SEED_NETWORK"
    --server "$SEED_SERVER" --nick "$SEED_NICK" --auth "$SEED_AUTH")
  [ -n "$SEED_NICK_PASSWORD" ] && bind_args+=(--password "$SEED_NICK_PASSWORD")
  [ -n "$SEED_AUTOJOIN" ] && bind_args+=(--autojoin "$SEED_AUTOJOIN")
  if ! "${COMPOSE[@]}" run --rm --no-deps -T grappa "${bind_args[@]}"; then
    warn "binding not created — ${SEED_USER} is probably already bound to ${SEED_NETWORK}."
    warn "change an existing binding with: ${COMPOSE[*]} run --rm grappa mix grappa.update_network_credential --help"
  fi
fi

# ---- 6c. seed the built-in theme gallery ------------------------------
# #475 — deliberately OUTSIDE the SEED_USER block: the curated gallery is
# a property of the install, not of the optional seeded account, so a box
# with no seeded user still ships its themes instead of landing with an
# empty picker. Idempotent by construction — the task upserts each
# built-in on `(system owner, name)`, so re-running refreshes rows in
# place and adds new schemes without duplicating anything.
#
# Not fatal: an empty gallery is a cosmetic defect, and failing the whole
# install over it would be a worse trade than a warning on a box that is
# otherwise healthy.
say "Seeding the built-in theme gallery"
if ! "${COMPOSE[@]}" run --rm --no-deps -T grappa mix grappa.seed_themes; then
  warn "theme seeding failed — the box works, but the gallery starts empty."
  warn "retry with: ${COMPOSE[*]} run --rm grappa mix grappa.seed_themes"
fi

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

# ---- 8b. render the front-door config ---------------------------------
# The shipped example carries <placeholders>; fill them with what this box
# actually runs so the file can be included as-is. The upstream is the
# published HTTP port — a wildcard bind is rewritten to loopback, since a
# proxy on the same host must not dial 0.0.0.0.
FRONTEND_CONF="runtime/nginx-frontend.conf"
UPSTREAM="$HTTP_BIND"
case "$UPSTREAM" in
  0.0.0.0:*) UPSTREAM="127.0.0.1:${UPSTREAM##*:}" ;;
  '[::]:'*)  UPSTREAM="127.0.0.1:${UPSTREAM##*:}" ;;
esac

sed -e "s|<your-domain>|${PHX_HOST}|g" \
    -e "s|^  server 127\.0\.0\.1:3000;|  server ${UPSTREAM};|" \
    -e "s|^  ssl_certificate     .*|  ssl_certificate     ${FRONTEND_SSL_CERT};|" \
    -e "s|^  ssl_certificate_key .*|  ssl_certificate_key ${FRONTEND_SSL_KEY};|" \
    infra/nginx-tls-frontend.example.conf > "$FRONTEND_CONF"

# ---- 9. done ----------------------------------------------------------
say "grappa is up and healthy 🎉"
cat <<EOF

  Web UI:   http://${HTTP_BIND}/
  Health:   curl http://${HTTP_BIND}/healthz
  PHX_HOST: ${PHX_HOST}

  Front-door config rendered for ${PHX_HOST} → ${UPSTREAM}:
    ${REPO_ROOT}/${FRONTEND_CONF}
  Include it from your own nginx (this script installs nothing on the
  host) and point the certificate lines at a certificate your browser
  trusts.
EOF

if [ "$PHX_HOST" != "localhost" ]; then
  cat <<EOF
  Serving it over plain HTTP under that name will look like it works and
  will not: service workers refuse to register off-localhost without TLS,
  and an untrusted certificate is refused too — so push, offline and
  install silently disappear, which is exactly what a staging box is
  supposed to let you test. Use a trusted cert (mkcert on a LAN, ACME in
  public).
EOF
fi

if [ -n "$SEED_USER" ]; then
  # #475 — on a re-run the account already existed, so `create_user` never
  # ran and the password above is one this script invented and threw away.
  # Printing it as "the credentials" is how someone spends ten minutes
  # failing to log into their own box.
  if [ "${SEED_ACCOUNT_EXISTED:-0}" -eq 1 ]; then
    cat <<EOF

  Account:         ${SEED_USER} — already exists, left untouched.
                   The password shown above does not apply to it, and its
                   admin flag was not changed. Rotate the password with:
                     ${COMPOSE[*]} run --rm grappa mix run -e \\
                       'Grappa.Accounts.get_user_by_name("${SEED_USER}") |> Grappa.Accounts.update_password(%{password: "new-one"})'
  Seeded network:  ${SEED_NETWORK} → ${SEED_SERVER} as ${SEED_NICK}${SEED_AUTOJOIN:+ (autojoin ${SEED_AUTOJOIN})}
EOF
  else
    cat <<EOF

  Seeded account:  ${SEED_USER} / ${SEED_PASSWORD}
  Account role:    $([ "$SEED_ADMIN" != "0" ] && printf 'admin — the console is at the cog, "admin console"' || printf 'plain user (SEED_ADMIN=0)')
  Seeded network:  ${SEED_NETWORK} → ${SEED_SERVER} as ${SEED_NICK}${SEED_AUTOJOIN:+ (autojoin ${SEED_AUTOJOIN})}
  Test-grade credentials — the account is a login for this box, nothing else.
EOF
  fi
else
  cat <<EOF

  Create your first user (then log in via the web UI):
    ${COMPOSE[*]} run --rm grappa mix grappa.create_user --name you --password 'change-me'

  Bind an IRC network: see README.md "Bind a network".
EOF
fi

cat <<EOF

  Stop the stack:      scripts/quickstart-stop.sh
EOF
