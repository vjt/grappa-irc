# Operations Runbook

Operator + developer runbook for Grappa. CLAUDE.md links here for the
verbose catalogs (verbs, scripts, deploy machinery, per-host overrides,
runtime data, monitoring). Keep this file in sync when adding a verb,
script, deploy class, or runtime knob.

**Substrates — read this first.** Dev/test = Docker on the pi
(`scripts/*.sh`; the container is the runtime). **Prod = the m42
FreeBSD bastille jail** (`scripts/deploy-m42.sh`; operator section
below). The Docker `--profile prod` stack is the full-stack compose
profile (nginx + cic bundle — the name predates the jail move) used
for dev, e2e, and self-hosters; it is NOT this project's production.
Nothing production runs on the pi.

## Operator dispatcher — `bin/grappa`

`bin/grappa` is the host-side operator interface. One verb per task,
boot-time mix tasks + live-state remsh verbs co-located under one
banner. Always invoke from the repo root (or any worktree dir) — the
dispatcher cd's to the main repo for docker compose and forwards
worktree volumes via oneshot bindings (same machinery as
`scripts/*.sh`).

> **2026-05-31 admin-panel CRUD cluster:** every mix-task verb below
> now has a REST equivalent under `/admin/*` (admin-gated). Prefer
> the **AdminPane in cic** (browser UI) for ad-hoc operator actions
> — it surfaces the same context functions through typed forms +
> inline-confirm destructive verbs + a live AdminEvents stream so the
> mutation is visible to other admins in real time. The mix verbs
> stay as the scripting / boot-time / no-browser path; both routes
> share the same context functions, so behavior is identical.
>

```
bin/grappa help                  # list verbs grouped by category
bin/grappa help <verb>           # per-verb help

# Boot-time verbs (mix tasks; auto-detect MIX_ENV from container):
bin/grappa create-user --name <user> --password <pw>
bin/grappa bind-network --user <user> --network <slug> --nick <nick> --auth <method> [--source <ip>]
bin/grappa add-server --network <slug> --host <host> --port <port> [--tls] [--source <ip>]
bin/grappa remove-server --network <slug> --host <host> --port <port>
bin/grappa set-network-caps --network <slug> [--max-visitor-sessions N] [--max-user-sessions N] [--max-per-client N]
bin/grappa unbind-network --user <user> --network <slug>
bin/grappa update-network-credential ...
bin/grappa seed-scrollback ...
bin/grappa gen-encryption-key
bin/grappa gen-vapid

# Live-state verbs (--rpc-eval against the live BEAM via T-2 dist shell):
bin/grappa delete-visitor <uuid>     # sync terminate + Repo.delete; frees cap slot
bin/grappa reap-visitors             # force-run Visitors.Reaper.sweep (otherwise 60s tick)
bin/grappa list-sessions             # tab-separated: subject, network_id, pid, mailbox, memory
bin/grappa list-credentials          # tab-separated: user, network, nick, state (ALL states)
bin/grappa list-visitors             # tab-separated: id, nick, network, expires_at, identified

# Live-state attach:
bin/grappa remote-shell              # iex --remsh against live BEAM
bin/grappa remote-shell --batch -e <expr>   # one-shot --rpc-eval

# Debug:
bin/grappa open-db [sqlite3 args...] # interactive sqlite3 (RW; auto-detects MIX_ENV)
bin/grappa shell                     # bash inside the live container
```

The Elixir entry points for live-state verbs live in
`lib/grappa/operator.ex` (`Grappa.Operator.delete_visitor!/1`,
`list_*_text!/0`, etc.) — one feature, one code path: the bash
dispatcher is thin, the logic + text formatting is testable Elixir
that survives a schema field rename.

### Per-server outbound source address (`--source`)

