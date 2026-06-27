# Installing grappa with Docker

A self-hosted, full-stack install on a single host: the IRC bouncer, the
`cicchetto` PWA, and an nginx front door — all in Docker, reachable at
`http://localhost:3000`.

This is the plain, no-frills path. It does not touch the operator deploy
machinery (`scripts/deploy.sh`, `deploy-m42.sh`, per-host compose
overrides) — those target a specific production host and are not needed
to run grappa yourself.

## Prerequisites

- **Docker Engine** with the **Compose v2** plugin (`docker compose
  version` works).
- **git**, and a clone of this repository.
- ~2 GB free disk and RAM for the build.
- A free TCP port **3000** on localhost (change it with `HTTP_BIND`, see
  below).

No Elixir, Node, or Bun on the host — the container is the only runtime.

## Quick start

```sh
git clone https://github.com/vjt/grappa-irc
cd grappa-irc
scripts/quickstart.sh
```

That one command does everything and exits only once the stack answers
`/healthz`. First run takes a while (it downloads the base image and
compiles); later runs are fast. When it finishes:

```
Web UI:  http://127.0.0.1:3000/
```

To serve on a different address/port, set `HTTP_BIND` before running:

```sh
HTTP_BIND=0.0.0.0:8080 scripts/quickstart.sh   # all interfaces, port 8080
```

### What the script does

1. Checks Docker is installed and running.
2. Creates host-owned `runtime/` directories (sqlite DB, uploads, build
   output).
3. Writes a `.env`: sets `MIX_ENV=prod`, your host UID/GID,
   `PHX_HOST=localhost`, and the host port.
4. Builds the image and fetches Elixir deps into the checkout.
5. **Generates every secret** and writes them to `.env` —
   `SECRET_KEY_BASE`, `SECRET_SIGNING_SALT`, `GRAPPA_ENCRYPTION_KEY`, a
   VAPID keypair (Web Push), and `RELEASE_COOKIE`. Already-set values are
   never overwritten, so re-running is safe.
6. Runs database migrations.
7. Brings up the full stack (`docker compose --profile prod up -d`).
8. Polls `/healthz` until the stack is green.

> **Back up `GRAPPA_ENCRYPTION_KEY`** (in `.env`) somewhere safe. It
> encrypts your stored IRC/NickServ passwords at rest — lose it and those
> credentials are unrecoverable.

## Validate it's up

```sh
curl http://127.0.0.1:3000/healthz      # -> 200 OK
docker compose -f compose.yaml --profile prod ps
```

Open `http://127.0.0.1:3000/` in a browser — you should get the cicchetto
login screen.

## Create your first user

A fresh install has no accounts and connects to no networks until you say
so.

```sh
docker compose -f compose.yaml run --rm grappa \
  mix grappa.create_user --name you --password 'change-me'
```

Then log in via the web UI. To connect the bouncer to an IRC network, see
**"Bind a network"** in [README.md](README.md).

## Managing the stack

All commands run from the repo root. The `-f compose.yaml` flag keeps it
to the committed config (no local overrides).

```sh
# Tail logs
docker compose -f compose.yaml --profile prod logs -f grappa

# Stop / start
docker compose -f compose.yaml --profile prod down
scripts/quickstart.sh                       # idempotent: brings it back up

# Update to a newer checkout
git pull
docker compose -f compose.yaml --profile prod up -d --build
```

## Manual install (without the script)

The script just automates these steps. To do it by hand:

```sh
cp .env.example .env
# Edit .env: set MIX_ENV=prod, CONTAINER_UID/GID to your host id -u/-g,
# PHX_HOST=localhost, and fill the secret block. Generate values with:
docker compose -f compose.yaml run --rm -e MIX_ENV=dev grappa mix phx.gen.secret        # SECRET_KEY_BASE
docker compose -f compose.yaml run --rm -e MIX_ENV=dev grappa mix phx.gen.secret 64     # SECRET_SIGNING_SALT
docker compose -f compose.yaml run --rm -e MIX_ENV=dev grappa mix grappa.gen_encryption_key
docker compose -f compose.yaml run --rm -e MIX_ENV=dev grappa mix grappa.gen_vapid       # VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY
openssl rand -hex 32                                                                      # RELEASE_COOKIE

mkdir -p runtime/cicchetto-dist runtime/bun-cache runtime/uploads
docker compose -f compose.yaml build grappa
docker compose -f compose.yaml run --rm grappa mix ecto.migrate
docker compose -f compose.yaml --profile prod up -d
```

Secrets are generated with `-e MIX_ENV=dev` on purpose: a prod-env task
would read `config/runtime.exs`, which refuses to start until those very
secrets exist.

## Troubleshooting

- **First boot is slow / health check waits minutes.** Expected: the
  container compiles the app on first prod boot. Watch progress with
  `docker compose -f compose.yaml --profile prod logs -f grappa`.
- **Port 3000 already in use.** Re-run with a free port:
  `HTTP_BIND=127.0.0.1:3100 scripts/quickstart.sh`.
- **`cannot talk to the Docker daemon`.** Start Docker, or add yourself to
  the `docker` group (then re-login).
- **Health check timed out.** Inspect the last logs:
  `docker compose -f compose.yaml --profile prod logs --tail=200 grappa`.

## How it's wired

One `grappa` container runs the Elixir/OTP bouncer (`mix phx.server`)
against a sqlite database under `runtime/`. The `prod` profile adds an
`nginx` front door that serves the cicchetto PWA (built once by a
throwaway `cicchetto-build` container) and reverse-proxies the API +
WebSocket to grappa. State that must survive a rebuild — the database,
uploads — lives in `runtime/` on the host. See
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the operator runbook and
[CLAUDE.md](CLAUDE.md) for the architecture.
