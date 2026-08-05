#!/usr/bin/env bash
# grappa — verb-dispatched standalone Docker deploy (#503 unit B).
#
# One entry point for the vanilla single-host Docker box, replacing the
# three quickstart scripts (now thin forwarders — see scripts/quickstart*.sh):
#
#   deploy.sh install   fresh clones-and-goes bring-up: generate secrets,
#                       write .env, build the toolchain image, migrate,
#                       optionally seed a user+network, start the prod
#                       profile, wait for /healthz, render a front-door
#                       config. Config via env vars (PHX_HOST, HTTP_BIND,
#                       SEED_*, FRONTEND_SSL_*) — see the block below.
#   deploy.sh update    pull, then let the SHARED deploy algorithm
#                       (infra/lib/deploy_common.sh, the same lib driving
#                       the jail + linux + operator-docker substrates)
#                       classify hot-vs-cold via Grappa.Deploy.Preflight:
#                       HOT → POST /admin/reload (sessions preserved), COLD
#                       → recreate. This is the #503 win — quickstart-update
#                       ALWAYS recreated, on a hand-maintained regex table.
#   deploy.sh stop      take the prod profile all the way down
#                       (--profile prod down --remove-orphans [--volumes]).
#   deploy.sh           (bare) idempotent "make it so": no .env on disk →
#                       install, otherwise update. The single command a
#                       curl|bash one-liner (unit D) can always run.
#
# This is the STANDALONE path — deliberately plain `docker compose -f
# compose.yaml`, NO scripts/_lib.sh, NO compose.override.yaml, NO per-host
# machinery. It is independent of the operator deploy tooling
# (scripts/deploy.sh, deploy-m42.sh) which targets a specific production
# host. Re-running any verb is safe.
#
# ---- Serving it under a real hostname (staging box) -------------------
#
# The grappa container listens on plain HTTP on HTTP_BIND — that IS the
# listener you put your own TLS front door in front of. `install` RENDERS
# a ready-to-include front-door config from the shipped example (it
# installs nothing on the host) and tells you where it wrote it.
#
#   PHX_HOST=grappa.example.org infra/docker/deploy.sh install
#
# PHX_HOST is load-bearing: it is the source of the host-alias set the app
# derives upload links and origin checks from (lib/grappa/http_hosts.ex).
# Leaving it at `localhost` while serving under a real name mints links
# pointing at the wrong host, silently (#468). Pass it explicitly and it
# overwrites a previously-written value in .env.
#
# ---- Seeding a network + user (optional) ------------------------------
#
# Set SEED_USER on `install` to get an instance already connected on first
# login instead of an empty one:
#
#   PHX_HOST=grappa.example.org SEED_USER=you SEED_AUTOJOIN='#grappa' \
#     infra/docker/deploy.sh install
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
#   SEED_ADMIN     1 (default) grants the seeded account the admin bit;
#                  0 for a box that deliberately starts with no admin.

set -euo pipefail

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# ---- detect deploy mode (F5, #503 unit D) -----------------------------
# ONE script, two substrates. A real checkout runs the SOURCE-mode path
# (bind-mount dev image, compose, hot-on-HOT). A checkout-less host (the
# `curl|bash` one-liner / a `docker run` of the published ghcr image) runs
# the RELEASE-IMAGE path: no source, no compose, no mix — plain `docker`
# against ghcr.io/vjt/grappa, COLD-only updates (hot-on-image is #503 unit
# E). The source tree next to this script is the discriminator: a real
# checkout has compose.yaml two levels up (infra/docker/ → repo root); a
# curl'd copy sitting in $GRAPPA_HOME does not. GRAPPA_DEPLOY_MODE forces
# it (source|release) for tests + operators who want no guessing.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANDIDATE_ROOT="$(cd "$SELF_DIR/../.." 2>/dev/null && pwd)" || CANDIDATE_ROOT=""

# The ONE secret generator (#862), shared with the .deb/.rpm postinstall and
# the release image's first-boot bootstrap. Resolved relative to THIS script
# so it works from a checkout and from the $GRAPPA_HOME mirror get.sh lays
# down — both keep the repo's infra/docker + infra/packaging layout.
GEN_SECRETS="$SELF_DIR/../packaging/gen-secrets.sh"

case "${GRAPPA_DEPLOY_MODE:-}" in
	source)  DEPLOY_MODE=source ;;
	release) DEPLOY_MODE=release ;;
	'')
		if [ -n "$CANDIDATE_ROOT" ] && [ -f "$CANDIDATE_ROOT/compose.yaml" ]; then
			DEPLOY_MODE=source
		else
			DEPLOY_MODE=release
		fi
		;;
	*) die "GRAPPA_DEPLOY_MODE must be 'source' or 'release' (got '${GRAPPA_DEPLOY_MODE}')." ;;
esac

if [ "$DEPLOY_MODE" = source ]; then
	# ---- source mode: operate the checkout via compose ----------------
	REPO_ROOT="$CANDIDATE_ROOT"
	cd "$REPO_ROOT"
	# Pin to the committed compose file only — no override auto-merge.
	# Every compose invocation reuses this array.
	COMPOSE=(docker compose -f compose.yaml)
else
	# ---- release-image mode: checkout-less, docker-only ---------------
	# State (the prod env file, with every secret) lives per-user so the
	# `update` verb finds the box `install` created. /data is a named
	# docker volume — nothing is written into a checkout, because there is
	# none. All knobs are env-overridable for testing + odd hosts.
	GRAPPA_HOME="${GRAPPA_HOME:-$HOME/.grappa}"
	ENV_FILE="$GRAPPA_HOME/grappa.env"
	GRAPPA_IMAGE="${GRAPPA_IMAGE:-ghcr.io/vjt/grappa:latest}"
	GRAPPA_CONTAINER="${GRAPPA_CONTAINER:-grappa}"
	GRAPPA_DATA_VOLUME="${GRAPPA_DATA_VOLUME:-grappa-data}"
	GRAPPA_PUBLISH="${GRAPPA_PUBLISH:-127.0.0.1:4000}"
