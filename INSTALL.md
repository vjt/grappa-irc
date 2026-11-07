# Installing grappa with Docker

A self-hosted install on a single host: one Docker container running the
IRC bouncer, which also serves the `cicchetto` PWA and owns its own
security headers — reachable at `http://localhost:3000`. (A one-shot
build container compiles the PWA bundle and then exits; the long-lived
container is just grappa.)

This is the plain, no-frills path. It does not touch the operator deploy
machinery (`scripts/deploy.sh`, `deploy-m42.sh`, per-host compose
overrides) — those target a specific production host and are not needed
to run grappa yourself.

> **Upgrading an existing two-container box?** Older installs ran a
> separate nginx front door alongside grappa. #485 removed it — the BEAM
> now serves the SPA and emits the CSP itself. Jump to
> [Upgrading from the two-container topology](#upgrading-from-the-two-container-topology).

## One-click on AWS (CloudFormation)

Want grappa on its own cloud box over HTTPS, installing **nothing** locally?
If you already have an AWS account, the CloudFormation template
[`infra/aws/grappa-cloudformation.yaml`](infra/aws/grappa-cloudformation.yaml)
stands up a single stock-Ubuntu EC2 instance that installs the latest release
`.deb`, self-terminates TLS, and keeps a stable Elastic IP.

**What you provide** (the five shared knobs + an SSH key pair):

| Knob | Meaning |
|------|---------|
| **Domain** | public hostname (e.g. `irc.example.org`) |
| **AdminEmail** | Let's Encrypt registration + web-push contact |
| **InstanceType** | EC2 size — **amd64 only** (the `.deb` is amd64-only; no Graviton) |
| **SshCidr** | CIDR allowed to SSH — required, lock it to your address (`x.x.x.x/32`) |
| **DiskSizeGb** | root/data volume size |
| **KeyName** | an existing EC2 key pair (AWS-specific, on top of the five) |

**Version pin = latest.** There is no apt repo — first boot fetches the
*latest* GitHub release asset (`grappa_<ver>_amd64.deb`). "Pinned version"
therefore means *latest at launch time*.

### Order matters — point DNS, then issue TLS

1. **Launch the stack** (see the launch URL below). It resolves the Ubuntu
   24.04 AMI via Canonical's SSM public parameter (so it works in every region
   with no hardcoded AMI), creates a security group (443 + 80-for-ACME open, SSH
   restricted to your CIDR), the instance, and an **Elastic IP**.
2. **Read the Outputs.** `PublicIp` is the Elastic IP; `DnsRecord` is the exact
   A record to create. **Point your domain's A record at that IP.**
3. **Issue the cert.** TLS is *deferred* at first boot on purpose: the Elastic
   IP is unknown until the stack finishes, so DNS cannot resolve yet, and
   issuing blind would burn Let's Encrypt's failed-validation quota. Once DNS
   resolves, SSH in and run:

   ```sh
   sudo grappa-tls
   ```

   (A boot oneshot also retries this best-effort, so a **reboot after you point
   DNS** self-issues the cert without the manual step.)
4. Open `https://<your-domain>/` and create your first user.

### The launch URL

The console "quick-create" URL wants a **`templateURL=` on S3** — it does *not*
accept a raw `raw.githubusercontent.com` URL. Host the YAML in a public S3
bucket and build:

```
https://<region>.console.aws.amazon.com/cloudformation/home?region=<region>#/stacks/create/review?templateURL=https://<bucket>.s3.<region>.amazonaws.com/grappa-cloudformation.yaml&stackName=grappa
```

Or, with no bucket, upload the file directly in the CloudFormation console
(**Create stack → Upload a template file**).

### Deleting

Deleting the stack removes everything it created (instance, security group,
Elastic IP). Nothing is retained.