`bind-network` and `add-server` accept `--source <ip>` to pin the
outbound TCP source address for **that server entry** (one
`network_servers` row). Must be a strict literal IPv4 or IPv6 address
(no hostname, no CIDR); stored canonical. NULL = kernel default / the
`GRAPPA_OUTBOUND_V6_POOL` rotation. Full design:
`docs/DESIGN_NOTES.md` (2026-06-03 entry) + the 2026-06-04 prod
deployment entry.

Operational facts that bite:

- **Source is per-server, and the picker chooses ONE server per
  network** (`Servers.pick_server!/1` → lowest priority). So two
  subjects (e.g. an operator and the visitor pool) cannot get
  different sources on the **same** network — they need **separate
  `networks` rows** even if they point at the same IRC host:port.
  Visitors are compile-pinned to `:visitor_network`
  (`config/config.exs`), so the operator's dedicated-source network is
  the one that moves to a new slug.
- **No `update-server` verb.** To set/change `source_address` on an
  existing server, `remove-server` then `add-server --source` (or the
  AdminPane server-edit form).
- **A `--source` that overlaps `GRAPPA_OUTBOUND_V6_POOL`** is excluded
  from the visitor pool at boot (`OutboundV6Pool.apply_exclusions/1`);
  the task prints a notice. The exclusion is recomputed only at
  Bootstrap, so an overlapping add to a running node leaves the pool
  until the next restart.
- **The bind is per-server, not per-subject.** Any session that
  resolves a `source_address`-pinned server uses that IP — visitor or
  user alike. Keeping visitors off a dedicated-source network is the
  operator's config responsibility (point `:visitor_network` at a
  pool-only network).

## Developer scripts — `scripts/*.sh`

Sibling layer to `bin/grappa` for inner-loop development: gates,
container plumbing, ad-hoc shells. `bin/grappa` doesn't try to absorb
these — they're a different audience (developer iterating inside a
worktree vs. operator running against the live container).

**Always use relative paths from the repo root** (`/srv/grappa` for
main, or the worktree dir like `~/code/IRC/grappa-task2/`). Never
`cd /srv/grappa &&`, never absolute `/srv/grappa/scripts/foo.sh`. The
scripts are worktree-aware: they detect the worktree, cd to the MAIN
repo for docker compose (so the project name + image + named volumes —
deps, _build, hex, mix, PLT — are shared across all worktrees) and
bind-mount the worktree's source files (lib, test, config, priv/repo,
mix.exs, etc.) on top via `-v` overrides. The live container always
has main's source mounted; from a worktree, `scripts/*` always uses
oneshot runs so the worktree code wins. Anything not overridden
(priv/plts cache, runtime/sqlite db) comes from the main repo so PLT
cache and operator state stay single-source.

```
scripts/mix.sh <task>        # mix task in container (--env=dev|prod|test override)
scripts/iex.sh               # IEx shell in container
scripts/test.sh              # mix test --warnings-as-errors
scripts/credo.sh             # mix credo --strict
scripts/dialyzer.sh          # mix dialyzer
scripts/format.sh            # mix format
scripts/format.sh --check    # mix format --check-formatted (CI mode)
scripts/check.sh             # full mix ci.check (every gate)
scripts/bats.sh              # bats suite for bin/grappa
scripts/bun.sh <cmd>         # bun in oven/bun:1 oneshot against cicchetto/ (install / add / run test / run check / run build)
scripts/testnet.sh up|down|status|logs|probe|shell  # e2e testnet stack standalone (no Playwright)
scripts/integration.sh       # full e2e suite (testnet + grappa + nginx + Playwright)
scripts/db.sh                # sqlite3 RO against runtime/grappa_dev.db
scripts/healthcheck.sh       # curl /healthz
scripts/monitor.sh           # docker compose logs -f
scripts/observer.sh          # observer_cli runtime introspection
scripts/deploy.sh            # DEV (local Docker stack): auto-detects hot-vs-cold via git-diff preflight
scripts/deploy.sh --force-hot   # dev, bypass preflight, hot-deploy unconditionally
scripts/deploy.sh --force-cold  # dev, skip preflight, cold-deploy (rebuild + recreate)
scripts/deploy-cic.sh        # DEV cic bundle (Docker): vite build + broadcast bundle_hash for refresh banner
scripts/deploy-m42.sh        # PROD: ssh m42 + sudo bastille cmd → infra/freebsd/deploy.sh (server, auto hot/cold)
scripts/deploy-m42.sh --cic  # PROD cic bundle: jail_deploy_cic.sh (hot, no BEAM restart)
scripts/register-dns.sh      # operator: register host in local DNS
scripts/shell.sh             # bash inside container (debug only — bin/grappa shell preferred)
```