fi

usage() {
	cat >&2 <<EOF
usage: infra/docker/deploy.sh {install|update|stop} [options]
       infra/docker/deploy.sh                 (bare) install if no .env, else update

  install                fresh bring-up (config via env: PHX_HOST, HTTP_BIND, SEED_*)
  update [--no-pull] [--force-hot|--force-cold]
                         pull + preflight → hot-on-HOT / recreate-on-COLD
  stop [--volumes|-v]    take the prod profile down (--remove-orphans)
EOF
	exit 64
}

# ---- prerequisites ----------------------------------------------------
require_compose_file() {
	[ -f compose.yaml ] || die "compose.yaml not in $REPO_ROOT — run this from a grappa checkout."
}

require_docker() {
	command -v docker >/dev/null 2>&1 || die "docker not found — install Docker Engine first."
	docker compose version >/dev/null 2>&1 || die "docker compose v2 not found — install the Compose plugin."
}

# ---- the cic build's version input (#538/#652, #692) ------------------
# vite bakes GRAPPA_VERSION into <meta cicchetto-version> and REFUSES to build
# without it rather than ship a bundle that lies about its version. The
# cicchetto-build container mounts only ./cicchetto, so it cannot read the
# repo-root VERSION file itself: this wrapper derives it and compose passes it
# through (`GRAPPA_VERSION: ${GRAPPA_VERSION:-}`).
#
# Called AT each launch point rather than once at startup, for two reasons.
# `update` pulls before it builds, so a startup derive would stamp the bundle
# with the version the box was ALREADY on — the exact staleness #652 exists to
# prevent, and invisible because the build still succeeds. And `stop` must not
# depend on a readable VERSION: a box you cannot bring down because a file went
# missing is the trap cmd_stop is written to avoid.
export_cic_version() {
	GRAPPA_VERSION="$(infra/packaging/version.sh)" \
		|| die "could not derive the version from $REPO_ROOT/VERSION — is this a complete checkout?"
	export GRAPPA_VERSION
}

# ---- one-box-per-host ownership guard ---------------------------------
# compose.yaml pins `container_name`, so those names belong to the docker
# daemon and not to a compose project: a second checkout that operates its
# own box collides with the first — "The container name /grappa is already
# in use" — which names neither the owner nor the fix. Ask the running
# container who owns it (docker's own compose label) and refuse if the
# answer is not us, while nothing has happened yet. Sets BOX_RUNNING=1 if
# any pinned container exists (so `stop` can report a genuine no-op).
assert_box_ownership() {
	BOX_RUNNING=0
	# shellcheck disable=SC2013  # container_name values are single tokens; word-split is intended
	for cname in $(sed -n 's/^[[:space:]]*container_name:[[:space:]]*//p' compose.yaml); do
		if owner="$(docker inspect --format \
			'{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
			"$cname" 2>/dev/null)"; then
			BOX_RUNNING=1
			if [ -n "$owner" ] && [ "$owner" != "$REPO_ROOT" ]; then
				warn "container '$cname' is up, but it belongs to another checkout:"
				warn "  $owner"
				die "one box per host: operate that box from its own checkout, or stop it first ($owner/infra/docker/deploy.sh stop)."
			fi
		fi
	done
}

# ---- .env helpers -----------------------------------------------------
# set_env KEY VALUE — set KEY only if it is absent or blank in .env.
set_env() {
	local key="$1" val="$2"
	if grep -qE "^${key}=.+" .env 2>/dev/null; then
		return 0
	fi
	if grep -qE "^${key}=" .env 2>/dev/null; then
		grep -v "^${key}=" .env > .env.tmp && mv .env.tmp .env
	fi
	printf '%s=%s\n' "$key" "$val" >> .env
}

# force_env KEY VALUE — set KEY unconditionally, replacing any existing
# value. Used only for what the caller passed on this run: a second run
# with a different PHX_HOST must actually move the box, not silently keep
# the first run's hostname (the #468 failure mode).
force_env() {
	local key="$1" val="$2"
	if grep -qE "^${key}=" .env 2>/dev/null; then
		grep -v "^${key}=" .env > .env.tmp && mv .env.tmp .env
	fi
	printf '%s=%s\n' "$key" "$val" >> .env
}

# migrate_publish_env — a box created by a pre-#485 checkout carries
# NGINX_PUBLISH=<host>:80 (the LAN-facing nginx container) and
# GRAPPA_PUBLISH=127.0.0.1:4000 (grappa behind nginx). nginx is gone;
# grappa must take over that LAN binding. Rewrite .env in place, mapping
# the container side :80 → :4000 (compose re-appends :4000). Deprecated
# alias honoured once, with a one-line warning. Idempotent — a no-op once
# NGINX_PUBLISH is gone.
migrate_publish_env() {
	grep -qE '^NGINX_PUBLISH=' .env || return 0

	local old host_side cur
	old="$(sed -n 's/^NGINX_PUBLISH=//p' .env | tail -n1)"
	cur="$(sed -n 's/^GRAPPA_PUBLISH=//p' .env | tail -n1)"
	host_side="${old%:80}"
	[ -n "$host_side" ] || host_side="127.0.0.1:3000"

	grep -vE '^NGINX_PUBLISH=' .env > .env.tmp && mv .env.tmp .env

	if [ -z "$cur" ] || [ "$cur" = "127.0.0.1:4000" ]; then
		warn "NGINX_PUBLISH is deprecated (#485 dropped the nginx container). Rewriting .env: GRAPPA_PUBLISH=${host_side} (grappa serves directly now), removing NGINX_PUBLISH."
		grep -vE '^GRAPPA_PUBLISH=' .env > .env.tmp && mv .env.tmp .env
		printf 'GRAPPA_PUBLISH=%s\n' "$host_side" >> .env
	else
		warn "NGINX_PUBLISH is deprecated (#485) and was removed from .env. Your GRAPPA_PUBLISH=${cur} is kept — verify it publishes grappa where your TLS front door proxies."
	fi
}