> The on-box bootstrap lives in [`infra/cloud/first-boot.sh`](infra/cloud/first-boot.sh),
> shared verbatim with the future Terraform module (the CFN `UserData` curls it
> at a git ref and execs it — it is never inlined). Operator runbook for the AWS
> box: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Kubernetes (`kubectl apply -k`)

> **Support status: community-maintained, and NOT tested in CI.** Nothing in
> this repository exercises Kubernetes — no kind cluster, no `apply -k` smoke
> job, no `/healthz` wait. These manifests are reviewed by reading, not by
> running, and they can rot without anything going red. Every other path on
> this page is exercised somewhere; this one is not.

Kustomize manifests for the pre-built release image live in the repository
root:

```
kustomization.yaml     # the plain install path — imports base/
base/
  kustomization.yaml
  deployment.yaml      # 1 replica, Recreate, /healthz probes
  service.yaml         # ClusterIP :4000, plain HTTP
  pvc.yaml             # RWO, mounted at /data
  secret.yaml          # OPTIONAL, shipped commented out
  networkpolicy.yaml   # read its header before applying it
overlays/default/
  kustomization.yaml   # PHX_HOST patch + Ingress example + IRC egress rule
```

**Install:** set `PHX_HOST` — the public hostname clients reach — then apply.

```sh
# Edit the PHX_HOST value in base/deployment.yaml, then:
kubectl apply -k .
```

Or, without editing `base/`, use the overlay (it patches `PHX_HOST` from its
own `kustomization.yaml` and carries the Ingress example):

```sh
# Edit overlays/default/kustomization.yaml, then:
kubectl apply -k overlays/default
```

`PHX_HOST` is the **only** value you must supply. Everything else the image
either bakes (`DATABASE_PATH`, `UPLOADS_STORAGE_ROOT`, `CIC_DIST_ROOT`, `PORT`)
or generates on first boot onto the `/data` volume — `SECRET_KEY_BASE`,
`SECRET_SIGNING_SALT`, `RELEASE_COOKIE`, `GRAPPA_ENCRYPTION_KEY` and the VAPID
pair — before creating the database directory and the uploads root and running
pending migrations. Left empty, the container **refuses to boot**, on purpose.
Supplying your own key material instead is optional; see the commented
`base/secret.yaml`.

There is **one** Deployment and **one** Service because the cicchetto PWA is
served by the same BEAM that runs the bouncer. TLS terminates in front of the
pod, exactly as on every other path.

**Read `base/networkpolicy.yaml`'s header before applying on a cluster that is
not already default-deny.** A NetworkPolicy that selects a pod makes everything
it does not list *denied*, and an incomplete egress list does not look like a
firewall problem: grappa reports itself up, `/healthz` stays green, and every
network sits in `connecting` forever. If your IRC server is private —
in-cluster, on the LAN, behind a VPN — the base policy denies it and you must
add the rule the overlay carries.

**Updates on this path are always COLD**, for the same reason as the Docker
image path: the release image ships no `CodeReloader`, so there is nothing to
hot-swap. Moving the image tag is not enough on its own — the pod has to be
recreated:

```sh
kubectl set image deployment/grappa grappa=ghcr.io/vjt/grappa:vX.Y.Z
# or, when the tag itself moved (e.g. :latest):
kubectl rollout restart deployment/grappa
```

The Deployment uses `strategy: Recreate`, not a rolling update, because SQLite
is a single-writer store and a rolling update would briefly run two pods on one
volume. So the old pod is fully gone before its replacement starts: **IRC
sessions drop for the seconds of the recreate.** The database and uploads on
the volume are untouched.

> **Back up the `/data` volume whole.** It holds the database, the uploads
> *and* `/data/grappa.env`, which holds `GRAPPA_ENCRYPTION_KEY` — the key that
> decrypts every stored upstream credential. Restoring the database without it
> restores nothing usable.

## Prerequisites

- **Docker Engine** with the **Compose v2** plugin (`docker compose
  version` works).