For how + when to use the test-running scripts (`test.sh`,
`check.sh`, `bun.sh run test`, `integration.sh`) including the
e2e cascade-vs-flake-vs-real-bug triage runbook + iso-rerun
discipline, see **`docs/TESTING.md`**.

**The container IS the runtime.** No local Elixir installation, no host
`mix deps.get`. All commands run inside the `grappa` container. NEVER run
`mix` or `iex` on the host. NEVER install hex packages on the host.
NEVER raw `docker compose` — use the scripts.

**Bash 4+ required.** Scripts use `declare -ag` (associative-global
arrays) which macOS's `/bin/bash` 3.2 rejects. Shebangs are
`#!/usr/bin/env bash` so PATH-resolution finds Homebrew bash 5 first
on macOS, system bash 4+ on Linux. `brew install bash` if missing.

## Hot vs cold deploy — when each path triggers

Both substrates share one preflight: `lib/grappa/deploy/preflight.ex`
classifies a `(prev_sha, new_sha)` diff as HOT or COLD. The substrate
scripts (`scripts/deploy.sh` for Docker, `infra/freebsd/deploy.sh`
for the m42 bastille jail) shell out to `mix run --no-start -e
'Grappa.Deploy.Preflight.cli([from, to])'`, dispatch on exit code.

**Module reload uses `:code.modified_modules/0` + `:code.load_file/1`
directly — NOT `Phoenix.CodeReloader`.** The Phoenix reloader is a
dev-only facility: it depends on Mix (absent in `mix release`
artifacts → no-op on the FreeBSD jail) and is gated behind a config
check that silently no-ops in `MIX_ENV=prod` even when Mix is
present (wrongly trusted back when prod still ran on Docker — the
2026-05-16 M-4 incident; prod moved to the m42 jail 2026-05-27).
`POST /admin/reload` walks `:code.modified_modules/0`
and `:code.load_file/1`s each — release-friendly, Mix-free, works
identically in the dev Docker stack and the jail release.

The .beam-on-disk must be fresh BEFORE the reload POST. That's the
substrate's job:
- **Docker**: `docker exec grappa mix compile` writes
  `_build/${MIX_ENV}/lib/grappa/ebin/*.beam`.
- **Jail**: `mix release --overwrite` (as `grappa` user) writes
  `_build/prod/rel/grappa/lib/grappa-X.Y/ebin/*.beam` — the
  daemon's `code:get_path/0` includes that release-internal path;
  the parallel `_build/prod/lib/grappa/ebin/` is NOT on the daemon's
  code path so `mix compile` alone is insufficient. The release
  rebuild is the difference between "new .beam on disk somewhere"
  and "new .beam on disk where the live BEAM looks."

**HOT** (default when preflight returns HOT — sessions preserved,
daemon pid unchanged): `lib/*.ex` edits, `cicchetto/src/` edits
(cic bundle deploy is its own path), most config tweaks.

**COLD** (forced by `--force-cold` or any of these diff classes
— Docker: image rebuild + `--force-recreate`, ~30s downtime;
jail: `mix release --overwrite` + `service grappa restart`, ~10-30s
downtime):