# published_bind — echo the host:port GRAPPA_PUBLISH actually publishes,
# loopback-normalised for display (a wildcard/bare-port bind is shown as
# loopback, since a URL nobody listens on is the #469 failure mode).
published_bind() {
	local p
	p="$(sed -n 's/^GRAPPA_PUBLISH=//p' .env 2>/dev/null | tail -n1)"
	case "$p" in
		'')            printf '127.0.0.1:4000' ;;
		0.0.0.0:*)     printf '127.0.0.1:%s' "${p##*:}" ;;
		'[::]:'*)      printf '127.0.0.1:%s' "${p##*:}" ;;
		*:*)           printf '%s' "$p" ;;
		*)             printf '127.0.0.1:%s' "$p" ;;
	esac
}

# ======================================================================
# verb: install
# ======================================================================
cmd_install() {
	[ $# -eq 0 ] || usage

	# Host port the PWA is served on (grappa, directly — #485 dropped
	# nginx). A value passed on this run must win over what a previous run
	# (or .env.example) left behind, else the box quietly serves elsewhere.
	local HTTP_BIND_EXPLICIT=0
	[ -n "${HTTP_BIND+x}" ] && HTTP_BIND_EXPLICIT=1
	local HTTP_BIND="${HTTP_BIND:-127.0.0.1:3000}"

	local PHX_HOST_EXPLICIT=0
	[ -n "${PHX_HOST+x}" ] && PHX_HOST_EXPLICIT=1
	local PHX_HOST="${PHX_HOST:-localhost}"

	local FRONTEND_SSL_CERT="${FRONTEND_SSL_CERT:-/etc/ssl/grappa/fullchain.pem}"
	local FRONTEND_SSL_KEY="${FRONTEND_SSL_KEY:-/etc/ssl/grappa/privkey.pem}"

	local SEED_USER="${SEED_USER:-}"
	local SEED_NETWORK="${SEED_NETWORK:-azzurra}"
	local SEED_SERVER="${SEED_SERVER:-irc.azzurra.chat:6697}"
	local SEED_NICK="${SEED_NICK:-$SEED_USER}"
	local SEED_AUTH="${SEED_AUTH:-none}"
	local SEED_NICK_PASSWORD="${SEED_NICK_PASSWORD:-}"
	local SEED_AUTOJOIN="${SEED_AUTOJOIN:-}"
	# #475 — the seeded account is an admin by DEFAULT: the admin console
	# is the only place some install-level switches live (visitor access),
	# so a box seeded without it cannot be finished from the UI it hands
	# you. SEED_ADMIN=0 for a box that should start with no administrator.
	local SEED_ADMIN="${SEED_ADMIN:-1}"

	# ---- 0. preflight -------------------------------------------------
	say "Checking prerequisites"
	require_docker
	docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon — is it running / do you have permission?"
	require_compose_file
	assert_box_ownership

	# ---- 1. host-owned runtime dirs (avoid root-owned bind-mount mkdir)
	mkdir -p runtime/cicchetto-dist runtime/bun-cache runtime/uploads

	# ---- 2. .env scaffolding ------------------------------------------
	local ENV_CREATED_NOW=0
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
		# A .env just copied from the example carries the example's
		# hostname, which is someone else's host — inheriting it is the
		# copy-trap that mints upload links pointing away from this box
		# (#468). Whatever this run resolved to wins over it.
		force_env PHX_HOST "$PHX_HOST"
	else
		set_env PHX_HOST "$PHX_HOST"
		PHX_HOST="$(sed -n 's/^PHX_HOST=//p' .env | tail -n1)"
		PHX_HOST="${PHX_HOST:-localhost}"
	fi
	# #485 — grappa is the LAN-facing service now (no nginx in front), so
	# it publishes on HTTP_BIND. compose.yaml appends :4000, so
	# GRAPPA_PUBLISH carries only the host side (addr:port, or a bare port).
	if [ "$HTTP_BIND_EXPLICIT" -eq 1 ] || [ "$ENV_CREATED_NOW" -eq 1 ]; then
		force_env GRAPPA_PUBLISH "${HTTP_BIND}"
	else
		set_env GRAPPA_PUBLISH "${HTTP_BIND}"
		local published
		published="$(sed -n 's/^GRAPPA_PUBLISH=//p' .env | tail -n1)"
		case "$published" in
			'')      ;;
			*:*)     HTTP_BIND="$published" ;;
			*)       HTTP_BIND="127.0.0.1:${published}" ;;
		esac
	fi

	# #485 — a pre-change box carries NGINX_PUBLISH. `install` does NOT
	# migrate it (only `update` does): re-installing here would leave
	# grappa on the loopback default and silently orphan the old LAN URL.
	# Warn and point at the upgrade path rather than half-migrate.
	if grep -qE '^NGINX_PUBLISH=' .env; then
		warn "This box predates #485 (NGINX_PUBLISH is set — the nginx container was dropped)."
		warn "install does NOT migrate the port binding; run 'infra/docker/deploy.sh update'"
		warn "instead — it rewrites NGINX_PUBLISH → GRAPPA_PUBLISH and sweeps the stale grappa-nginx."
	fi

	# ---- 3. build the image -------------------------------------------
	say "Building the grappa toolchain image (first run downloads the base — be patient)"
	"${COMPOSE[@]}" build grappa

	# ---- 4. bootstrap toolchain + deps against the bind-mount ---------
	say "Installing hex/rebar + fetching deps into the checkout"
	# shellcheck disable=SC1010  # `mix do` is a mix subcommand, not shell `do`
	"${COMPOSE[@]}" run --rm --no-deps -T -e MIX_ENV=dev grappa \
		mix do local.hex --force, local.rebar --force, deps.get, compile

	# ---- 5. generate secrets (only the blank ones) --------------------
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
		local vapid
		vapid="$(gen mix grappa.gen_vapid)"
		set_env VAPID_PUBLIC_KEY  "$(printf '%s\n' "$vapid" | sed -n 's/^VAPID_PUBLIC_KEY=//p')"
		set_env VAPID_PRIVATE_KEY "$(printf '%s\n' "$vapid" | sed -n 's/^VAPID_PRIVATE_KEY=//p')"
	fi
	if needs_secret RELEASE_COOKIE; then
		say "Generating RELEASE_COOKIE (Erlang distribution cookie)"
		set_env RELEASE_COOKIE "$(gen elixir -e 'IO.puts(Base.encode16(:crypto.strong_rand_bytes(32), case: :lower))' | tail -n1)"
	fi

	# ---- 6. migrate the database --------------------------------------
	say "Running database migrations"
	"${COMPOSE[@]}" run --rm --no-deps grappa mix ecto.migrate

	# ---- 6b. seed an account + network (optional) ---------------------
	# Runs BEFORE the stack comes up: Bootstrap reads the binding at boot,
	# so the very first `up` already dials out. Neither task is destructive
	# on a second run (duplicate name / existing credential both fail), so
	# both failures downgrade to a note instead of aborting a healthy box.
	local SEED_ACCOUNT_EXISTED=0
	if [ -n "$SEED_USER" ]; then
		local SEED_PASSWORD="${SEED_PASSWORD:-}"
		if [ -z "$SEED_PASSWORD" ]; then
			SEED_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-20)"
		fi

		# #475 — `--admin` is part of the same command: create_user grants
		# the bit right after creation, only on CREATION (an existing
		# account keeps its flags).
		local create_args=(mix grappa.create_user --name "$SEED_USER" --password "$SEED_PASSWORD")
		[ "$SEED_ADMIN" != "0" ] && create_args+=(--admin)

		if [ "$SEED_ADMIN" != "0" ]; then
			say "Seeding account '${SEED_USER}' (admin)"
		else
			say "Seeding account '${SEED_USER}'"
		fi

		if ! "${COMPOSE[@]}" run --rm --no-deps -T grappa "${create_args[@]}"; then
			SEED_ACCOUNT_EXISTED=1
			warn "account '${SEED_USER}' was not created (it most likely already exists) — keeping the existing one."
			warn "the password printed below is then NOT the account's password, and its admin flag is unchanged."
		fi

		say "Binding ${SEED_USER} → ${SEED_NETWORK} (${SEED_SERVER}) as ${SEED_NICK}"
		local bind_args=(mix grappa.bind_network
			--user "$SEED_USER" --network "$SEED_NETWORK"
			--server "$SEED_SERVER" --nick "$SEED_NICK" --auth "$SEED_AUTH")
		[ -n "$SEED_NICK_PASSWORD" ] && bind_args+=(--password "$SEED_NICK_PASSWORD")
		[ -n "$SEED_AUTOJOIN" ] && bind_args+=(--autojoin "$SEED_AUTOJOIN")
		if ! "${COMPOSE[@]}" run --rm --no-deps -T grappa "${bind_args[@]}"; then
			warn "binding not created — ${SEED_USER} is probably already bound to ${SEED_NETWORK}."
			warn "change an existing binding with: ${COMPOSE[*]} run --rm grappa mix grappa.update_network_credential --help"
		fi
	fi

	# ---- 6c. seed the built-in theme gallery --------------------------
	# #475 — OUTSIDE the SEED_USER block: the curated gallery is a property
	# of the install, so a box with no seeded user still ships its themes.
	# Idempotent (upsert on (system owner, name)); not fatal (an empty
	# gallery is cosmetic, not worth failing a healthy install over).
	say "Seeding the built-in theme gallery"
	if ! "${COMPOSE[@]}" run --rm --no-deps -T grappa mix grappa.seed_themes; then
		warn "theme seeding failed — the box works, but the gallery starts empty."
		warn "retry with: ${COMPOSE[*]} run --rm grappa mix grappa.seed_themes"
	fi

	# ---- 7. bring up the stack ----------------------------------------
	# cicchetto-build is IN the prod profile, so this `up` starts it — the
	# bundle is built here, not by a separate step, and it needs the version.
	export_cic_version
	say "Starting the stack (grappa + cicchetto build)"
	"${COMPOSE[@]}" --profile prod up -d --remove-orphans

	# ---- 8. wait for health -------------------------------------------
	say "Waiting for /healthz (first boot compiles prod — up to ~10 min)"
	local deadline=$((SECONDS + 600))
	until "${COMPOSE[@]}" exec -T grappa curl -fsS http://localhost:4000/healthz >/dev/null 2>&1; do
		if [ "$SECONDS" -ge "$deadline" ]; then
			warn "stack did not become healthy in time. Inspect with:"
			warn "  ${COMPOSE[*]} --profile prod logs --tail=200 grappa"
			die "health check timed out"
		fi
		printf '.'; sleep 3
	done
	printf '\n'

	# ---- 8b. render the front-door config -----------------------------
	local FRONTEND_CONF="runtime/nginx-frontend.conf"
	local UPSTREAM="$HTTP_BIND"
	case "$UPSTREAM" in
		0.0.0.0:*) UPSTREAM="127.0.0.1:${UPSTREAM##*:}" ;;
		'[::]:'*)  UPSTREAM="127.0.0.1:${UPSTREAM##*:}" ;;
	esac

	sed -e "s|<your-domain>|${PHX_HOST}|g" \
	    -e "s|^  server 127\.0\.0\.1:3000;|  server ${UPSTREAM};|" \
	    -e "s|^  ssl_certificate     .*|  ssl_certificate     ${FRONTEND_SSL_CERT};|" \
	    -e "s|^  ssl_certificate_key .*|  ssl_certificate_key ${FRONTEND_SSL_KEY};|" \
	    infra/nginx-tls-frontend.example.conf > "$FRONTEND_CONF"

	# ---- 9. done ------------------------------------------------------
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
  install silently disappear. Use a trusted cert (mkcert on a LAN, ACME
  in public).
