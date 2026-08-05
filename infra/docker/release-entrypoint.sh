#!/bin/sh
# release-entrypoint.sh — container entrypoint for the self-contained grappa
# RELEASE image (Dockerfile.release, #503 unit C).
#
# It mirrors bin/start.sh's BEAM resource caps — the DOCKER-specific fix —
# bootstraps the prod secrets on first boot (#862, see the block near the
# bottom), then execs the release. bin/start.sh cannot be reused verbatim: it self-heals hex
# + deps and `exec mix phx.server`, neither of which exists in a self-contained
# release (no mix, no source). This is the release twin of that same rationale.
#
# Why the caps: Docker on Linux 6.x inherits NOFILE = 2^30, so WITHOUT a `+Q`
# cap BEAM sizes its port table at min(ulimit -n, 2^27-1) = ~134M ports →
# ~1.5 GB ll_alloc carrier reserved at boot; `+SDio` defaults to a fixed 10
# dirty-IO scheduler threads regardless of CPU count. Same knobs, same ratios
# as bin/start.sh (see its header for the per-user derivation):
#   GRAPPA_MAX_USERS         (default 100) sizes +Q (ports) and +P (procs)
#   GRAPPA_DIRTY_SCHEDULERS  (default max(nproc, 10)) sizes +SDcpu and +SDio
#
# The flags travel via ERL_ZFLAGS — honored by erlexec for a `mix release`
# start — rather than a baked `rel/vm.args`: vm.args would ship inside the
# release and change the jail/.deb/.rpm consumers too, but these caps are THIS
# image's concern. ERL_ZFLAGS is APPENDED to (never clobbers) any operator
# value.

set -e

: "${GRAPPA_MAX_USERS:=100}"
default_schedulers="$(nproc)"
if [ "$default_schedulers" -lt 10 ]; then
    default_schedulers=10
fi
: "${GRAPPA_DIRTY_SCHEDULERS:=$default_schedulers}"

GRAPPA_MAX_PORTS=$((GRAPPA_MAX_USERS * 400))
GRAPPA_MAX_PROCS=$((GRAPPA_MAX_USERS * 100))

ERL_ZFLAGS="${ERL_ZFLAGS:+$ERL_ZFLAGS }+Q ${GRAPPA_MAX_PORTS} +P ${GRAPPA_MAX_PROCS} +SDcpu ${GRAPPA_DIRTY_SCHEDULERS} +SDio ${GRAPPA_DIRTY_SCHEDULERS}"
export ERL_ZFLAGS

# The sqlite DB parent + the uploads dir must exist and be writable before boot
# (exqlite opens but does NOT create the parent dir). On a fresh anonymous
# /data volume Docker inherits the image's grappa ownership, so this succeeds;
# a root-owned bind mount is the operator's to chown (unit D docs). Failing
# loud here beats a cryptic "unable to open database file" at first write.
data_dir="$(dirname "${DATABASE_PATH:-/data/grappa.db}")"
mkdir -p "$data_dir" "${UPLOADS_STORAGE_ROOT:-/data/uploads}"

# ── First-boot secret bootstrap (#862) ──────────────────────────────────────
#
# The image ships no secrets on purpose, and before #862 nothing on the bare
# `docker run <image> start` path ever generated any: the operator got a
# config-provider stacktrace pointing at `scripts/mix.sh`, a script this image
# does not contain. Now the entrypoint fills whatever runtime.exs would raise
# on, using the SAME generator the .deb/.rpm hosts run
# (infra/packaging/gen-secrets.sh, openssl-only, no BEAM, idempotent).
#
# Three rules, in the order they can hurt:
#
#   1. OPERATOR ENV WINS. Only vars absent (or empty) in the container env are
#      taken from the file, so `-e SECRET_KEY_BASE=…` and `--env-file` behave
#      exactly as before. When the environment already carries all of them —
#      deploy.sh's --env-file install — nothing is generated and /data is not
#      touched at all.
#   2. NEVER ROTATE. The file lives on the /data VOLUME (beside the DB, so it
#      follows a relocated DATABASE_PATH) and gen-secrets.sh only fills blanks.
#      Re-rolling SECRET_KEY_BASE would log every user out; re-rolling
#      GRAPPA_ENCRYPTION_KEY would make every Cloak-encrypted upstream
#      credential undecryptable — data loss, not an inconvenience. A restart
#      MUST reuse the file byte-for-byte.
#   3. PHX_HOST IS NOT INVENTABLE. It stays the operator's, so a bare run
#      still fails — for that one variable, with the message config/runtime.exs
#      now words for every install flavour.
#
# Values are line-parsed and exported individually, never `.`-sourced: sourcing
# would execute the file's contents and would also clobber operator env.
secrets_file="${data_dir}/grappa.env"
missing=''
for key in SECRET_KEY_BASE SECRET_SIGNING_SALT RELEASE_COOKIE \
           GRAPPA_ENCRYPTION_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
    eval "current=\${${key}:-}"
    [ -n "$current" ] || missing="${missing}${key} "
done

if [ -n "$missing" ]; then
    # umask BEFORE the create: the file must never be world-readable, not even
    # for the instant between create and chmod.
    umask 077
    if [ ! -f "$secrets_file" ]; then
        : > "$secrets_file" || {
            echo "grappa: cannot create $secrets_file — is /data writable by this container?" >&2
            exit 1
        }
    fi

    # gen-secrets.sh ships beside this script in /app. bash (not the busybox
    # ash running this file) because the generator relies on `set -o pipefail`
    # to catch a failed openssl mid-pipeline.
    GRAPPA_ENV_FILE="$secrets_file" GRAPPA_ENV_MODE=0600 \
        bash "$(dirname "$0")/gen-secrets.sh" >&2

    for key in $missing; do
        value="$(sed -n "s/^${key}=//p" "$secrets_file" | tail -1)"
        [ -n "$value" ] || {
            echo "grappa: $secrets_file has no value for $key after bootstrap" >&2
            exit 1
        }
        export "$key=$value"
    done

    echo "grappa: bootstrapped ${missing}from $secrets_file — back that file up," \
         "GRAPPA_ENCRYPTION_KEY decrypts every stored upstream credential" >&2
fi

exec bin/grappa "$@"