- `mix.lock` / `mix.exs` (deps + version + apps callback)
- `lib/grappa/application.ex` (supervision tree read at boot only)
- state-shape change in a long-lived `GenServer` — `defstruct`,
  `@type t :: %{...}`, or `init/1` map literal modified.
  Authoritative module list: `lib/grappa/hot_reload/long_lived_modules.ex`
  (`@modules` + `@state_helpers`). The preflight reads the SoT
  directly via `LongLivedModules.all/0` + extracts the state block
  via the Elixir tokenizer (no regex, no awk).
- `Dockerfile`, `compose.yaml`, `bin/start.sh`, `bin/grappa` —
  Docker image substrate
- `infra/freebsd/rc.d/grappa`, `infra/freebsd/deploy.sh` — jail
  substrate. Operator-on-demand verbs
  (`infra/freebsd/jail_*.sh`) and `grappa.env.example` are HOT.
- `priv/repo/migrations/*` — hot path skips `mix ecto.migrate`;
  new tables/columns 500 on first query post-reload, Bootstrap
  crash-loops if it reads them.
- `infra/nginx.conf`, `infra/freebsd/nginx.conf`, or
  `infra/snippets/*` — hot path doesn't reload nginx; CSP
  allowlist drift particularly bad (new captcha provider won't
  take effect, cic widgets 404).
- `config/*.exs` (any) — SECRET_SIGNING_SALT motivation; runtime
  config is hot-safe via `runtime.exs` but compile-time
  `config.exs` requires a recompile boot.

Conservative bias: in doubt, COLD. `:code.load_file/1` does NOT
refuse unsafe diffs at runtime — it loads the new .beam, returns
`{:module, _}`, and lets the crash arrive at the next message
that exposes the shape change (could be hours later). The
preflight is the only line of defense.

`scripts/deploy-cic.sh` is independent (Docker) — runs the
`cicchetto-build` oneshot then POSTs `/admin/cic-bundle-changed`.
On the jail, the server-side `infra/freebsd/deploy.sh` rebuilds the
cic bundle on COLD only; the cic-only hot flow is
`infra/freebsd/jail_deploy_cic.sh` (git pull + vite build +
POST `/admin/cic-bundle-changed`, NO BEAM restart). The server
broadcasts the new bundle hash on every live user-topic; cic's
`BundleRefreshBanner` surfaces a refresh CTA on mismatch with the
hash baked into the page the browser loaded. Server deploys never
auto-trigger a cic refresh.

### m42 (FreeBSD bastille jail) — host-side wrapper

The `infra/freebsd/jail_*.sh` scripts run INSIDE the jail as root
(`sudo bastille cmd grappa <script>`) and are documented "invoke from
m42 host". `scripts/deploy-m42.sh` is the host-side caller that wraps
the `ssh m42` + `bastille cmd` incantation — run it from any checkout
with ssh access to m42:

```
scripts/deploy-m42.sh                # server deploy, auto hot/cold (infra/freebsd/deploy.sh)
scripts/deploy-m42.sh --force-hot    # server, force hot (passthrough)
scripts/deploy-m42.sh --force-cold   # server, force cold (passthrough)
scripts/deploy-m42.sh --cic          # cic-only bundle, hot, no BEAM restart (jail_deploy_cic.sh)
```

**Push first.** The jail scripts `git pull --ff-only` from origin/main,
so push before deploying. `deploy-m42.sh` fetches origin and refuses to
run if local main is ahead (guards the "deployed a stale tree" trap).
Overridable via `M42_HOST` / `JAIL` / `JAIL_REPO` env. Mirrors the
Docker split: `deploy.sh` ↔ `deploy-m42.sh`, `deploy-cic.sh` ↔
`deploy-m42.sh --cic`.

When the auto-detect gets it wrong (rare), `--force-hot` and
`--force-cold` override the preflight on both substrates. Use
sparingly and document why in the commit message.

### Running operator actions against the live jail (prod)