EOF
	fi

	if [ -n "$SEED_USER" ]; then
		if [ "$SEED_ACCOUNT_EXISTED" -eq 1 ]; then
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

  Update the box:      infra/docker/deploy.sh update
  Stop the stack:      infra/docker/deploy.sh stop
EOF
}

# ======================================================================
# verb: stop
# ======================================================================
cmd_stop() {
	local DROP_VOLUMES=0
	case "${1:-}" in
		--volumes|-v) DROP_VOLUMES=1 ;;
		'')           ;;
		*) die "usage: infra/docker/deploy.sh stop [--volumes]" ;;
	esac

	# Deliberately NOT requiring .env: a box you cannot stop because its
	# config went missing is a trap, and the containers exist either way.
	require_compose_file
	require_docker
	assert_box_ownership

	if [ "$BOX_RUNNING" -eq 0 ]; then
		say "No grappa containers are up — collecting whatever is left"
	else
		say "Stopping the stack (prod profile: grappa + cicchetto-build)"
	fi

	# --remove-orphans: drop a stale grappa-nginx from a pre-#485 box
	# (removed from compose.yaml but not stopped by a plain down) so the
	# project network frees.
	local down=("${COMPOSE[@]}" --profile prod down --remove-orphans)
	[ "$DROP_VOLUMES" -eq 1 ] && down+=(--volumes)
	"${down[@]}"

	if [ "$BOX_RUNNING" -eq 0 ]; then
		say "nothing was running 🫥"
	else
		say "box is down 🛑"
	fi

	if [ "$DROP_VOLUMES" -eq 1 ]; then
		warn "named volumes dropped — the next start recompiles from scratch."
	fi

	cat <<EOF

  Start again:  infra/docker/deploy.sh update
  Data:         runtime/ is a bind mount in this checkout — untouched.