- **git**, and a clone of this repository — for the **from-source** path
  below. The [pre-built image path](#prefer-a-pre-built-image-over-compiling)
  needs neither: just Docker + `curl`.
- ~2 GB free disk and RAM for the build.
- A free TCP port **3000** on localhost (change it with `HTTP_BIND`, see
  below).

No Elixir, Node, or Bun on the host — the container is the only runtime.

## Quick start

```sh
git clone https://github.com/vjt/grappa-irc
cd grappa-irc
infra/docker/deploy.sh install
```

> The old `scripts/quickstart.sh` / `-update.sh` / `-stop.sh` still work —
> they are thin shims that forward to `infra/docker/deploy.sh
> install`/`update`/`stop` for one release. New commands are shown below.

That one command does everything and exits only once the stack answers
`/healthz`. First run takes a while (it downloads the base image and
compiles); later runs are fast. When it finishes:

```
Web UI:  http://127.0.0.1:3000/
```

To serve on a different address/port, set `HTTP_BIND` before running:

```sh
HTTP_BIND=0.0.0.0:8080 infra/docker/deploy.sh install   # all interfaces, port 8080
```

### Prefer a pre-built image over compiling?

The clone-and-build above is the **from-source** path (the dev/CI toolchain
image compiles the tree). If you would rather **pull** than build, every
`vX.Y.Z` release publishes a self-contained, multi-arch image
(`linux/amd64` + `linux/arm64`) to:

```
ghcr.io/vjt/grappa:<tag>     # e.g. :v0.8.0, or :latest
```

It bundles the Erlang release + the cicchetto SPA and boots on its own — no
source, no build toolchain, no `git`, no compile. It is a **release** image, so
it has **no `Phoenix.CodeReloader`**: it is a runtime, not the hot-edit dev
environment. The Docker Compose stack (this document's clone-and-build path)
remains the development runtime.

**One-line install** — on a host with only Docker + `curl` (no clone):

```sh
curl -fsSL https://raw.githubusercontent.com/vjt/grappa-irc/main/infra/docker/get.sh | bash
```

`get.sh` downloads two shell files into `$GRAPPA_HOME` (default `~/.grappa`)
and hands off to `infra/docker/deploy.sh` in release mode. That `install`:

- pulls `ghcr.io/vjt/grappa:latest` (override with `GRAPPA_IMAGE=…`);
- **asks for `PHX_HOST`** — the public hostname upload links + origin checks
  come from. A piped one-liner reads the answer from your terminal, not the
  pipe; set `PHX_HOST=…` before the `curl` to skip the prompt. There is **no
  silent `localhost` fallback** — a wrong `PHX_HOST` mints dead links (#468);
- generates every production secret into `$GRAPPA_HOME/grappa.env` (mode
  `0600` — **back it up**, it holds `GRAPPA_ENCRYPTION_KEY`), never regenerating
  it on an existing box;
- migrates, then `docker run -d` the container (name `grappa`, published on
  `127.0.0.1:4000` — override with `GRAPPA_PUBLISH=…`), with the sqlite DB and
  uploads on a named volume (`grappa-data`).

Front it with your own TLS front door exactly as the from-source path does
(the container serves plain HTTP + owns its own CSP; #485).

**Won't pipe a script into a shell?** `compose.release.yaml` in this repo is
the same thing as a compose file — copy it, set `PHX_HOST`, bring it up:

```sh
docker compose -f compose.release.yaml up -d
```

It is deliberately short (image, a `/data` volume, a published port,
`PHX_HOST`) because the entrypoint generates its own secrets, creates its
directories and migrates on first boot. It is **not** `compose.yaml`, which is
the from-source development stack above and builds from the checkout.

It is also a **different box** from the one-liner above, not another way to
drive it — nothing is shared, the update command least of all. Compose brings
it up as project `grappa-release`: container `grappa-release-grappa-1`, data on
volume `grappa-release_grappa-data`, secrets generated inside `/data`. The
script path runs a container named `grappa` on volume `grappa-data`, with its
secrets in `$GRAPPA_HOME/grappa.env`.

#### Updating an image box is always COLD

The release image ships no `CodeReloader`, so there is nothing to hot-swap: an
update **pulls a newer image and recreates the container** (sessions drop for
the few seconds of the recreate; the DB + uploads on the volume are untouched).
`deploy.sh`'s banner always reads *cold* on this path — hot-on-image is a
future increment (#503 unit E).

**Update the way you installed.** The two paths above are two boxes, and each
has its own command.

Installed with the one-liner (container `grappa`):

```sh
# from anywhere, via the same bootstrap:
curl -fsSL https://raw.githubusercontent.com/vjt/grappa-irc/main/infra/docker/get.sh | bash -s -- update
# or, on a box already bootstrapped (deploy.sh lives under $GRAPPA_HOME):
~/.grappa/infra/docker/deploy.sh update
```

Installed with `compose.release.yaml` (project `grappa-release`):

```sh
docker compose -f compose.release.yaml pull
docker compose -f compose.release.yaml up -d
```

The `pull` is the update; `up -d` only applies it. Without the `pull`, compose
finds the tag already on the host, sees nothing to change, and leaves the
container it is already running exactly where it is.

**Crossing them is the trap, and it does not announce itself.** `deploy.sh`
finds its box through `$GRAPPA_HOME/grappa.env`, which a compose install never
writes — so `update` aborts with *"this box was never installed. Run 'install'
first"*. That message is wrong, and taking its advice is the damaging step:
`install` guards only against a container named `grappa`, never sees
`grappa-release-grappa-1`, and builds a second box on the **other** volume —
fresh secrets, empty database. It stops at the port bind while the compose box
is up (both publish `127.0.0.1:4000` by default), and it *completes* when that
port is free: a compose box that happens to be down, or either side published
somewhere else. What you then reach is an empty grappa asking you to create the
first user. **The data is not gone**: it is on `grappa-release_grappa-data`,
untouched. Take the stray box down with `~/.grappa/infra/docker/deploy.sh stop`
(that keeps its volume) and bring your own back with the two commands above.

`stop` removes the container but keeps the volume; `stop --volumes` also drops
the data volume (destroys the DB). See `docs/OPERATIONS.md` for the full
image runbook and how the image is built and published.

### What the script does

1. Checks Docker is installed and running.
2. Creates host-owned `runtime/` directories (sqlite DB, uploads, build
   output).
3. Writes a `.env`: sets `MIX_ENV=prod`, your host UID/GID,
   `PHX_HOST` (`localhost` unless you pass one), and the host port.
4. Builds the image and fetches Elixir deps into the checkout.
5. **Generates every secret** and writes them to `.env` —
   `SECRET_KEY_BASE`, `SECRET_SIGNING_SALT`, `GRAPPA_ENCRYPTION_KEY`, a
   VAPID keypair (Web Push), and `RELEASE_COOKIE`. Already-set values are
   never overwritten, so re-running is safe.
6. Runs database migrations.
7. Brings up the stack (`docker compose --profile prod up -d`): the
   one-shot `cicchetto-build` compiles the PWA bundle, then the single
   long-lived grappa container comes up and self-serves it.
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
so. Which command you run depends on which of the two paths above you took —
the from-source stack has Mix in it, the pre-built image does not.

**From-source stack** (the clone-and-build path):

```sh
docker compose -f compose.yaml run --rm grappa \
  mix grappa.create_user --name you --password 'change-me'
```

**Pre-built image** (`get.sh` or `compose.release.yaml`). A release ships no
Mix, so there is no `grappa.create_user` task to run; the image carries its own
three-verb operator CLI as `bin/grappa` instead. The account name is
**positional** — a flag in that slot is rejected, not taken as the name:

```sh
docker exec -it grappa bin/grappa create-user you --admin
```

`grappa` there is the container name (`GRAPPA_CONTAINER` overrides it).
Omitting `--password` makes it prompt on the terminal, so the secret stays out
of shell history — that is what the `-it` is for. On a `.deb` / AUR box the
same program is just `sudo grappa create-user you --admin`. `bin/grappa help`
lists the three verbs and their arguments.

Then log in via the web UI. To connect the bouncer to an IRC network, see
**"Bind a network"** in [README.md](README.md) — it gives both forms, since
the verbs differ too (`bind-network` from a checkout, `add-network` on a
packaged release).

## A throwaway box for testing (staging)

To look at a change under a real hostname before it ships, hand the script
the hostname and an account to seed. It comes up already connected, so the
first login lands on a live session instead of an empty box:

```sh
PHX_HOST=grappa.example.org \
SEED_USER=you SEED_AUTOJOIN='#grappa' \
  infra/docker/deploy.sh install
```

`SEED_USER` is the switch — without it nothing is seeded. The rest is
optional: `SEED_PASSWORD` (generated and printed when unset),
`SEED_NETWORK` (default `azzurra`), `SEED_SERVER`
(default `irc.azzurra.chat:6697`), `SEED_NICK` (default `$SEED_USER`),
`SEED_AUTH` (`auto|sasl|server_pass|nickserv_identify|none`, default
`none`), `SEED_NICK_PASSWORD` and `SEED_AUTOJOIN`. Re-running never
clobbers a live box: an existing account or binding is reported and left
alone.

`PHX_HOST` is load-bearing — it is where upload links and origin checks
come from. If you serve the box as `grappa.example.org` while `.env` still
says something else, links point at the wrong host and nothing errors out.
Pass it explicitly and it replaces whatever a previous run wrote.

The stack still listens on plain HTTP on `HTTP_BIND`; that is the listener
your own TLS front door proxies to. The script installs nothing on the
host — it renders `runtime/nginx-frontend.conf` from the shipped example
with your hostname, upstream and certificate paths filled in
(`FRONTEND_SSL_CERT` / `FRONTEND_SSL_KEY` override the defaults under
`/etc/ssl/grappa/`), and prints the path. Include it from your nginx.

> Serving a staging box over plain HTTP under a real name looks like it
> works and does not: off `localhost`, browsers refuse to register the
> service worker without TLS — and refuse it behind an untrusted
> certificate too. Push, offline and install then silently vanish, which
> is usually the part you meant to test. Use mkcert on a LAN, ACME in
> public.

## Managing the stack

All commands run from the repo root. The `-f compose.yaml` flag keeps it
to the committed config (no local overrides).

```sh
# Tail logs
docker compose -f compose.yaml --profile prod logs -f grappa

# Stop / start
infra/docker/deploy.sh stop                 # takes the prod profile down too
infra/docker/deploy.sh update               # brings it back up (idempotent)
```

Use the verb rather than a bare `docker compose down`: the
`cicchetto-build` one-shot lives behind the `prod` profile, so a down
without `--profile prod` can walk past profile-gated services and leave
the box half-stopped. `stop` also passes `--remove-orphans`, which
sweeps a stale `grappa-nginx` container left behind by a pre-#485
two-container box (removing the nginx service from `compose.yaml` does
not stop the container it once created). `stop` refuses to stop a box that
belongs to a different checkout, and takes `--volumes` when you want the
build caches gone as well. `runtime/` is a bind mount in the checkout, so
no flag can touch the database.

### Updating an installed box

```sh
infra/docker/deploy.sh update               # pull, then update
infra/docker/deploy.sh update --no-pull     # update from the working tree as-is
infra/docker/deploy.sh                       # bare: install if new, else update
```

`install` never touches git — re-running it can only re-install what is
already on disk. The operator `scripts/deploy.sh` is the production path
and its `require_main_checkout` guard refuses any checkout that is not the
main one on `main`, which rules out a staging box parked on a branch.
`update` covers the gap in between.

It refuses before it touches anything: a missing `.env` (the box was never
installed), no docker, not a git checkout, a foreign-checkout box, or —
when pulling — a dirty tree, all abort with the reason. The pull is
`--ff-only`, so a diverged branch stops the run rather than being merged by
a script. Nothing in the stack has moved at that point.

**`update` classifies hot-vs-cold** the same way the production substrates
do — via `Grappa.Deploy.Preflight`, which diffs the pull for changes that
cannot be hot-swapped (`mix.lock`/`mix.exs`, the supervision tree, migrations,
long-lived GenServer state shape):

- **HOT** → `POST /admin/reload` swaps the changed modules into the live
  BEAM. Sessions are preserved; nothing restarts. This is the common case
  — the tree is bind-mounted and the image is toolchain-only, so ordinary
  code changes compile at boot with no rebuild.
- **COLD** → the stack is rebuilt and recreated (image build, cic bundle,
  deps, migrations, `up --force-recreate`) when the diff is not hot-safe.

Two cases always go cold: **`--no-pull`** (the working-tree diff has an
empty commit range preflight cannot classify, and a recreate is never
wrong) and a **stopped stack** (you cannot hot-reload a box that is down —
this is the start-again-after-`stop` path). `--force-hot` / `--force-cold`
override the classifier. `/healthz` is polled until it answers, then the
URL is printed from `.env`.

## Upgrading from the two-container topology

Installs from before #485 ran **two** containers: grappa on loopback,
and a `grappa-nginx` front door that served the PWA, added the security
headers, and held the LAN-facing port. #485 collapsed that into one:

- **The BEAM now serves the SPA and owns every security header**
  (`GrappaWeb.Plugs.SecurityHeaders` — the CSP that guards the bearer
  token is emitted in-app, not by nginx). The nginx **container** is
  gone entirely.
- **grappa takes over the LAN binding** nginx used to hold. The old
  `.env` split the ports as `NGINX_PUBLISH=<host>:80` (LAN) +
  `GRAPPA_PUBLISH=127.0.0.1:4000` (grappa behind nginx); the new box
  has grappa alone on the published port.

`infra/docker/deploy.sh update` does the `.env` migration for you — but the
**very first** upgrade off a two-container box needs `git pull`
**before** you run it, for two reasons: the pre-change checkout has no
`infra/docker/deploy.sh` yet, and its old `compose.yaml` still references
the removed nginx service. So run the pull yourself once, then update the
just-pulled tree cold:

```sh
git pull --ff-only                          # get the #485/#503 scripts + compose first
infra/docker/deploy.sh update --no-pull     # force-cold: migrate .env, build + deps, cic, check, stop, migrate, seed, recreate
```

> **Why `--no-pull` here.** You already pulled by hand, so re-pulling would
> be a no-op with an empty commit range — which the hot-vs-cold classifier
> cannot read. `--no-pull` forces the **cold** path, and the cold path runs
> the full sequence unconditionally: image build, `deps.get`, the cic
> bundle, the migration check, the container stop, `grappa.migrate`, the
> theme seed, and `up --force-recreate`. A box that predates
> #485 has almost certainly crossed migration, dep, and bundle commits, and
> the cold path applies all of them — no hand-run steps, unlike the old
> update's diff-driven table. The critical one is `grappa.migrate`: crossing a
> schema-adding commit without it boots new code against the old schema, and
> the health poll times out. It runs with the old container stopped (issue
> 1112), so if it fails the box is down until you fix it — the script says so. From then on run `infra/docker/deploy.sh update`
> normally (it pulls and classifies hot-vs-cold).

On that run the script:

1. **Rewrites your `.env` in place** — drops the deprecated
   `NGINX_PUBLISH`, and (unless you'd set a non-default `GRAPPA_PUBLISH`)
   moves nginx's old host binding onto `GRAPPA_PUBLISH` by stripping the
   `:80` container side, so the box comes back on the **same URL and
   port** with no hand edits. It prints a one-line warning telling you
   what it changed.
2. **Sweeps the stale `grappa-nginx` container** with
   `--remove-orphans` — removing the service from `compose.yaml` does
   **not** stop the container it created, and a leftover `grappa-nginx`
   would keep the host port bound and block the new single-container box
   from binding it.

**The one thing to check yourself:** if you front grappa with your own
TLS reverse proxy (Caddy, nginx, a cloud LB), point it at grappa's
published port now — **not** at the deleted nginx's port — and make sure
it forwards grappa's headers untouched. It must **not** add a
`Content-Security-Policy` of its own: duplicate CSP headers are enforced
by the browser as their *intersection*, which silently tightens the
policy and breaks the app. Verify exactly one of each header:

```sh
curl -sI https://your.host/ | grep -iE 'content-security-policy|x-frame-options'
```

## Exposing it beyond localhost (TLS)

The default install binds to `127.0.0.1`, which is the safe, fully-working
mode: `http://localhost` is a secure context, so the PWA (service worker,
push, install-to-homescreen) works without TLS.

To reach grappa from other devices you need **HTTPS** — browsers refuse to
register a service worker over plain HTTP off-localhost (and over an
untrusted cert), so the PWA breaks without it. Put a TLS reverse proxy in
front; the Docker stack stays HTTP-only behind it. In `.env`, set
`PHX_HOST` so Phoenix accepts the `wss://` origin and mints correct links,
then restart:

```sh
# .env
PHX_HOST=grappa.example.org
# docker compose -f compose.yaml --profile prod up -d
```

### Option A — Caddy (simplest; public domain)

[Caddy](https://caddyserver.com) provisions and auto-renews a Let's Encrypt
certificate for you. With a domain pointed at the host and ports 80+443
reachable from the internet, the whole config is:

```caddyfile
grappa.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

`reverse_proxy` forwards the WebSocket upgrade and sets
`X-Forwarded-Proto`/`-For` automatically. Run `caddy run` (or the service)
— no cert files, no renewal cron, nothing else.

### Option B — nginx (reference config)

If you already run nginx, use
[`infra/nginx-tls-frontend.example.conf`](infra/nginx-tls-frontend.example.conf):
a self-contained TLS vhost (modern ciphers, HSTS, the `/socket` WebSocket
block, `/sw.js` no-cache) adapted from the production front. Replace the
`<placeholders>`, point `ssl_certificate*` at your cert, reload.

### LAN only (no public domain)

ACME can't issue a public cert for a private address, so use a
locally-trusted CA — then the service worker still registers:
[`mkcert`](https://github.com/FiloSottile/mkcert) (`mkcert -install` once,
then `mkcert grappa.lan`) feeding the nginx reference, or Caddy's `tls
internal`. A plain self-signed cert will **not** do — the browser rejects
the service worker.

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
  `HTTP_BIND=127.0.0.1:3100 infra/docker/deploy.sh install`.
- **`cannot talk to the Docker daemon`.** Start Docker, or add yourself to
  the `docker` group (then re-login).
- **Health check timed out.** Inspect the last logs:
  `docker compose -f compose.yaml --profile prod logs --tail=200 grappa`.

## How it's wired

One long-lived `grappa` container runs the Elixir/OTP bouncer
(`mix phx.server`) against a sqlite database under `runtime/`. It serves
everything itself: the REST API, the WebSocket, the cicchetto PWA + its
static assets (via `Plug.Static`, `CIC_DIST_ROOT`), and the
Content-Security-Policy + sibling security headers
(`GrappaWeb.Plugs.SecurityHeaders`). The `prod` profile adds one
throwaway `cicchetto-build` container that compiles the PWA bundle into
`runtime/cicchetto-dist` and exits — there is no nginx in the box (#485
dropped it). State that must survive a rebuild — the database, uploads —
lives in `runtime/` on the host. See
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the operator runbook and
[CLAUDE.md](CLAUDE.md) for the architecture.