Prod is a **bastille jail** (JID 6, `/usr/local/bastille/jails/grappa/root`,
release at `/home/grappa/grappa`, DB `runtime/grappa_prod.db`, env
`/usr/local/etc/grappa/grappa.env`). Reach it with
`ssh root@m42` → `jexec 6 …`.

- **`bin/grappa` (the dispatcher) is docker-only — it FAILS in the
  jail** (`docker: not found`). It's a dev/RPi tool.
- **Mix tasks don't work either** in the jail: a second BEAM collides
  with the live node's Endpoint `:4000` in the shared netns.
- **Drive the LIVE node via the release `rpc`** instead. Source the
  env first (or `rpc` returns `:noconnection` — needs `RELEASE_COOKIE`):

  ```sh
  jexec 6 su -l grappa -c 'set -a; . /usr/local/etc/grappa/grappa.env; set +a;
    /home/grappa/grappa/_build/prod/rel/grappa/bin/grappa rpc "<elixir>"'
  ```

  For multi-line Elixir, `scp` an `.exs` into the jail and
  `Code.eval_file(~s(/path))` (the `~s()` sigil dodges quote-mangling
  through ssh→jexec→su). Context fns are all on the live node
  (`Grappa.Networks.*`, `…Credentials.*`, `Grappa.Session.stop_session/3`).
- **`service grappa restart` has a stop/start node-name race** —
  cold boot can abort with `name grappa@grappa … in use by another
  Erlang node`. If so: confirm no `beam.smp`, check `epmd -names` is
  clean, then a plain `service grappa start` (cold boot ~20s).
- **`unbind_credential/2` refuses to drop the LAST user-credential
  from a network that still has scrollback** (cascade-on-empty →
  `:scrollback_present` rollback). To remove a binding while keeping
  the network alive for visitors, delete the credential row directly +
  `Session.stop_session`.