EOF
}

# ======================================================================
# verb: update — consumes the shared deploy algorithm for hot-vs-cold
# ======================================================================
cmd_update() {
	# ---- parse verb-local flags -------------------------------------
	local no_pull=0 forced=0
	local libargs=()
	while [ $# -gt 0 ]; do
		case "$1" in
			--no-pull) no_pull=1 ;;
			--force-hot|--force-cold) forced=1; libargs+=("$1") ;;
			*) libargs+=("$1") ;;   # let the lib reject unknowns
		esac
		shift
	done

	# ---- guards (before any side effect) ----------------------------
	require_compose_file
	require_docker
	[ -f .env ] || die "no .env in $REPO_ROOT — this box was never installed. Run 'infra/docker/deploy.sh install' first."
	git rev-parse --git-dir >/dev/null 2>&1 || die "not a git checkout — nothing to update from."
	assert_box_ownership   # sets BOX_RUNNING

	if [ "$no_pull" -eq 0 ]; then
		# A fast-forward onto a dirty tree either fails halfway or silently
		# carries local edits into "the latest revision". Refuse, and say
		# which files.
		if ! git diff --quiet || ! git diff --cached --quiet; then
			warn "uncommitted changes in the checkout:"
			git status --short >&2
			die "refusing to pull onto a dirty tree — commit, stash or use --no-pull."
		fi
	fi

	# #485 — migrate a pre-change .env in place (idempotent; a no-op once
	# NGINX_PUBLISH is gone). This is where the deprecated alias is honoured,
	# unlike `install` which only warns.
	migrate_publish_env

	# ---- resolve the mode the operator did NOT force ----------------
	# Two docker-specific reasons to force cold when the operator left it to
	# auto: a stopped stack cannot be hot-reloaded (this is the
	# start-again-after-stop path — quickstart-stop points here), and
	# --no-pull deploys the working tree, whose empty prev..new range
	# preflight cannot classify. A recreate is never wrong (unlike a hot
	# reload), so force cold in both cases.
	if [ "$forced" -eq 0 ]; then
		if [ "$no_pull" -eq 1 ]; then
			say "no-pull: deploying the working tree cold (empty range; a recreate is never wrong)"
			libargs+=(--force-cold)
		elif [ "$BOX_RUNNING" -eq 0 ]; then
			say "stack is not running — bringing it up cold (a stopped box cannot be hot-reloaded)"
			libargs+=(--force-cold)
		fi
	fi
	export NO_PULL="$no_pull"

	# ---- lib config + feature toggles -------------------------------
	DEPLOY_SELF_REL="infra/docker/deploy.sh"
	DEPLOY_REEXEC_PREFIX="update"                       # replay the verb on re-exec
	DEPLOY_USAGE="update [--no-pull] [--force-hot|--force-cold]"
	DEPLOY_FEATURE_FORCE_FLAGS=1
	DEPLOY_FEATURE_DEFER=0
	DEPLOY_FEATURE_NOTHING_TO_DO=0                      # already-current+up → cheap hot no-op; down → forced cold above
	DEPLOY_FEATURE_REEXEC=1
	DEPLOY_FEATURE_MARKER=1
	DEPLOY_FEATURE_PREV_SHA_CARRY=1
	HOT_HEALTHCHECK_RETRIES="${HOT_HEALTHCHECK_RETRIES:-30}"
	HOT_HEALTHCHECK_SLEEP="${HOT_HEALTHCHECK_SLEEP:-1}"
	COLD_HEALTHCHECK_RETRIES="${COLD_HEALTHCHECK_RETRIES:-120}"
	COLD_HEALTHCHECK_SLEEP="${COLD_HEALTHCHECK_SLEEP:-2}"

	# ---- substrate hooks --------------------------------------------
	substrate_pull() {
		PREV_SHA="$(git rev-parse HEAD)"
		if [ "$NO_PULL" -eq 1 ]; then
			NEW_SHA="$PREV_SHA"
		else
			local branch
			branch="$(git rev-parse --abbrev-ref HEAD)"
			say "Pulling ${branch} (fast-forward only)"
			git pull --ff-only || die "pull is not a fast-forward — the branch diverged. Resolve it by hand."
			NEW_SHA="$(git rev-parse HEAD)"
		fi
	}

	substrate_read_marker()  { cat runtime/last-deployed-sha 2>/dev/null || true; }
	substrate_write_marker() { mkdir -p runtime; printf '%s\n' "$NEW_SHA" > runtime/last-deployed-sha; }
	substrate_commit_exists() { git cat-file -e "$1^{commit}" >/dev/null 2>&1; }
	substrate_changed_files() { git diff --name-only "$1..$2"; }

	substrate_preflight() {
		# Classify via Grappa.Deploy.Preflight (substrate "docker") — the
		# same SoT the operator + native substrates use. 0=HOT, 3=COLD,
		# anything else is a crash the lib aborts on.
		"${COMPOSE[@]}" run --rm --no-deps -e MIX_ENV=dev grappa \
			mix run --no-start -e "Grappa.Deploy.Preflight.cli([\"$1\", \"$2\", \"docker\"])"
	}

	substrate_build() {
		# Hot needs no build — the pulled commit is already in the
		# bind-mounted tree (compose.yaml mounts ./:/app). Cold rebuilds the
		# toolchain image.
		[ "$MODE" = cold ] || return 0
		say "Rebuilding the grappa image"
		"${COMPOSE[@]}" --profile prod build grappa
	}

	substrate_reload() {
		# The lib captures this hook's stdout as the reload response body, so
		# the pre-reload chatter must go to stderr — else it pollutes the
		# JSON the "failed":[] honesty glob inspects.
		say "Reloading modules in the live BEAM" >&2
		"${COMPOSE[@]}" exec -T grappa curl -fsS -X POST http://localhost:4000/admin/reload
	}

	substrate_cic() {
		mkdir -p runtime/cicchetto-dist
		# AFTER substrate_pull, so the bundle carries the version the box is
		# moving TO, not the one it is on (the pull may have bumped VERSION).
		export_cic_version
		say "Rebuilding the cicchetto bundle"
		"${COMPOSE[@]}" --profile prod run --rm cicchetto-build
		touch runtime/cicchetto-dist/.gitkeep
	}

	substrate_migrate() {
		say "Syncing deps + running migrations"
		# shellcheck disable=SC1010  # `mix do` is a mix subcommand, not shell `do`
		"${COMPOSE[@]}" --profile prod run --rm --no-deps grappa \
			mix do local.hex --force, local.rebar --force, deps.get
		"${COMPOSE[@]}" --profile prod run --rm --no-deps grappa mix ecto.migrate
	}

	substrate_restart() {
		"${COMPOSE[@]}" --profile prod up -d --force-recreate --no-deps --remove-orphans grappa
	}

	substrate_healthcheck() {
		"${COMPOSE[@]}" exec -T grappa curl -fsS -o /dev/null http://localhost:4000/healthz
	}

	substrate_done_banner() {
		if [ "$MODE" = hot ]; then
			say "grappa updated — hot (sessions preserved) 🎉"
		else
			say "grappa updated — cold (stack recreated) 🎉"
		fi
		cat <<EOF

  Web UI:   http://$(published_bind)/
  Logs:     ${COMPOSE[*]} --profile prod logs -f grappa
  Stop:     infra/docker/deploy.sh stop
EOF
	}

	# shellcheck source=infra/lib/deploy_common.sh
	. "$REPO_ROOT/infra/lib/deploy_common.sh"
	# Empty-array-safe expansion for bash 3.2 under `set -u`.
	deploy_main ${libargs[@]+"${libargs[@]}"}
}