**Jail package dependencies.** `Grappa.Uploads.MetadataStrip` (#39)
shells out to `exiftool` (images + mp4/mov) and `ffmpeg` (webm remux).
The Docker image installs both via the Dockerfile (`apk add exiftool
ffmpeg` — dev/CI/e2e get them for free); the jail needs the FreeBSD
packages installed ONCE, **before** deploying the strip release:

```sh
ssh root@m42 'pkg -j 6 install -y p5-Image-ExifTool ffmpeg'
```

The strip is fail-CLOSED: with the binaries missing, every image and
video upload is rejected 422 `metadata_strip_failed` (documents
unaffected). The error log names the missing binary
(`exiftool not found on PATH — …`), so a post-deploy upload failing
with that line means this step was skipped.

**Jail outbound source IPs.** The jail is shared-IP
(`jail.conf ip6=new`, `interface=vtnet0`); pool + per-server
`source_address` IPs are `/128` aliases in `jail.conf ip6.addr`. To add
a new source the jail can bind: append `vtnet0|<ip>/<prefix>` to
`ip6.addr` (persist) + `jail -m jid=6 ip6.addr="…,vtnet0|<ip>/<prefix>"`
(apply live, no restart). **Validated 2026-06-04: a shared-IP jail can
bind a host-owned address, and jail teardown does NOT strip an address
the host already owned** (jail(8) only removes what it added) — so the
host's primary `::42` (rDNS `m42.openssl.it`, owned by `/etc/rc.conf`)
is safe to share into the jail. Match the host's prefixlen (`::42/64`,
not `/128`, or you collide with the host's on-link route).

**fail2ban gotcha.** fail2ban runs on the **host** (9 jails incl.
`http-404`, `http-ratelimit`, `recidive`). A cic client looping on a
dead token (e.g. after a password rotation) racks up `REFUSED
CONNECTION` / 404s and gets the source IP banned — which then blocks
that IP's user **and** visitor sessions, looking like a "hung BEAM."
Unban: `fail2ban-client unban <ip>` (global) on m42; fix the client
(clear cic's `localStorage["grappa-token"]` → re-login) before it
re-bans. The **`http-400`** jail (`/usr/local/etc/fail2ban/jail.d/defaults.local`)
carries an `ignoreregex` exempting `/read-cursor\b` 400s: cic POSTs the
read-cursor with an invalid `message_id` on service-nick query windows
(NickServ/ChanServ/OperServ) and would self-ban the operator otherwise
(issue #44 tracks the cic fix). `\b` keeps a forged `/read-cursorEVIL`
still bannable. Validate edits with
`fail2ban-regex <line> <filter.conf> '<ignoreregex>'`.

## CSP / security headers (nginx-added, NOT Phoenix)

The Content-Security-Policy + sibling security headers
(`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
…) are added by **nginx**, sourced from
**`infra/snippets/security-headers.conf`** (this repo — single source).
That one file is BOTH Docker-mounted under `--profile prod` AND
installed into the jail at
`/usr/local/etc/nginx/snippets/security-headers.conf` by
`jail_install_nginx.sh`. **Phoenix emits no CSP** — confirm with
`curl -sD - http://127.0.0.1:4000/ -o /dev/null` inside the jail (no
`content-security-policy` line). The jail nginx serves the cic bundle
statically (`root /usr/local/www/cic`); the host m42 nginx
(`/usr/local/etc/nginx/sites/irc.openssl.it`) only proxies and does
NOT add the CSP. Prod hosts: **`irc.sniffo.org` / `irc.sindro.me`**
(`irc.openssl.it` is the host vhost name + redirect).

**Captcha inline-script gotcha (2026-06-06).** The Turnstile/hCaptcha
loader `api.js` (allowed via its host in `script-src`) does not just
run from its origin — once executed it **injects a small inline
`<script>`** into the document to bootstrap the challenge. With no
`'unsafe-inline'` and no hash in `script-src`, the browser blocks that
inline script (`script-src-elem`) and the captcha silently never
initialises (Firefox: "blocked the execution of an inline script").
Fix = pin the inline script by its CSP3 **sha256 hash** in `script-src`
(currently `'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM='`),
NEVER relax to `'unsafe-inline'` (that would also re-enable first-party
inline XSS). **CAVEAT:** the hash IS the provider's inline-bootstrap
bytes, so a provider-side widget update changes them → captcha breaks
under CSP again; the browser console prints the replacement `sha256-…`
to add. (Aside: prod ships with captcha **disabled** —
`grappa.env` has no `GRAPPA_CAPTCHA_*` → provider `disabled`; the
widget only renders where a provider is enabled.)

**Deploying a CSP/snippet change to the jail** — no BEAM or cic rebuild
needed; push to origin first, then pull + install the one snippet +
`nginx -t` + reload (reload only fires if the test passes):

```sh
ssh m42 "sudo bastille cmd grappa su -l grappa -c 'cd /home/grappa/grappa && git pull --ff-only origin main'"
ssh m42 "sudo bastille cmd grappa sh -c 'install -o root -g wheel -m 0644 \
  /home/grappa/grappa/infra/snippets/security-headers.conf \
  /usr/local/etc/nginx/snippets/security-headers.conf && nginx -t && service nginx reload'"
```

(or `jail_install_nginx.sh` for the full nginx config + all snippets +
`nginx -t` + reload). Verify the live header:

```sh
ssh m42 "curl -fsSL -D - -o /dev/null https://irc.sniffo.org/ 2>&1 | grep -i script-src"
```

## Per-host compose overrides

Committed `compose.yaml` ships deployment-agnostic defaults: grappa
publishes on `127.0.0.1:4000` (loopback only); `--profile prod` adds
nginx (default `3000:80` wildcard publish) + cicchetto-build oneshot.
Anyone can clone + `docker compose up`; nothing depends on a particular
LAN, hostname, or vlan.

Personal bindings (LAN/VLAN IP for inbound, `PHX_HOST`,
`EXTRA_CHECK_ORIGINS`) live in gitignored `compose.override.yaml` —
template at `compose.override.yaml.example` covers the
"bind-grappa-to-LAN" + "bind-nginx-to-LAN-with-PHX_HOST" shapes.
`scripts/_lib.sh` auto-detects it and appends as a second `-f` flag.
Use `ports: !override` to drop+replace the base file's publish (NOT
`!reset`, which drops without re-adding).

When proposing a new IP-bound or hostname-pinned binding, put it in
the override, NEVER in the committed base. Same for nginx.conf and
the CSP snippet — `'self'` covers same-origin ws/wss automatically;
don't hardcode hostnames there.

## Runtime Data

- **Database**: sqlite via `ecto_sqlite3`. WAL journal mode under
  `MIX_ENV=prod` (set in `config/runtime.exs`). Files at
  `runtime/grappa_dev.db` (dev) / `runtime/grappa_prod.db`
  (`MIX_ENV=prod` — the m42 jail, or a Docker stack run with
  `--env=prod`). Docker bind-mounts them from the host via
  `compose.yaml`; the jail keeps them as plain files under
  `/home/grappa/grappa/runtime/`.
- **Migrations**: standard Ecto.
  - Write migration in `priv/repo/migrations/<timestamp>_<name>.exs`.
  - Dev: `scripts/mix.sh ecto.migrate`.
  - Deploys: the preflight classifies ANY new migration file as COLD
    (Class 5 — there is no in-reload migrate until #41 lands). The
    cold paths run it: Docker via `mix ecto.migrate`, the jail via
    `Grappa.Release.migrate()` before `service grappa restart`.
    Never `--force-hot` past a new migration — the DML is skipped
    and the code reads defaults (the uploads-2 key-rename would have
    silently reverted tuned caps this way).
  - Never apply DDL manually via raw SQL. Always Ecto.Migration so
    `schema_migrations` stays in sync.
  - Use `:text` for free-text columns. Don't bake length limits into
    sqlite — adjust at the schema layer if needed.
- **Log file**: container's stdout, captured by Docker JSON logger
  (5MB × 3 files; 10MB × 5 under `--profile prod`). Tail via
  `scripts/monitor.sh`. On the FreeBSD jail (prod), `bin/grappa daemon`'s
  `run_erl` tees the BEAM's stdout to `runtime/log/erlang.log.*`
  (plus `runtime/pipe/` for `bin/grappa remote` + `runtime/pid` for
  the daemon), driven by `RELEASE_TMP=runtime` exported by
  `infra/freebsd/rc.d/grappa`. The rotation set survives
  `mix release --overwrite` (which would otherwise blow away
  `_build/.../tmp/log/`).
- **Config**: DB-driven (Phase 2 sub-task 2j replaced the TOML loader).
  Operator binds users + networks via mix tasks: `mix grappa.create_user`
  creates a `User` row, `mix grappa.bind_network --auth ...` writes a
  `Networks.Credential` (with encrypted SASL/NickServ passwords via
  Cloak.Vault). `Grappa.Bootstrap` reads every credential at boot via
  `Networks.list_credentials_for_all_users/0` and spawns one
  `Session.Server` per row. Adding a binding requires no config edit —
  next reboot picks it up.

## Monitoring

- **Health**: `scripts/healthcheck.sh` (curl `/healthz`) — dev. Prod:
  `ssh m42 "sudo bastille cmd grappa curl -fsS http://127.0.0.1:4000/healthz"`.
- **Logs**: `scripts/monitor.sh` (docker compose logs -f) — dev. Prod:
  tail `runtime/log/erlang.log.*` inside the jail (see Runtime Data).
- **Runtime introspection**: `scripts/observer.sh` (observer_cli — see
  every supervised process, mailbox depth, memory).
- **Phoenix.LiveDashboard** mounted at `/admin` (dev only by default;
  Phase 5 hardening adds prod with auth).
- **Telemetry**: events emitted via `:telemetry`; metrics aggregated
  via `Telemetry.Metrics`. Phase 5 adds Prometheus exporter.