# ======================================================================
# verb: (bare) idempotent — install if not yet installed, else update
# ======================================================================
cmd_bare() {
	# A checkout-less host or a fresh clone has no .env — that IS what "not
	# installed" means to this stack. Install it; otherwise bring it current
	# and up via update. This is the single command a curl|bash one-liner
	# (unit D) can always run.
	if [ -f .env ]; then
		say "existing .env — updating this box"
		cmd_update "$@"
	else
		say "no .env — installing a fresh box"
		cmd_install "$@"
	fi
}

# ======================================================================
# RELEASE-IMAGE mode (#503 unit D) — checkout-less, docker-only
# ======================================================================
# The published ghcr image (Dockerfile.release) is self-contained: mix
# release, no source, no mix, no CodeReloader. These verbs bring it up and
# keep it current with plain `docker`. Updates are COLD-only (recreate) —
# hot-on-image is #503 unit E. All config + prod secrets live in $ENV_FILE
# (mode 0600); /data is a named docker volume.

usage_release() {
	cat >&2 <<EOF
usage: infra/docker/deploy.sh {install|update|stop} [options]   (release image)
       infra/docker/deploy.sh                 (bare) install if no env file, else update

  install                pull the ghcr image, generate secrets, migrate, run.
                         PHX_HOST is asked interactively, or pass PHX_HOST=… .
  update [--force-cold]  pull a newer image + recreate (COLD — hot-on-image is
                         #503 unit E). States which kind of update it performed.
  stop [--volumes|-v]    stop + remove the container ([+ drop the data volume]).

  env: GRAPPA_IMAGE (default ghcr.io/vjt/grappa:latest), GRAPPA_HOME
       (default \$HOME/.grappa), GRAPPA_PUBLISH (default 127.0.0.1:4000),
       PHX_HOST (skips the prompt).
EOF
	exit 64
}

require_docker_release() {
	command -v docker >/dev/null 2>&1 || die "docker not found — install Docker Engine first."
	docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon — is it running / do you have permission?"
}

release_container_exists() { docker inspect "$GRAPPA_CONTAINER" >/dev/null 2>&1; }

# resolve_phx_host — echo the hostname PHX_HOST is configured to. Priority:
# the PHX_HOST env var (the non-interactive path a piped one-liner uses),
# else an interactive prompt on the CONTROLLING TERMINAL ($GRAPPA_TTY,
# default /dev/tty). A `curl … | bash` one-liner binds stdin to the SCRIPT,
# so a bare `read` would eat the script text (or hit EOF) — the prompt MUST
# come from the tty, not stdin. With neither a value nor a usable tty (CI,
# a non-interactive pipeline) we FAIL LOUD with the exact fix rather than
# silently defaulting to localhost — a wrong PHX_HOST mints dead upload
# links + rejects every WebSocket handshake on Origin (#468).
resolve_phx_host() {
	if [ -n "${PHX_HOST:-}" ]; then
		printf '%s' "$PHX_HOST"
		return 0
	fi
	# The prompt goes to stderr (which still reaches the terminal even when
	# stdin is a pipe, e.g. curl|bash); the ANSWER is read from the tty, NOT
	# stdin — stdin is the piped script itself.
	local tty="${GRAPPA_TTY:-/dev/tty}"
	if [ -r "$tty" ]; then
		local ans=''
		printf 'Public hostname grappa is reached at (PHX_HOST, e.g. grappa.example.org): ' >&2
		IFS= read -r ans < "$tty" || true
		if [ -n "$ans" ]; then
			printf '%s' "$ans"
			return 0
		fi
	fi
	die "PHX_HOST is required and no terminal is available to prompt for it.
    Re-run with it set, e.g.:  PHX_HOST=grappa.example.org GRAPPA_HOME=${GRAPPA_HOME} <this command>"
}

# write_env_file — generate the prod env ONCE, into $ENV_FILE at mode 0600.
# Idempotent BY DESIGN: an existing file is NEVER regenerated — rotating
# SECRET_KEY_BASE / GRAPPA_ENCRYPTION_KEY under a live box invalidates every
# session and makes stored (Cloak-encrypted) credentials undecryptable. So
# install on an existing box reuses it untouched.
#
# The secrets themselves come from infra/packaging/gen-secrets.sh — the ONE
# generator (#862), shared with the .deb/.rpm postinstall and the release
# image's first-boot bootstrap. This function only lays down the non-secret
# lines and hands the file over; it never touches argv (`ps`-visible) or
# stdout, because the generator writes straight into the file.
#
# It used to transcribe four `openssl rand` calls here and spend a throwaway
# --env-file plus a whole `docker run … eval` on the VAPID pair, on the stated
# grounds that "host openssl cannot safely reproduce a raw P-256 point". That
# was false: test/infra/gen_secrets_test.bats re-derives the public point from
# the generator's own scalar and requires a byte-exact match. Two openssl
# transcriptions of the same six secrets is exactly the drift #862 removed.
write_env_file() {
	if [ -f "$ENV_FILE" ]; then
		say "reusing the existing env file at $ENV_FILE (secrets are NOT regenerated)"
		return 0
	fi

	[ -x "$GEN_SECRETS" ] || [ -f "$GEN_SECRETS" ] \
		|| die "secret generator not found at $GEN_SECRETS — re-run get.sh, or run this from a grappa checkout."

	local phx_host
	phx_host="$(resolve_phx_host)"

	# umask BEFORE any create, so the file is never world-readable — not
	# even for the instant between create and an explicit chmod.
	umask 077
	mkdir -p "$GRAPPA_HOME"

	# Build in a temp beside the target and mv into place only once the
	# secrets are in. A half-written $ENV_FILE would be WORSE than none: the
	# next run sees a file, takes the "reusing the existing env file" branch,
	# and starts a container that dies on a missing SECRET_KEY_BASE.
	local tmp="$ENV_FILE.partial"
	{
		printf '# grappa production env — release-image install (#503 unit D).\n'
		printf '# Mode 0600: contains ALL production secrets. Regeneration is refused\n'
		printf '# on an existing box (would invalidate sessions + Cloak-encrypted creds).\n'
		printf '# Back up GRAPPA_ENCRYPTION_KEY separately — losing it loses stored creds.\n'
		printf 'PHX_HOST=%s\n' "$phx_host"
		printf 'GRAPPA_SUBSTRATE=docker\n'
		printf 'DATABASE_PATH=/data/grappa.db\n'
		printf 'UPLOADS_STORAGE_ROOT=/data/uploads\n'
	} > "$tmp"
	chmod 600 "$tmp"

	say "Generating production secrets into $ENV_FILE (mode 0600)"
	GRAPPA_ENV_FILE="$tmp" GRAPPA_ENV_MODE=0600 bash "$GEN_SECRETS" >&2 \
		|| { rm -f "$tmp"; die "secret generation failed — $ENV_FILE was not written."; }

	mv "$tmp" "$ENV_FILE"
}

# release_start_container — `docker run -d` the published image. Assumes the
# container name is free (caller removed any prior one). All env (secrets +
# runtime knobs) rides in via --env-file, so nothing lands on argv.
release_start_container() {
	say "Starting $GRAPPA_CONTAINER from $GRAPPA_IMAGE"
	docker run -d \
		--name "$GRAPPA_CONTAINER" \
		--restart unless-stopped \
		--env-file "$ENV_FILE" \
		-v "${GRAPPA_DATA_VOLUME}:/data" \
		-p "${GRAPPA_PUBLISH}:4000" \
		"$GRAPPA_IMAGE" >&2
}

release_migrate() {
	say "Running database migrations (release image, full prod env)"
	docker run --rm --env-file "$ENV_FILE" -v "${GRAPPA_DATA_VOLUME}:/data" \
		"$GRAPPA_IMAGE" eval 'Grappa.Release.migrate()'
}

release_healthcheck_wait() {
	say "Waiting for /healthz"
	local deadline=$((SECONDS + 300))
	until docker exec "$GRAPPA_CONTAINER" curl -fsS -o /dev/null http://localhost:4000/healthz 2>/dev/null; do
		if [ "$SECONDS" -ge "$deadline" ]; then
			warn "the container did not become healthy in time. Inspect with:"
			warn "  docker logs $GRAPPA_CONTAINER"
			die "health check timed out"
		fi
		printf '.'; sleep 2
	done
	printf '\n'
}

cmd_install_release() {
	[ $# -eq 0 ] || usage_release
	require_docker_release

	# One box per host on this container name (parallels the source-mode
	# ownership guard). An existing container means an existing install.
	if release_container_exists; then
		die "a container named '$GRAPPA_CONTAINER' already exists — this box looks installed. Run 'update', or 'stop' first."
	fi

	write_env_file

	say "Ensuring the data volume ($GRAPPA_DATA_VOLUME) exists"
	docker volume create "$GRAPPA_DATA_VOLUME" >&2 || true

	release_migrate
	release_start_container
	release_healthcheck_wait

	say "grappa is up from $GRAPPA_IMAGE 🎉"
	cat <<EOF

  Web UI:  http://${GRAPPA_PUBLISH}/   (front it with your own TLS front door)
  Env:     ${ENV_FILE}   (0600 — every prod secret is here; back it up)
  Data:    docker volume '${GRAPPA_DATA_VOLUME}' (sqlite + uploads)
  Update:  infra/docker/deploy.sh update
  Stop:    infra/docker/deploy.sh stop
EOF
}

cmd_update_release() {
	# Release-image update is COLD-only (hot-on-image is #503 unit E): the
	# image ships no CodeReloader, so a recreate is the only safe verdict.
	# --force-cold is accepted (redundant) for symmetry with the source path.
	case "${1:-}" in
		''|--force-cold) ;;
		*) usage_release ;;
	esac

	require_docker_release
	[ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE — this box was never installed. Run 'install' first."

	# ---- lib config + feature toggles (all git-centric features OFF) --
	DEPLOY_SELF_REL="infra/docker/deploy.sh"
	DEPLOY_USAGE="update [--force-cold]"
	DEPLOY_FEATURE_FORCE_FLAGS=1
	DEPLOY_FEATURE_DEFER=0
	DEPLOY_FEATURE_NOTHING_TO_DO=0
	DEPLOY_FEATURE_REEXEC=0
	DEPLOY_FEATURE_MARKER=0
	DEPLOY_FEATURE_PREV_SHA_CARRY=0
	COLD_HEALTHCHECK_RETRIES="${COLD_HEALTHCHECK_RETRIES:-120}"
	COLD_HEALTHCHECK_SLEEP="${COLD_HEALTHCHECK_SLEEP:-2}"

	# ---- substrate hooks (release-image flavor) ----------------------
	substrate_pull() {
		say "Pulling $GRAPPA_IMAGE" >&2
		docker pull "$GRAPPA_IMAGE" >&2 || die "docker pull $GRAPPA_IMAGE failed — check the tag + your ghcr access."
		# marker/preflight are OFF (no git range to classify); PREV/NEW are
		# set only because the lib reads them. The image ref keeps any log honest.
		PREV_SHA="$GRAPPA_IMAGE"
		NEW_SHA="$GRAPPA_IMAGE"
	}
	substrate_read_marker()   { :; }
	substrate_write_marker()  { :; }
	substrate_commit_exists() { return 0; }
	substrate_changed_files() { :; }
	substrate_preflight()     { return 3; }   # never reached (force-cold); COLD if it were
	substrate_build()         { :; }          # image already pulled
	substrate_reload()        { :; }          # never reached (COLD-only)
	substrate_cic()           { :; }          # the cicchetto SPA is baked into the image
	substrate_migrate()       { release_migrate; }
	substrate_restart() {
		if release_container_exists; then
			say "Removing the running container ($GRAPPA_CONTAINER)"
			docker rm -f "$GRAPPA_CONTAINER" >&2 || true
		fi
		release_start_container
	}
	substrate_healthcheck() {
		docker exec "$GRAPPA_CONTAINER" curl -fsS -o /dev/null http://localhost:4000/healthz
	}
	substrate_done_banner() {
		say "grappa updated — cold (image pulled + container recreated) 🎉"
		cat <<EOF

  Image:  $GRAPPA_IMAGE
  Logs:   docker logs -f $GRAPPA_CONTAINER
  Stop:   infra/docker/deploy.sh stop
EOF
	}

	say "release image: updating cold (hot-on-image is #503 unit E)"
	# shellcheck source=infra/lib/deploy_common.sh
	. "$SELF_DIR/../lib/deploy_common.sh"
	deploy_main --force-cold
}

cmd_stop_release() {
	local drop_volume=0
	case "${1:-}" in
		--volumes|-v) drop_volume=1 ;;
		'') ;;
		*) die "usage: infra/docker/deploy.sh stop [--volumes]" ;;
	esac

	require_docker_release
	if release_container_exists; then
		say "Stopping + removing $GRAPPA_CONTAINER"
		docker rm -f "$GRAPPA_CONTAINER" >&2 || true
		say "box is down 🛑"
	else
		say "no '$GRAPPA_CONTAINER' container is up — nothing to stop 🫥"
	fi

	if [ "$drop_volume" -eq 1 ]; then
		docker volume rm "$GRAPPA_DATA_VOLUME" >&2 || true
		warn "data volume '$GRAPPA_DATA_VOLUME' dropped — the database and uploads are gone."
	fi

	cat <<EOF

  Start again:  infra/docker/deploy.sh update
  Env:          ${ENV_FILE} (kept — holds your secrets)
EOF
}

cmd_bare_release() {
	# A checkout-less host with no env file has never been installed; one
	# with an env file is an existing box. The single command a curl|bash
	# one-liner always runs.
	if [ -f "$ENV_FILE" ]; then
		say "existing env file — updating this box"
		cmd_update_release "$@"
	else
		say "no env file — installing a fresh box"
		cmd_install_release "$@"
	fi
}

# ======================================================================
# dispatch (mode-aware)
# ======================================================================
verb="${1:-}"
if [ $# -gt 0 ]; then shift; fi
if [ "$DEPLOY_MODE" = release ]; then
	case "$verb" in
		install) cmd_install_release "$@" ;;
		update)  cmd_update_release "$@" ;;
		stop)    cmd_stop_release "$@" ;;
		'')      cmd_bare_release "$@" ;;
		*)       usage_release ;;
	esac
else
	case "$verb" in
		install) cmd_install "$@" ;;
		update)  cmd_update "$@" ;;
		stop)    cmd_stop "$@" ;;
		'')      cmd_bare "$@" ;;
		*)       usage ;;
	esac
fi
