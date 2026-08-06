# Operations Runbook

Operator + developer runbook for Grappa. CLAUDE.md links here for the
verbose catalogs (verbs, scripts, deploy machinery, per-host overrides,
runtime data, monitoring). Keep this file in sync when adding a verb,
script, deploy class, or runtime knob.

**Substrates — read this first.** Dev/test = Docker on the pi
(`scripts/*.sh`; the container is the runtime). **Prod = the m42
FreeBSD bastille jail** (`scripts/deploy-m42.sh`; operator section
below). The Docker `--profile prod` stack is a single long-lived
grappa container (the `cicchetto-build` oneshot builds the SPA the BEAM
self-serves — #485 dropped the in-stack nginx container) used for dev,
e2e, and self-hosters; it is NOT this project's production. Nothing
production runs on the pi.

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
bin/grappa bind-network --user <user> --network <slug> --nick <nick> --auth <method> [--source <ip>] [--services-flavor <azzurra|atheme|oftc|unknown>]
bin/grappa add-server --network <slug> --host <host> --port <port> [--tls] [--source <ip>]
bin/grappa remove-server --network <slug> --host <host> --port <port>
bin/grappa set-network-caps --network <slug> [--max-visitor-sessions N] [--max-user-sessions N] [--max-per-ip N]
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
DB-driven vhost rotation pool. Full design: `docs/DESIGN_NOTES.md`
(2026-06-03 entry) + the 2026-06-04 prod deployment entry.

This is now the **per-network FALLBACK** source. #228 (2026-07-14) added
a per-SUBJECT layer ABOVE it (vhost pin / self-selection) — see "Vhost
(source-bind) selection" below. Resolution precedence per connect:
**pin > selection∩allowed (random) > `--source` fallback > pool/kernel.**

Operational facts that bite:

- **Source is per-server, and the picker chooses ONE server per
  network** (`Servers.pick_server!/1` → lowest priority). Pre-#228 this
  meant two subjects could not get different sources on the **same**
  network. #228 lifts that: a per-subject pin/selection now overrides
  the per-server source, so a dedicated-source-per-user no longer needs
  a separate `networks` row — grant/pin the vhost instead.
- **No `update-server` verb.** To set/change `source_address` on an
  existing server, `remove-server` then `add-server --source` (or the
  AdminPane server-edit form).
- **The `--source` fallback only applies when the subject has no pin
  and no active selection.** A vhost pin/selection wins.

### Vhost (source-bind) selection — per subject (#228)

`--source` pins one address per **server**; #228 adds a per-**subject**
layer managed entirely through the admin panel + user settings (no env
var). Model:

- **Universe.** The candidate addresses are the host's bound addresses
  (`:inet.getifaddrs/0`, loopback + link-local filtered). In the m42
  bastille jail this is exactly the jail's assigned `/128`s.
- **`vhosts` table.** Curated inventory. `in_pool` = member of the
  auto-rotation pool (this REPLACES the `GRAPPA_OUTBOUND_V6_POOL` env
  var — the env var is GONE, the pool is DB-driven). `generally_available`
  = any subject may self-select.
- **`vhost_grants` table.** Per-subject grants. A `pinned` grant is an
  admin-forced fixed bind (one per subject, not user-changeable — e.g.
  an oper O:line host). A non-pinned grant is a curated-availability
  grant the subject may self-select. Visitor grants CASCADE on reap.
- **User self-selection** persists in `user_settings` (`vhost_selection`
  key); authz-clamped to the allowed set (generally-available ∪ granted)
  server-side, so a revoked grant can't leak a stale pick.
- **Admin surface:** AdminPane → **Vhosts** tab (`/admin/vhosts` +
  `/admin/vhosts/:id/grants`). Curate inventory, toggle in_pool /
  generally_available, grant/pin/revoke per subject.
- **User surface:** Settings drawer → **source address (vhost)**
  widget (`/me/settings/vhost`). Native multi-select, In-pool /
  Out-of-pool optgroups, limited to the subject's allowed set. A pin
  renders read-only.
- **Live-apply:** a vhost change takes effect on the subject's **next
  (re)connect** — it re-resolves the plan via `refresh_plan`. Changing a
  vhost does NOT auto-bounce a live session (it's a preference; the
  operator/user reconnects when ready).
- **Pool safety net (spec §3):** the effective rotation pool = `in_pool`
  vhosts MINUS every per-server `--source` fixed address, so an
  auto-allocated session can never pick a dedicated address. Recomputed
  at Bootstrap AND on any admin inventory edit (hot).

### Upstream TLS trust store (`--tls`, #89)

TLS server entries (`--tls`, typically port 6697) connect with
`verify: :verify_peer` — the upstream cert chain is validated against
this host's **system CA trust store**, with SNI + RFC-6125 hostname
matching (`Grappa.IRC.Client.tls_connect_opts/1`). grappa ships no
cacertfile and pins no cert; the anchor set IS the OS CA bundle.

Operational facts that bite:

- **Keep the OS CA bundle current** — that's the entire trust
  configuration. FreeBSD (the m42 bastille jail): the `ca_root_nss`
  package provides `/etc/ssl/cert.pem`; `pkg upgrade ca_root_nss` inside
  the jail refreshes it. Linux: `update-ca-certificates`. macOS (dev):
  the system keychain. If `:public_key.cacerts_get/0` finds no store it
  **raises** at connect time (surfaced via the connect-fail throttle) —
  a loud failure, never a silent downgrade to no-verification.
- **A private / self-signed upstream will NOT connect.** The handshake
  fails at cert validation and the session enters the connect-fail
  throttle. The fix is to add that network's CA to the **system** trust
  store (the standard OS mechanism) — grappa is never weakened to a
  per-network `verify_none`.
- **Hostname mismatch is fatal too.** The cert's SAN (or CN) must cover
  the host in the `network_servers` row. For a round-robin upstream
  (e.g. `irc.azzurra.chat`), EVERY pool member's cert must carry the
  dialed name in its SAN, or connects fail intermittently on the members
  that don't. Probe before binding a new TLS host:
  ```sh
  openssl s_client -connect <host>:<port> -servername <host> \
    -verify_return_error </dev/null 2>&1 | grep -iE "Verify return code|CN ="
  ```
  Run it per A/AAAA record for a round-robin host; all must return
  `Verify return code: 0` AND carry the dialed name in SAN.

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
scripts/iex.sh               # iex --remsh into the LIVE node (alias for bin/grappa remote-shell)
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
scripts/observer.sh          # observer_cli against the LIVE node (no second app boot)
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

**Fresh-worktree e2e submodule gotcha.** A brand-new worktree has an
empty `cicchetto/e2e/infra` (the `azzurra-testnet` submodule), so the
first `integration.sh` aborts trying to SSH-clone it — SSH to GitHub is
blocked on the worker. Permanent fix, set repo-local once:
`git config url.https://github.com/.insteadOf git@github.com:` makes every
future worktree auto-init the submodule over HTTPS. Manual fallback if it
ever recurs: offline-init from the main checkout's already-cloned objects
— `git -c protocol.file.allow=always -c
submodule."cicchetto/e2e/infra".url=<main-checkout>/.git/modules/cicchetto/e2e/infra
submodule update --init cicchetto/e2e/infra`.

**The container IS the runtime.** No local Elixir installation, no host
`mix deps.get`. All commands run inside the `grappa` container. NEVER run
`mix` or `iex` on the host. NEVER install hex packages on the host.
NEVER raw `docker compose` — use the scripts.

**Toolchain image (#364 docker S1).** The Docker image is toolchain-only
— base + apk packages, no baked hex/deps/`_build`. Every runtime shape
bind-mounts the repo over `/app`, and hex/deps/`_build` all live under
`/app`, so anything baked would be shadowed by the mount. Deps are
installed into the bind-mounted tree at first boot instead: a fresh
`docker compose up` self-heals via `bin/start.sh` (installs hex + runs
`deps.get` when `deps/` is empty), `infra/docker/deploy.sh install` does
it explicitly, `scripts/deploy.sh` syncs on every deploy, and the e2e
seeder installs before `grappa-test` boots. Image builds are seconds, not
minutes; the first `up` on a fresh clone is the one slow boot (deps
fetch + compile), warm reboots finish in seconds.

**Bash 4+ required.** Scripts use `declare -ag` (associative-global
arrays) which macOS's `/bin/bash` 3.2 rejects. Shebangs are
`#!/usr/bin/env bash` so PATH-resolution finds Homebrew bash 5 first
on macOS, system bash 4+ on Linux. `brew install bash` if missing.

## Hot vs cold deploy — when each path triggers

Both substrates share one preflight: `lib/grappa/deploy/preflight.ex`
classifies a `(prev_sha, new_sha)` diff as HOT or COLD **for the
calling substrate**. The substrate scripts (`scripts/deploy.sh` +
`infra/docker/deploy.sh update` for Docker, `infra/linux/deploy.sh` for
the native systemd host, `infra/freebsd/deploy.sh` for the m42 bastille
jail — all thin consumers of the shared `infra/lib/deploy_common.sh`
algorithm, #503) shell out to `mix run --no-start -e
'Grappa.Deploy.Preflight.cli([from, to, substrate])'` with substrate
`"docker"` / `"linux"` / `"jail"`, dispatch on exit
code: 0 → HOT, 3 → COLD, anything else (1 = mix crash, 2 = usage
error) **aborts the deploy** — a crash or miswired call must never
degrade into a silent always-COLD guess. COLD is deliberately not
exit 1: a crashed mix oneshot exits 1, and on the jail the env-less
preflight did exactly that on every run (found live 2026-06-10 —
`runtime.exs` raises on missing `DATABASE_PATH` under
`MIX_ENV=prod`; the jail deploy now sources
`/usr/local/etc/grappa/grappa.env` for the preflight oneshot, same
`set -a` flow as `jail_release.sh`). The substrate argument is
required — a missing or unknown value is a usage error (exit 2).
Most diff classes
are substrate-independent; the boot-substrate files are scoped (see
the COLD list below) so a Dockerfile diff no longer cold-restarts the
jail (2026-06-10 incident: prod restarted, all IRC sessions dropped,
for bytes the jail never reads).

**A fifth consumer of the same `deploy_common.sh`, but ALWAYS COLD: the
release-image Docker path (#503 unit D).** A checkout-less host running the
published ghcr image — `infra/docker/deploy.sh` in release mode, or the
`curl | bash` `get.sh` bootstrap — has no `Phoenix.CodeReloader` and no git
range to classify, so its `update` NEVER shells out to preflight: it
force-colds (`docker pull` → migrate → `rm -f` + `run -d` recreate) through the
shared cold path. It is the one substrate with no hot branch at all; hot-on-image
is #503 unit E. Runbook below.

**Module reload uses `:code.modified_modules/0` + soft-purge +
`:code.load_file/1` (`Grappa.HotReload`) — NOT `Phoenix.CodeReloader`.**
A module can be hot-reloaded repeatedly between restarts: the context
soft-purges the old version first (a bare `load_file` fails
`:not_purged` on the second reload — live-repro 2026-06-10). If a
process still runs old code the reload refuses with
`:old_code_in_use` instead of killing it, the response's `failed`
list is non-empty, and the jail deploy aborts rather than declaring
success. Hot deploys that ADD modules are covered too: never-loaded
beams in the app ebin are loaded via `:code.load_abs/1`
(`:code.modified_modules/0` can't see them, embedded mode never
lazy-loads, and the OTP 26+ cached code path makes plain `load_file`
return `:nofile` for post-boot files — all three bit live
2026-06-10). The jail deploy also writes `runtime/last-deployed-sha` on
completion; a re-run with unchanged HEAD but a stale/missing marker
re-drives the whole deploy (a prior run died mid-flight) instead of
exiting "nothing to do". The Phoenix reloader is a
dev-only facility: it depends on Mix (absent in `mix release`
artifacts → no-op on the FreeBSD jail) and is gated behind a config
check that silently no-ops in `MIX_ENV=prod` even when Mix is
present (wrongly trusted back when prod still ran on Docker — the
2026-05-16 M-4 incident; prod moved to the m42 jail 2026-05-27).
The marker is also the PREFLIGHT RANGE BASE: the jail classifies
`marker..HEAD`, not pre-pull-HEAD..HEAD, because cic deploys
(`jail_deploy_cic.sh`) advance the jail HEAD without applying server
changes — a pre-pull base silently dropped server commits that landed
between two cic deploys (defect #7, the 2026-06-11 outage). A
garbage marker aborts the deploy loudly with a fix-it hint; only an
ABSENT marker falls back to the pre-pull HEAD.
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

- `mix.lock` / `mix.exs` (deps + version + apps callback).
  ⚠️ **A deps-version bump (`mix.lock`) crashes the AUTO preflight
  classifier**: it runs `mix` in the prod env against deps the bump
  ADDs but hasn't fetched yet → `lock mismatch … Can't continue due
  to errors on dependencies`, preflight exits 1, deploy aborts
  CLEANLY (prod untouched, sessions intact). Deploy a deps bump with
  **`scripts/deploy-m42.sh --force-cold`** — it skips the classifier
  and the cold rebuild runs `mix deps.get`. Seen 2026-06-29 on the
  EEF-CVE dep bump (cowlib/mint/plug/req).
- `lib/grappa/application.ex` (supervision tree read at boot only)
- state-shape change in a long-lived `GenServer` — `defstruct`,
  `@type t :: %{...}`, or `init/1` map literal modified.
  Authoritative module list: `lib/grappa/hot_reload/long_lived_modules.ex`
  (`@modules` + `@state_helpers`). The preflight reads the SoT
  directly via `LongLivedModules.all/0` + extracts the state block
  via the Elixir tokenizer (no regex, no awk).
- `Dockerfile`, `.dockerignore`, `compose*.yaml`, `bin/start.sh`,
  `bin/grappa` — **Docker substrate only**; the jail never reads
  these, so they classify HOT there.
- `infra/freebsd/rc.d/grappa` — **jail substrate only** (rc wrapper
  read at service start); Docker classifies it HOT. The jail cold
  path runs `jail_install_rcd.sh` between stop and start, so the
  restart boots through the new wrapper. The sibling
  `rc.d/grappa_ndp_keepalive` was retired 2026-08-02 (#628) — the
  routed-/64 jail has no proxy-NDP neighbour cache to keep warm — and
  #923 DELETED its three files after confirming nothing copied,
  installed, enabled, started or tested them. Recover them from the
  #628 commit if the service is ever needed again.
- `infra/freebsd/bin/*` (the source-alias privilege wrapper) — **HOT on
  purpose (#646)**. It is exec'd fresh by sudo on every call, so nothing
  about it lands in the running BEAM and a restart would buy nothing. It
  is instead RECONCILED on every deploy, hot and cold, by
  `jail_install_source_alias.sh` (deploy_common's `substrate_reconcile`
  hook). Do not add it to a cold class: that would charge a full session
  drop to copy a file, and would still miss the wrapper's prefix config,
  which is rendered from the DB and so has no changed path to classify.
  Deploy orchestrators
  (`scripts/deploy.sh`, `infra/freebsd/deploy.sh`),
  operator-on-demand verbs (`infra/freebsd/jail_*.sh`) and
  `grappa.env.example` are HOT on both substrates — nothing about
  them lands in the running BEAM (d8f354c).
- `priv/repo/migrations/*` — hot path skips `mix ecto.migrate`;
  new tables/columns 500 on first query post-reload, Bootstrap
  crash-loops if it reads them.
- `infra/snippets/*` — COLD on **every** substrate: every surviving
  nginx includes this shared proxy surface. Each substrate's OWN
  config (`infra/freebsd/nginx.conf`, `infra/linux/nginx.conf`) is
  COLD **only on that substrate** since #923 — before the scoping,
  editing the Linux config forced a session-dropping COLD on the m42
  jail, for a file the jail never opens. Hot path doesn't reload
  nginx. Since #485
  these are DUMB reverse proxies (no headers, no allowlist), so a
  change here is rare; when it happens, the hot BEAM swap won't
  pick it up — reload nginx by hand or COLD-deploy. NOTE: the CSP
  itself is NO LONGER here — it moved into the BEAM
  (`GrappaWeb.Plugs.SecurityHeaders`), so a captcha-provider CSP
  edit is now a code change (COLD), not an nginx reload.
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

**`CIC_DIST_ROOT` must be set absolute on the jail (issue #526).** The
BEAM reads the built `index.html` from `CIC_DIST_ROOT` (default
`runtime/cicchetto-dist`, repo-root-relative) to compute the broadcast
hash. That relative default only works where the process CWD is the repo
root — true under Docker (`WORKDIR /app`) and native systemd
(`WorkingDirectory=<repo>`), but NOT the jail: `rc.d/grappa` starts the
release with `su -m grappa -c '.../bin/grappa daemon'` and sets no
WorkingDirectory. So `grappa.env` MUST carry
`CIC_DIST_ROOT=/home/grappa/grappa/runtime/cicchetto-dist` (absolute,
alongside `DATABASE_PATH` / `UPLOADS_STORAGE_ROOT` for the same reason);
unset, `/admin/cic-bundle-changed` returns **204** and no banner is ever
broadcast even though nginx serves the fresh bundle fine. Both cic-deploy
wrappers now treat a 204 as a hard failure (non-zero exit) instead of the
old ✓, so this misconfiguration reddens the deploy instead of degrading
silently. `cic_dist_root` is stashed in `:persistent_term` at BEAM boot,
so a fresh `CIC_DIST_ROOT` only takes effect after a **COLD** deploy
(BEAM restart) — a hot cic-only deploy will keep returning 204 until then.

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
scripts/deploy-m42.sh --full-restart # cold deploy + single host bastille-restart (binds NEW vhosts in one bounce)
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

**`--full-restart` — bind a NEW jail vhost in ONE session-drop window.**
A new vhost (or any jail-layer network change) needs both a cold deploy
AND a host `bastille restart` to bind it — two bounces, two drop windows.
`--full-restart` collapses them: the jail runs `deploy.sh --force-cold
--defer-restart` (stages the new release + rc.d wrappers, STOPS the BEAM,
exits without restarting it — marker deliberately NOT written), then the
host does a single `bastille restart grappa` that boots the staged
release through the new wrapper and binds the vhost. The host wrapper
then healthchecks (`FULL_RESTART_HC_URL`/`_RETRIES`/`_SLEEP`, defaults
`http://127.0.0.1:4000/healthz` 30×2s) and, only on success, writes
`runtime/last-deployed-sha` inside the jail (reading the jail's own HEAD).
Use it ONLY when a vhost/jail-network change must take effect; a plain
`--force-cold` is enough for ordinary cold deploys. **The host-side
`jail.conf` / `grappa.env` vhost edit is a separate manual operator step
at restart time — `--full-restart` does NOT touch it.** Never rehearsed
against prod (it bounces the live jail + drops every session); bats-proven
only — first real run is operator-driven.

### Linux (systemd) — no host wrapper needed

A third production substrate for a plain Ubuntu/Debian host, no
Docker, no jail. Full setup + day-2 ops runbook lives in
`infra/linux/README.md`; summary here for parity with the m42 section
above:

```
infra/linux/install.sh   # first install, idempotent (see README.md for env)
infra/linux/deploy.sh    # update: pull, rebuild, migrate, restart, healthcheck
infra/linux/release.sh   # bin/grappa wrapper: version / eval / remote
```

No SSH-to-a-separate-host indirection — run these directly on the
target box as root. `deploy.sh` is preflight-driven, same as the
Docker/jail substrates: `Grappa.Deploy.Preflight` classifies each
deploy's diff and picks hot (rebuild + `POST /admin/reload`, sessions
preserved) or cold (full stop → rebuild → migrate → start cycle)
automatically — see `infra/linux/README.md` "Day-2 operations".

Stop/start synchronization (the FreeBSD jail's `jail_beam_wait.sh`
problem, defect #9) is solved differently here: the systemd unit runs
`bin/grappa start` in the **foreground** under `Type=exec`, so
`systemctl stop`/`restart` block natively until the BEAM actually
exits — no custom wrapper needed. See
`infra/linux/systemd/grappa.service`'s comments for the full rationale.

### Release-cutting — version-first, then GitHub release + tag + News/Releases

**Cut the version FIRST, deploy SECOND — never bump after (vjt 2026-08-02).**
The **repo-root `VERSION` file** bump (#652 moved it out of `mix.exs @version`)
MUST ride into the deploy as the **last commit of the range being shipped**, be
tagged on that commit, and only THEN deployed — the version bump is the
*pre-deploy* half of release-cutting; the GH release + tag + News sequence below
is the post-deploy half. WHY version-first still holds after #652: the shipped
range must self-report the version it IS, and the tag must equal `CTCP VERSION`
exactly. `Version.base/0` now returns a compile-time constant baked from
`VERSION` (an `@external_resource`), so a HOT deploy of a `VERSION`-only bump
DOES refresh the reported string as the recompiled `Grappa.Version` beam
reloads — a `VERSION`-only bump is HOT (it no longer touches `mix.exs`, so
`Preflight.mix_deps?` no longer forces COLD; that reversed the pre-#652 rule).
The one lag: the running node's `.app` vsn stays at its boot value until the
next cold restart, but `Grappa.Version` is the only thing that ever read it, so
nothing observes the divergence. Corollary: an **unplanned** prod move (a
migration, a jail cutover) is still something you version BEFORE, not after —
bump `VERSION` in the range so the artifact self-reports honestly rather than
patching a string afterward. Do NOT re-hardcode `@version` in `mix.exs`: it
reads `VERSION` at build time, and re-inlining a literal silently reinstates
the COLD (guarded by `version_single_source_test.exs`).

Standing order (vjt 2026-07-24): a batch deploy is not "done" until a GitHub
release is cut AND the site's News/Releases entry is committed. After a **batch
cold-deploy** lands on Azzurra (prod) and verifies healthy, run the full
sequence:

1. **Batch cold-deploy** (`deploy-m42.sh --force-cold`) → **Azzurra-verify**
   (`/healthz` 200 + sessions reconnect + sanity).
2. **The orchestrator CREATES a GitHub release + tag** on `vjt/grappa`, with a
   **SEMVER bump SIZED TO THE BATCH**: a big batch = a **MINOR** bump, NOT
   patchlevel; a **patch** bump only for a small / fix-only batch. The tag ≡ the
   version grappa reports in `CTCP VERSION`, EXACTLY (issue #391 wires it:
   `Grappa.Version` folds the compiled `VERSION`-file constant (#652) with a
   compile-time git snapshot — a clean release tag matching that version → bare
   `X.Y.Z`; anything else → `X.Y.Z-<shortsha>`, `-dev` if git is absent). A
   released build reports the bare version; an unreleased build carries the
   suffix. Keep the `VERSION` file and the tag in lockstep at cut time.
3. **Ping vjt** (via the ircbot) with **the tag + the release URL + 2 lines of
   highlight**. vjt then writes the site's News entry (next step) from that.
4. **News/Releases `news.json` entry — vjt's lane.** vjt writes a `news.json`
   entry that LINKS the GitHub release + ~20 words of highlight (NOT a changelog
   dump), then **commits/pushes it to `grappa-www` AND deploys** (scp to m42
   `htdocs`) **+ CF-purge**. Anti-drift: the News content is never
   deployed-not-committed (the trigger was testimonials left live-but-uncommitted).
   Schema authoritative in **grappa-www#4**; reuse the existing item shape (no
   `news.js` renderer change):

   ```json
   {
     "date": "YYYY-MM-DD",
     "text": { "en": "curated blurb", "it": "blurb curato" },
     "link": {
       "href": { "en": ".../grappa/releases/tag/<tag>", "it": ".../grappa/releases/tag/<tag>" },
       "label": { "en": "release notes →", "it": "note di rilascio →" }
     }
   }
   ```

   - **Prepend** to `items[]` (newest first). `text` = a curated, bilingual,
     ~20-word highlight (NOT the raw dev changelog); `link` → the GitHub release.

   **Division of labor:** ORCHESTRATOR = create the GH release + ping vjt with
   (tag, URL, 2-line highlight). vjt = news.json entry + grappa-www commit / push
   / deploy / CF-purge.
5. **Dual-net announce** (#grappa on Azzurra + Libera via the ircbot) + `gh issue
   close` the deployed issues + strip their `status:soon`.

### The published release image (ghcr.io) — #503 unit C

Cutting a `vX.Y.Z` tag also builds and pushes a **self-contained release
image** to `ghcr.io/vjt/grappa` — a fourth `release.yml` job (`docker`)
alongside `deb`/`arch`/`rpm`. It is the `curl | bash` / `docker run`
substrate's payload; the bring-up + one-liners that consume it are **#503 unit
D** — see **Running the published image** below.

- **What it is.** A `mix release` (bundled ERTS + compiled beams + the built
  cicchetto SPA), built from `Dockerfile.release` — DISTINCT from the top-level
  `Dockerfile`, which is the dev/CI toolchain image. It boots `bin/grappa start`
  and **has NO `Phoenix.CodeReloader`**: the published image is a runtime, not a
  hot-edit dev environment. The `compose`/dev stack stays the development
  runtime; a hot update on the release image swaps beams into
  `lib/grappa-<vsn>/ebin` and fires `Grappa.HotReload` (unit E), never the dev
  reloader.
- **Tags + labels.** `:v<git tag>` always, plus `:latest` ONLY when that tag is
  the highest semver in the repo (a backport tag push must not re-point `:latest`
  at an older image). Multi-arch `linux/amd64 + linux/arm64` (buildx + QEMU), OCI
  `source`/`version`/`revision` labels so the ghcr package page links back to the
  exact commit. Pushed with the ambient `GITHUB_TOKEN` (`packages: write`). The
  `docker` job is standalone (publishes to the registry itself, not a Release
  asset) — it is NOT in `publish`'s `needs`.
- **Version.** The image reports the BARE `X.Y.Z` (no `.git` in the build
  context → the `#391` no-git path, like the AUR tarball). `docker inspect`
  shows the image tag; the RUNNING app is the version source of truth.
- **VALIDATE BEFORE A REAL TAG — the zero-publication dry-run.** A tag push is
  the only thing that publishes, so a broken `docker` job is discovered with the
  tag already cut and `:latest` possibly moved. Validate the job (the SAME one
  that ships, not a copy) BEFORE a real tag whenever `Dockerfile.release`, the
  job, or the release toolchain changes — via the `docker_validation` dispatch:

  ```sh
  # runs from ANY branch, so it works BEFORE merge; publishes NOTHING
  gh workflow run release.yml --ref <branch> -f docker_validation=true
  ```

  It builds `Dockerfile.release` multi-arch from the DISPATCHED ref (the branch —
  which is why it works pre-merge, when only the branch carries the file) with
  `push:false` and no registry login: it proves the build (arm64 QEMU + the
  ABI-lockstep assertion + cic + `mix release`) and pushes nothing, moves no
  `:latest`. deb/arch/rpm/publish are skipped for this run. The default
  (`docker_validation=false`) tag-push path is unchanged — it publishes. The
  arm64 leg is QEMU-emulated on the amd64 runner; a stale QEMU crashes the
  emulated BEAM JIT at the first `mix` call, so the job pins a recent
  `tonistiigi/binfmt` via `setup-qemu-action`. If the emulated arm64 leg proves
  unreliable on CI, the fallback (needs vjt's sign-off — it deviates from the
  buildx+QEMU decision) is native arm64 runners (`ubuntu-24.04-arm`) +
  `docker manifest`.
- **Local build** (validate the Dockerfile without CI):
  `docker buildx build -f Dockerfile.release --load -t grappa-release:test .`
  builds the native arch; add `--platform linux/amd64,linux/arm64` for the
  multi-arch manifest (needs `docker run --privileged --rm tonistiigi/binfmt
  --install all` first for a recent QEMU).

### Running the published image (`docker run` / `curl | bash`) — #503 unit D

A checkout-less host runs the release image above with plain `docker` — no
compose, no source, no `mix`. `infra/docker/deploy.sh` in **release mode**
(auto-selected when there is no `compose.yaml` two levels up, or forced with
`GRAPPA_DEPLOY_MODE=release`) grows the same `install`/`update`/`stop`/bare
verbs against `docker run`. The `curl | bash` bootstrap `infra/docker/get.sh`
lays the three shell files it needs (`deploy.sh`, the `deploy_common.sh` it
sources, and the `infra/packaging/gen-secrets.sh` it generates secrets with)
into `$GRAPPA_HOME`, then hands off:

```sh
# install — asks for PHX_HOST, or set it inline to skip the prompt
curl -fsSL https://raw.githubusercontent.com/vjt/grappa-irc/main/infra/docker/get.sh | bash
# update — ALWAYS cold (see below)
curl -fsSL https://raw.githubusercontent.com/vjt/grappa-irc/main/infra/docker/get.sh | bash -s -- update
```

- **Bare `docker run` works too (#862).** The first thing anyone types on
  seeing a ghcr package is `docker run ghcr.io/vjt/grappa:<tag> start`, and
  until #862 it died on a missing `SECRET_KEY_BASE` pointing at a
  `scripts/mix.sh` the image does not ship. The entrypoint now generates the
  six secrets on first boot with the same `gen-secrets.sh`, onto the `/data`
  volume as `grappa.env` (0600, beside the DB, so it follows a relocated
  `DATABASE_PATH`):

  ```sh
  docker run -v grappa-data:/data -p 127.0.0.1:4000:4000 \
      -e PHX_HOST=grappa.example.org ghcr.io/vjt/grappa:latest
  ```

  `PHX_HOST` is still required and still raises — nothing can invent your
  domain. Everything the operator passes with `-e` / `--env-file` WINS and is
  never overwritten; when the environment already carries all six (the
  `deploy.sh` path) the entrypoint writes nothing to `/data` at all. Secrets
  are **never rotated**: on a volume that already has the file it is reused
  byte-for-byte. **`/data/grappa.env` is a backup target** — losing
  `GRAPPA_ENCRYPTION_KEY` loses every stored upstream credential.
- **The bare run also MIGRATES, by default (#867).** Past the secrets wall the
  same one-liner used to die on `no such table: admin_events`: the image ships
  the migrator but nothing on the bare path invoked it, and inside the image
  there is no mix, no checkout and no deploy script to invoke it with. The
  entrypoint now runs `Grappa.Release.migrate()` before it boots the release —
  **only** for the verbs that boot one (`start`, `start_iex`, `daemon`,
  `daemon_iex`), so `docker run … eval 'Grappa.Release.migrate()'` is never
  nested inside itself.
  - `GRAPPA_AUTO_MIGRATE=0` turns it off; anything other than `0`/`1` is
    rejected loudly rather than guessed (reading `true` as false would put the
    bug back on a box whose operator thinks it is on). Empty means unset, the
    same as everywhere else in that file.
  - `deploy.sh` passes `GRAPPA_AUTO_MIGRATE=0` on its own `docker run`: that
    path migrates from the host, before recreating the container, which is the
    ordering a schema change wants. **An orchestrated / multi-instance
    deployment must do the same** and run the migration as its own job — the
    default is ON because the only shipped consumers of this image are
    single-container, NOT because concurrent starts are safe. Two BEAMs
    migrating one sqlite file is corruption, and nothing here serialises them
    (nor does anything else: one BEAM per DB file is the whole persistence
    model).
  - **A failed migration refuses to boot**, exit 1, with the migrator's error
    on stderr. Nothing is dropped or re-created: Ecto runs each migration in
    its own transaction, so the volume is left readable and `schema_migrations`
    records exactly what applied. Measured — a deliberately failing migration
    left all 112 schema objects and the user rows intact, and the box came back
    with `/healthz` 200 once the cause was removed. Booting anyway and
    answering healthy on a schema nobody vouched for is the failure mode this
    refuses to have.
- **State + secrets.** All config + every prod secret live in
  `$GRAPPA_HOME/grappa.env` (default `~/.grappa/grappa.env`, mode `0600`). It is
  generated ONCE on `install` and **never regenerated** — rotating
  `SECRET_KEY_BASE` / `GRAPPA_ENCRYPTION_KEY` under a live box invalidates every
  session and makes Cloak-encrypted upstream creds undecryptable, so a re-run of
  `install` on an existing box reuses it untouched. Back it up.
- **Secret generation — ONE generator (#862).** All six secrets come from
  `infra/packaging/gen-secrets.sh`, the same openssl-only, idempotent script the
  `.deb`/`.rpm` postinstall runs and the release image's entrypoint runs on
  first boot. No secret ever touches argv or stdout: the generator writes
  straight into the env file, which is built as `grappa.env.partial` and only
  `mv`'d into place once every secret is in (a half-written file would be worse
  than none — the next run would take the "reusing the existing env file"
  branch and boot a secret-less box). It replaced two divergent openssl
  transcriptions plus a throwaway `docker run … eval` for the VAPID pair; the
  claim that host openssl "cannot safely reproduce a raw P-256 point" was false
  and is now measured in `test/infra/gen_secrets_test.bats`.
- **`PHX_HOST`** is required and asked interactively on `/dev/tty` (a piped
  one-liner reads the answer from your terminal, NOT the pipe); set `PHX_HOST=…`
  to skip the prompt. There is no silent `localhost` fallback — a wrong
  `PHX_HOST` mints dead upload links + rejects WebSocket origins (#468).
- **Data.** The sqlite DB + uploads live on a named docker volume
  (`grappa-data` → `/data`). `stop` removes the container but keeps the volume;
  `stop --volumes` drops it (destroys the DB).
- **Knobs.** `GRAPPA_IMAGE` (default `ghcr.io/vjt/grappa:latest`), `GRAPPA_HOME`
  (default `~/.grappa`), `GRAPPA_PUBLISH` (default `127.0.0.1:4000`),
  `GRAPPA_CONTAINER` (default `grappa`), `GRAPPA_DATA_VOLUME` (default
  `grappa-data`), `GRAPPA_RAW_BASE` (the `get.sh` download origin, for a
  fork/branch).
- **`update` is ALWAYS cold.** No `CodeReloader` in the image + no git range to
  classify → `update` skips preflight and force-colds: `docker pull` a newer
  image, migrate (`docker run … eval 'Grappa.Release.migrate()'` against the full
  prod env + the data volume), then `docker rm -f` + `docker run -d` to recreate.
  The DB + uploads on the volume survive; only the running container is replaced.
  Hot-on-image is **#503 unit E**.
- **Front door.** The container serves plain HTTP on `GRAPPA_PUBLISH` and owns
  its own CSP + security headers (#485) — put your TLS front door in front as a
  dumb reverse proxy, exactly as the from-source path.

> **The PUBLISHED image is verified — measured 2026-08-06 against
> `ghcr.io/vjt/grappa:v0.12.0`.** The `docker` job has now run on four real tag
> pushes (`v0.9.0`, `v0.10.0`, `v0.11.0`, `v0.12.0`) and was green on every one.
> `:latest`, `:v0.12.0`, `:v0.11.0` and `:v0.10.0` all resolve to an ANONYMOUS
> pull (the package is public), `:latest` serves the same manifest as
> `:v0.12.0`, and it is a real multi-arch OCI index — `linux/amd64` +
> `linux/arm64`. On the published artifact the OCI `revision` label equals the
> `v0.12.0` commit and `version` equals `0.12.0`. Reproduce with the same two
> verbs the local build uses:
> `GRAPPA_TEST_IMAGE=ghcr.io/vjt/grappa:v0.12.0 scripts/release-image.sh
> fresh-boot`, then `warm-boot` — both answered `/healthz` 200, and the running
> app reported `"version":"0.12.0"` on `/api/config`, so the tag and the code it
> runs agree (the check that matters, since the image reports the bare no-git
> version).
>
> **Still NOT measured**, so do not read the above as more than it says: the
> boot ran on an arm64 host, so only the **`linux/arm64`** leg has been
> executed — the QEMU-built `amd64` leg is proven to BUILD and to publish, never
> to boot. And `update` has not been driven across two published tags.

### AWS one-click box (CloudFormation) — #665

A checkout-less, install-nothing-locally path for someone with an AWS account:
[`infra/aws/grappa-cloudformation.yaml`](../infra/aws/grappa-cloudformation.yaml)
launches a single stock-Ubuntu EC2 box that installs the latest release `.deb`
and terminates its OWN TLS. Operator-facing INSTALL flow (launch URL, the five
knobs, delete) is in [`INSTALL.md`](../INSTALL.md#one-click-on-aws-cloudformation);
this is the runbook.

- **The shared bootstrap is `infra/cloud/first-boot.sh`.** The CFN `UserData`
  curls it at a git ref (`main`) and execs it — it is NEVER inlined into the
  template. The same script is the future Terraform `user_data`. The two doors
  share ONLY this script + the knob names in `infra/cloud/params.contract`; the
  resource graph (CFN YAML vs Terraform HCL) stays two hand-written files. CI
  runs `infra/cloud/check-drift.sh` to prove both doors reference `first-boot.sh`
  and expose the same knobs.
- **AMI.** Resolved at stack-create time from Canonical's SSM public parameter
  (`/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`)
  — region-agnostic, no hardcoded/per-region AMI ids. **amd64 only** (the `.deb`
  is amd64-only; do not pick a Graviton instance type).
- **Version pin = latest.** No apt repo exists — `first-boot.sh` fetches the
  *latest* release's `grappa_<ver>_amd64.deb` (grep of
  `api.github.com/repos/vjt/grappa-irc/releases/latest`, no `jq`). Same story as
  the #503 `get.sh` path.
- **TLS is single-box + DEFERRED.** Unlike `infra/linux/` (a dumb HTTP proxy
  behind an upstream TLS box), this box terminates TLS itself: `first-boot.sh`
  installs nginx + certbot, writes an HTTP site that `include`s the FETCHED #485
  proxy snippet, then defers cert issuance because the Elastic IP — and thus DNS
  — is unknown at first boot. Issuing blind would burn Let's Encrypt's
  5-failed-validations-per-hour quota. It installs `/usr/local/sbin/grappa-tls`
  (domain + email baked in) and enables a `grappa-tls.service` boot oneshot that
  best-effort retries; issuance happens the moment DNS resolves — either the
  operator runs `sudo grappa-tls`, or a reboot-after-DNS self-issues.
- **DNS order.** Point the domain's A record at the stack's Elastic IP
  (`PublicIp` / `DnsRecord` Outputs) BEFORE issuing TLS.
- **Env + secrets.** The `.deb` postinstall creates `/etc/grappa/grappa.env`
  (0640 root:grappa) and mints secrets via `gen-secrets.sh` (openssl-only);
  `first-boot.sh` force-sets `PHX_HOST` (= Domain) + `VAPID_SUBJECT` (=
  `mailto:AdminEmail`) and re-locks 0640. Back up `GRAPPA_ENCRYPTION_KEY`.
- **Ongoing ops.** It is a native systemd host — `journalctl -u grappa -f`,
  `systemctl restart grappa`, `sudo grappa migrate`, `sudo grappa gen-secrets`
  all work exactly as the packaged native-Linux path. certbot installs its own
  renewal timer.
- **Delete.** The stack is fully deletable (instance + SG + Elastic IP, all
  `DeleteOnTermination`/no-retain).

> **Acceptance is a MANUAL check (vjt).** cfn-lint ran best-effort only (no AWS
> creds in CI); a real launch from a clean account → HTTPS reachable, ≥2 regions,
> stack fully deletes has NOT been run yet. The template + `first-boot.sh` were
> built and bats-tested against their SHAPE (stubbed apt/systemctl/nginx/certbot),
> not against a live AWS account.

### Running operator actions against the live jail (prod)

Prod is a **bastille jail** (name `grappa`, `/usr/local/bastille/jails/grappa/root`,
release at `/home/grappa/grappa`, DB `runtime/grappa_prod.db`, env
`/usr/local/etc/grappa/grappa.env`). Reach it with
`ssh root@m42` → `jexec grappa …`. **Reference the jail by NAME, not a
numeric JID** — JIDs are assigned at start and DRIFT across restarts
(2026-06-21: a doc'd `jexec 6` failed `jail 6 not found`; `ssh root@m42 jls`
lists the current map). `bastille cmd grappa` / `pkg -j grappa` take the
name too.

- **`bin/grappa` (the dispatcher) is docker-only — it FAILS in the
  jail** (`docker: not found`). It's a dev/RPi tool.
- **Mix tasks don't work either** in the jail: a second BEAM collides
  with the live node's Endpoint `:4000` in the shared netns.
- **Drive the LIVE node via the release `rpc`** instead. Source the
  env first (or `rpc` returns `:noconnection` — needs `RELEASE_COOKIE`):

  ```sh
  jexec grappa su -l grappa -c 'set -a; . /usr/local/etc/grappa/grappa.env; set +a;
    /home/grappa/grappa/_build/prod/rel/grappa/bin/grappa rpc "<elixir>"'
  ```

  For multi-line Elixir, `scp` an `.exs` into the jail and
  `Code.eval_file(~s(/path))` (the `~s()` sigil dodges quote-mangling
  through ssh→jexec→su). Context fns are all on the live node
  (`Grappa.Networks.*`, `…Credentials.*`, `Grappa.Session.stop_session/3`).
- **`service grappa restart` node-name race — fixed 2026-06-11**
  (defect #9): `grappa_stop` now blocks until the BEAM exits and epmd
  releases the name, and `grappa_start` refuses a registered name +
  verifies the node comes up (an early boot death is a loud ERROR,
  not a silent "Starting grappa."). Both sides delegate to
  `infra/freebsd/jail_beam_wait.sh` — shared with deploy.sh's cold
  path. If a restart still aborts with `name grappa@grappa … in use`
  (e.g. a stale pre-fix wrapper): confirm no `beam.smp`, check
  `epmd -names` is clean, then a plain `service grappa start`
  (cold boot ~20s); re-run `jail_install_rcd.sh` to refresh the
  wrapper.
- **`unbind-network` always succeeds and never deletes the network
  (GH #105).** Unbind only detaches the user's credential + stops the
  live session; the network row persists even when its last binding
  goes away (it stays available for visitors). The old cascade-on-empty
  rollback that refused to detach the last user from a visitor-scrollback
  network — and the manual direct-row-delete workaround it forced — are
  gone. To actually retire a network, use `Networks.delete_network/1`
  (refuses while any credential or archival scrollback still references
  it; delete the scrollback first).

**Jail package dependencies.** `Grappa.Uploads.MetadataStrip` (#39)
shells out to `exiftool` (images + mp4/mov) and `ffmpeg` (webm remux).
The Docker image installs both via the Dockerfile (`apk add exiftool
ffmpeg` — dev/CI/e2e get them for free); the jail needs the FreeBSD
packages installed ONCE, **before** deploying the strip release:

```sh
ssh root@m42 'pkg -j grappa install -y p5-Image-ExifTool ffmpeg'
```

The strip is fail-CLOSED: with the binaries missing, every image and
video upload is rejected 422 `metadata_strip_failed` (documents
unaffected). The error log names the missing binary
(`exiftool not found on PATH — …`), so a post-deploy upload failing
with that line means this step was skipped.

The daemon must also SEE them: rc(8) services get rc.subr's stock
PATH without `/usr/local`, so `infra/freebsd/rc.d/grappa` prepends
`/usr/local/bin:/usr/local/sbin` (found live 2026-06-10 — pkgs
installed, every media upload still 422). An rc.d diff classifies
COLD on the jail substrate, and the cold path in
`infra/freebsd/deploy.sh` runs `jail_install_rcd.sh` (idempotent,
refreshes both rc.d wrappers) between stop and start — no manual
step. To apply an rc.d change without waiting for a deploy (or after
a `--force-hot` that skipped it):

```sh
ssh root@m42 'jexec grappa cp /home/grappa/grappa/infra/freebsd/rc.d/grappa \
  /usr/local/etc/rc.d/grappa && jexec grappa service grappa restart'
```

**Jail outbound source IPs.** The jail runs **VNET** on `bridge0`
(`/etc/rc.conf:108`, "trasloco 2026-08-01" — measured 2026-08-05),
reached over a `/126` transfer net: `…:2d3:fffe::1` / `…:fffe::5` host
side, `…:fffe::6` jail side. It has its own network stack, so it
configures its own addresses — which is also what lets mode 2 alias on
`lo0` at all (`A VNET jail is REQUIRED`, below).

> **Stale procedure, deliberately not replaced.** Until the
> 2026-08-01 move this jail was **shared-IP** (`jail.conf ip6=new`,
> `interface=vtnet0`), and a new bindable source was added by appending
> `vtnet0|<ip>/<prefix>` to `jail.conf ip6.addr` plus `jail -m jid=6
> ip6.addr="…"` to apply it live. That procedure belongs to the old
> topology and does not describe the VNET jail. The finding it recorded
> still holds for anyone running shared-IP (validated 2026-06-04: a
> shared-IP jail can bind a host-owned address, and jail teardown does
> not strip an address the host already owned — jail(8) removes only
> what it added, so the host's primary `::42`, rDNS `m42.openssl.it`,
> was safe to share in; match the host's prefixlen or collide with its
> on-link route). **The VNET-era replacement has not been written**: it
> was not measured when this correction was made (#860), so nothing is
> asserted in its place.

**Static-mapping source aliases (#543 mode 2).** The
`static_mapping_with_reservations` addressing mode derives ONE stable
source per untrusted client `/64`, inside the configured derivation
`/80` (`addressing.static_mapping_prefix`), and binds it for the
session lifetime.

> **Addresses in this section, and why they are not interchangeable.**
> Anything shown as a **template you would adapt** uses the RFC 3849
> documentation prefix `2001:db8::/32` — never routable, so a
> copy-paste cannot silently become a plausible-looking prefix that
> goes nowhere. Anything shown as a **measured reading of m42** is real
> and carries the date it was read. On m42, the live derivation block
> is `2a03:4000:20:2d3:cafe::/80` (`addressing.static_mapping_prefix`,
> measured 2026-08-05). The examples here used to name a
> `…:2d3:cb::/80` that **is not routed on the reference host** — the
> exact shape of the #609 incident, sitting in the runbook as the thing
> to copy (#860). This is OFF by default (`addressing_mode` in
`server_settings` defaults to `pool_with_reservations`); it must be
armed per substrate before an admin flips the mode, or every mode-2
session is HELD (`:mode2_disarmed`, credential marked failed) rather
than egressing from the shared kernel-default source.

**PREREQUISITE — the block must be ROUTED to your host, not on-link
(#860).** Everything below assumes the provider already delivers the
whole prefix to the machine. If it does not, every step still succeeds,
`arm_check` still passes, and mode 2 still fails — per session, at the
far end, where nothing you can see locally says why. Settle this first.

- **The distinction, and why mode 2 needs the routed kind.** An
  **on-link** prefix lives on the upstream L2 segment: the router reaches
  each address by NDP, so only the addresses your host actually answers
  for exist. Mode 2 derives addresses across the whole block on demand —
  the outbound packet leaves fine, and the return traffic is dropped by a
  router that never got a neighbour advertisement for that address. A
  **routed** prefix is handed to your host as a next-hop; every address
  inside it reaches you with no NDP involved. Only the second kind works.
- **How to tell which you have.** Ask the provider, in these words: *is
  this prefix routed to my host, and if so, to which next-hop address?*
  The answer, not an inspection, is authoritative — but two checks give
  you the shape:

  ```sh
  # FreeBSD                             # Linux
  ifconfig -a | grep inet6              ip -6 addr
  netstat -rn6                          ip -6 route
  ```

  The prefix your host's own address sits in, with the default route
  pointing at a router inside it (or at a `fe80::` on that link), is your
  on-link segment. A routed block is a **different** prefix, one that
  appears in no interface's on-link scope and only exists because the
  provider says it points at you. If a prefix is only ever mentioned in
  the provider's control panel and never appears on an interface, that is
  the routed one — or a claim you have not tested yet.

  The empirical test, when you want to be sure before arming: put an
  **arbitrary** address from the block (not the one the panel names) on
  the host, and see whether traffic sent to it from outside arrives.
  Routed blocks answer for any address; on-link ones only for the address
  the segment already knows. Pick something that is not silently filtered
  in transit — a listening TCP port is a better probe than ICMP.
- **A routed block usually needs a next-hop address you have to
  configure, and it is not inside the block.** This is the step that is
  easiest to miss, because nothing about the routed prefix hints at it:
  the provider routes toward an address on your **on-link** segment, and
  if your host does not hold that address the entire prefix is dark for
  everyone. On the reference host (m42, netcup "failover subnet"), that
  next-hop is a `/128` alias of the host's EUI-64 on the upstream
  interface — measured 2026-08-05 in `/etc/rc.conf`:

  ```sh
  # the on-link /64 the host lives in
  ifconfig_vtnet0_ipv6="inet6 2a03:4000:2:33c::42 prefixlen 64"
  # next-hop for the routed 2a03:4000:20:2d3::/64 (netcup failover subnet)
  ifconfig_vtnet0_alias0="inet6 2a03:4000:2:33c:5837:69ff:fe76:1f8e prefixlen 128"
  ```

  Note the two prefixes have nothing in common: `2a03:4000:2:33c::/64` is
  the on-link segment, `2a03:4000:20:2d3::/64` is the routed block, and
  the address that ties them together belongs to the **former**. Which
  address your provider expects is their choice — EUI-64, the panel's
  stated gateway peer, whatever they tell you — so this is a question to
  ask, not a value to copy. What generalises is the shape: *a routed
  block is reachable only while the host answers on the next-hop the
  provider routes to.*
- **Getting the block from the host to the process.** With the prefix
  arriving, the substrate steps below (FreeBSD alias wrapper / Linux
  AnyIP route) are what let grappa bind inside it. On m42 the jail sits
  behind a point-to-point link and the host static-routes `/80`s into it
  — same `/etc/rc.conf` reading:

  ```sh
  ifconfig_bridge0_ipv6="inet6 2a03:4000:20:2d3:fffe::1 prefixlen 126"
  ifconfig_bridge0_alias0="inet6 2a03:4000:20:2d3:fffe::5 prefixlen 126"
  ipv6_static_routes="gvhbabe gvhcafe"
  ipv6_route_gvhbabe="2a03:4000:20:2d3:babe:: -prefixlen 80 2a03:4000:20:2d3:fffe::6"
  ipv6_route_gvhcafe="2a03:4000:20:2d3:cafe:: -prefixlen 80 2a03:4000:20:2d3:fffe::6"
  ```

  `fffe::6` is the jail side of the `/126`; `fffe::1` / `fffe::5` are the
  host side. A single-machine install (no jail, no container) skips this
  entirely — the block terminates on the host and the AnyIP route or the
  alias wrapper is the whole path.
- **If your block is on-link, mode 2 does not work on it.** Said plainly
  because the failure is invisible until sessions are held: do not arm it
  and hope. What is actually available:
  - **Ask the provider for a routed prefix.** Frequently a separate
    product from the on-link `/64` that came with the machine, and the
    only path that is not fragile. This is the recommendation.
  - **Proxy NDP over the prefix**, if you must. Per-address `neigh proxy`
    entries cannot cover a `/80` (2^48 addresses), so this means a daemon
    answering for the whole prefix — `net/ndppd` on FreeBSD, packaged on
    most Linux distributions. It puts a userland process in the path of
    every neighbour solicitation for your egress addresses, and #628
    retired grappa's own NDP-keepalive service precisely because the
    routed setup made it unnecessary. Treat it as the fragile option.
  - **Stay on mode 1** (`pool_with_reservations`, the default). Reserved
    named addresses and the shared pool need only ordinary on-link
    addresses. It gives up per-client derivation, not the bouncer.

- **Substrate select.** Set `GRAPPA_SUBSTRATE` in the deploy env
  (`jail` / `linux` / `docker`; unset ⇒ `docker` ⇒ Disabled adapter ⇒
  mode 2 refuses to arm). It is explicit, NOT `:os.type` autodetect —
  a Docker container reports linux yet cannot AnyIP-bind.
- **FreeBSD jail (`GRAPPA_SUBSTRATE=jail`).** The argv-validated wrapper
  `infra/freebsd/bin/grappa-source-alias` is installed onto sudo's
  `secure_path` (`/usr/local/sbin/grappa-source-alias`, `root:wheel`,
  mode `0555`) by `infra/freebsd/jail_install_source_alias.sh`, which
  **every deploy runs on both the hot and the cold path** (#646 — it used
  to run on cold only, and shipping #610 left the pre-#610 wrapper
  installed: `probe` exited 64, mode 2 disarmed, 44 visitors rejected).
  The one step still done by hand, once per jail, is the NOPASSWD grant:

  ```
  # /usr/local/etc/sudoers.d/grappa-source-alias
  grappa ALL=(root) NOPASSWD: /usr/local/sbin/grappa-source-alias
  ```

  The wrapper — not a bare `sudo ifconfig` — is the privilege boundary:
  it hard-codes `lo0` + `/128` and refuses any address outside the
  configured prefix. **The prefix is NOT compiled in (#609).** The wrapper
  reads it from a ROOT-OWNED config file it FAILS CLOSED without:

  ```
  # /usr/local/etc/grappa/source-alias.conf   root:wheel, 0444
  PREFIX=2001:db8:1:2:cafe::/80
  ```

  `jail_install_source_alias.sh` renders this file from
  `ServerSettings.static_mapping_prefix` in the SAME step that installs the
  wrapper, so the DB prefix and the wrapper's scope cannot drift by hand.
  The file is AUTO-GENERATED: a hand edit survives only until the next
  deploy re-renders it from the DB.

  **Changing the prefix is therefore not a pure admin-UI operation.**
  `PUT /admin/settings` probes BEFORE it persists (`arm_if_static/2` runs
  ahead of `persist_addressing_prefix/1`), and the probe's canary is derived
  from the prefix in the BODY while the wrapper still reads the old scope —
  so the PUT refuses with 422 `addressing_unusable` (`:prefix_mismatch`) and
  writes nothing, which leaves the installer nothing new to render. Break
  the cycle from the substrate side: write the row with
  `infra/freebsd/jail_db_write.sh`, re-run
  `jail_install_source_alias.sh` (or deploy), then use the UI. That drift
  is the #609 prod
  incident (the wrapper still pinned `…:2d3:cb::/80` — a prefix the host does
  not route, confirmed 2026-08-05 against `/etc/rc.conf` — while the intended
  block was the routed `…:2d3:cafe::/80`, so every acquire failed exit 65 and
  sessions stayed held). A missing / unreadable / malformed file makes the
  wrapper exit 66 (fail closed), never a wildcard fallback.

  **Do NOT `env_keep GRAPPA_SOURCE_ALIAS_PREFIX` through sudoers.** The prefix
  is the wrapper's privilege SCOPE; env-keeping it hands that scope to the
  (untrusted) grappa caller, so a compromised BEAM could set
  `GRAPPA_SOURCE_ALIAS_PREFIX=::/0` and `sudo` an alias for ANY address —
  including the trusted `::ca` block — defeating the accountable-vs-untrusted
  egress separation this feature enforces. `sudo` scrubs the env by default, so
  from the grappa caller only the config file applies; the env override exists
  ONLY for a root-invoked / test call. Keep it that way.

  **A VNET jail is REQUIRED.** `arm_check` no longer trusts a no-op grant probe
  — it drives `sudo -n grappa-source-alias probe <canary>`, which adds then
  deletes a canary address (the prefix's network base) to prove the substrate
  can actually alias. A NON-VNET jail (shared host network stack, `ip6.addr`
  pinned by the host) refuses `ifconfig ... alias` with EPERM, so mode 2
  disarms with `:alias_not_permitted` instead of arming and then failing every
  acquire. Give the jail its own VNET (`vnet` + an `epair`/interface in the
  bastille/jail config) before enabling mode 2. Other disarm reasons:
  `:wrapper_unavailable` (missing wrapper/grant), `:prefix_mismatch` (the
  config-file prefix differs from the DB prefix — the canary is derived from
  the DB prefix, so the wrapper refuses it), `:prefix_config_unavailable`
  (missing/malformed config file).

  These same probes run at settings-SET time: `PUT /admin/settings` selecting
  mode 2 — or changing the prefix while mode 2 is active — runs the probe FIRST
  and, on failure, returns **422 `addressing_unusable`** with the specific
  reason and persists NOTHING, so an operator learns in the curl/UI response
  rather than later from held sessions.
- **Native Linux (`GRAPPA_SUBSTRATE=linux`).** No per-address alias —
  an AnyIP local route makes the whole block bindable at once. Provision
  BOTH (persist in your netplan/rc): `sysctl -w
  net.ipv6.ip_nonlocal_bind=1` and `ip -6 route add local
  2001:db8:1:2:cafe::/80 dev lo`. `arm_check` verifies both; a missing
  route disarms with `:anyip_route_missing`, a disabled sysctl with
  `:ip_nonlocal_bind_disabled`.
- **Boot reconcile.** At startup (after the HTTP surface is up, before
  Bootstrap spawns sessions) the `SourceAliasManager` sweeps orphan
  aliases a crashed prior run left bound (`ifconfig lo0` on FreeBSD;
  no-op on Linux/AnyIP), so a hard crash does not leak `/128` aliases.
- **Renumbering (changing the prefix) with LIVE mode-2 sessions leaks the
  old aliases.** A successful `PUT /admin/settings` prefix change takes effect
  at runtime (#609), but sessions already bound to the OLD prefix keep those
  `/128` aliases (correct — an in-use source must not be removed), and neither
  a later release nor the reconcile sweep (both scoped to the NEW prefix) can
  reclaim them, so the old `lo0` aliases linger until a manual `ifconfig lo0
  inet6 <old-addr>/128 -alias`. To renumber cleanly, disconnect mode-2 sessions
  first (or accept the manual cleanup). A full live-renumber is not supported.

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

**Admin login brute-force coverage (S6, 2026-07-09).** The `http-400`
jail's filter is extended via an upgrade-safe
`filter.d/nginx-bad-request.local` carrying **three** `failregex`
lines (all share the jail's `maxretry 8` / `findtime 600s`): the
original malformed-request `… "[^"]*" 400`, plus
`… "POST /auth/login[^"]*" 401` (admin credential brute-force — the
app returns a clean 401 on a bad login, so this is edge-side only,
zero BEAM change) and `… "[^"]*" 403` (host-wide 403 accretion —
catches scanners probing `/admin`, leakix, etc.). Reload with
`fail2ban-client reload http-400`; validate every line with
`fail2ban-regex` on the live `irc.openssl.it-access.log` BEFORE reload.
**NEVER broaden this filter to an all-endpoint `401` match.** The
shared `http-400` jail tails **all ~50 vhost access logs** and the
`main` log format has **no vhost field**, so an all-401 rule cannot
scope to grappa — it would ban legit HTTP basic-auth challenge 401s on
`mon.openssl.it` (9000+/day) and `rspam.openssl.it` (~2000/day) after
8 page loads, self-DoSing the operator. If grappa ever needs
"any 401 on grappa" banning, stand up a **dedicated** jail tailing
only `irc.openssl.it-access.log`, never touch the shared filter.

## Emergency DB rollback (cold + irreversible migrations)

Some migrations are **irreversible** — a native `DROP COLUMN` (e.g. #211
phase 7 `20260712130000_drop_visitor_scalar_identity_columns`) destroys
data that `ecto.rollback` cannot reconstruct. That migration's `down/0`
re-adds the columns NULLable and best-effort restores nick/ident/realname
from each visitor's representative credential, but `password_encrypted`
comes back NULL and the pre-drop row values are gone. **`ecto.rollback`
is NOT a recovery path for an irreversible migration — the recovery path
is restore-from-backup.** Rehearse this BEFORE deploying any such
migration; the backup + dry-run gate below is mandatory for the cold
window.

### Pre-deploy gate (do NOT cold-deploy an irreversible migration without these)

1. **Fresh backup.** Take a consistent sqlite `.backup` of the live prod
   DB (a `cp` of a WAL-mode DB under a live writer is NOT consistent):
   ```sh
   ssh root@m42 "jexec grappa su -l grappa -c \
     'sqlite3 /home/grappa/grappa/runtime/grappa_prod.db \
        \".backup /home/grappa/grappa/runtime/grappa_prod.db.predeploy-$(date -u +%Y%m%d-%H%M%S)\"'"
   ```
   Keep the path — it is the rollback source. (`GRAPPA_ENCRYPTION_KEY`
   is NOT in the DB; a restored DB needs the SAME key still set in
   `grappa.env`, per `feedback_cloak_key_required_for_db_portability`.)
2. **Dry-run the migration against an ISOLATED copy of that backup**
   (never the shared dev/test DB — a stray `DROP COLUMN` there poisons
   every checkout). Copy the backup to a scratch dir OUTSIDE any repo
   tree, run `MIX_ENV=prod DATABASE_PATH=<copy> mix ecto.migrate` in a
   one-shot container with dummy prod env vars, and verify: all
   migrations exit-0, `PRAGMA integrity_check` = ok, retained-table row
   counts unchanged, the irreversible step's post-schema is as intended,
   `PRAGMA foreign_key_check` introduces **no new** violations vs the
   pre-migrate copy (pre-existing historical orphans are fine — compare
   counts), NickServ ciphertext is byte-identical (raw copy, not
   re-encrypted), and a **second** run on a fresh copy is deterministic +
   `ecto.migrate` re-run is a no-op (idempotent). Baseline captured
   2026-07-12 for the phase-7 dry-run: `messages=243417 visitors=27
   network_credentials=1→28 (1 user + 27 backfilled) networks=2 users=1`.

### Rollback procedure (if a cold deploy goes wrong)

The rollback for an irreversible migration is **restore the pre-deploy
backup**, NOT `ecto.rollback`. It reuses the existing swap rail
`infra/freebsd/jail_import_db.sh` (refuses while the service is alive,
backs up the current DB, removes WAL/shm sidecars FIRST — the corruption
trap per `feedback_sqlite_wal_import_rules` — installs atomically,
integrity-checks). It is fast (~30s: stop BEAM, swap the file, start).

```sh
# 1. STOP the live node (blocks until the BEAM exits + epmd releases the
#    name — grappa_stop is synchronous since defect #9, 2026-06-11).
ssh root@m42 "sudo bastille cmd grappa service grappa stop"

# 2. Stage the pre-deploy backup at the rail's expected jail-side path.
#    (Both files are already inside the jail root — this is an in-jail cp.)
ssh root@m42 "sudo cp \
  /usr/local/bastille/jails/grappa/root/home/grappa/grappa/runtime/grappa_prod.db.predeploy-<STAMP> \
  /usr/local/bastille/jails/grappa/root/tmp/grappa_prod.db"

# 3. Import — the rail backs up the (migrated) current DB, rm's WAL/shm,
#    installs the backup, and prints integrity_check + schema_migrations
#    head (MUST read the PRE-deploy version, e.g. 20260709120100 for the
#    phase-7 rollback — proof the DROP-COLUMN migrations are gone).
ssh root@m42 "sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/jail_import_db.sh"

# 4. Roll the CODE back too — a restored pre-migration DB under
#    post-migration code reads dropped columns and crashes. Deploy the
#    last-known-good SHA: the ACTUAL pre-phase-7 prod tip was 3b6c95c3
#    (`fix(#210)`), verified live at deploy time as the jail's HEAD +
#    runtime/last-deployed-sha — NOT 9758397 (deploy #100, an earlier
#    base that predates #210 and other landed fixes; rolling there would
#    silently drop that code). There are 0 migrations between 9758397 and
#    3b6c95c3, so both run the pre-phase-7 schema, but 3b6c95c3 is the
#    correct code tip. From a checkout at that SHA:
scripts/deploy-m42.sh --force-cold

# 5. START + verify.
ssh root@m42 "sudo bastille cmd grappa service grappa start"
ssh m42 "sudo bastille cmd grappa curl -fsS http://127.0.0.1:4000/healthz"
# Confirm the restored baseline (phase-7 example):
ssh root@m42 "jexec grappa su -l grappa -c \
  'sqlite3 /home/grappa/grappa/runtime/grappa_prod.db \
     \"SELECT (SELECT COUNT(*) FROM messages), (SELECT COUNT(*) FROM visitors), (SELECT COUNT(*) FROM users);\"'"
# expect: the row counts of WHICHEVER backup you restored — match them
#   against that backup file BEFORE starting (counts drift as prod runs;
#   the phase-7 deploy took a fresh predeploy-20260712-153204 backup at
#   242545|26|1, distinct from the earlier 13:53 dry-run baseline of
#   243417|27|1 — always verify against the specific backup you swapped in).
```

**Sequencing note.** Steps 3 (DB) and 4 (code) MUST both happen — a
restored pre-migration DB under new code (or a new DB under old code) is
a mismatched pair. If you rolled the DB back, you MUST roll the code to
the matching pre-migration SHA and cold-deploy it before starting. The
`schema_migrations` head printed in step 3 is the authoritative check
that the DB and the target code SHA agree on the migration set.

## CSP / security headers (BEAM-emitted, NOT nginx — #485)

The Content-Security-Policy + sibling security headers
(`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
`Permissions-Policy`) are emitted by the **BEAM**, from
**`GrappaWeb.Plugs.SecurityHeaders`** — the single source of truth.
The CSP string is the `csp/0` accessor; the plug registers via
`register_before_send/2` so the headers land on `Plug.Static` hits
(SPA shell + assets) and error pages alike. Before #485 these lived in
an nginx snippet (`infra/snippets/security-headers.conf`, now deleted);
they moved into the app so EVERY substrate — the Docker single
container, the m42 jail behind its dumb proxy, an operator's own TLS
front door — carries the same headers with no per-substrate config.

**nginx MUST NOT re-assert them.** Every nginx substrate is a dumb
reverse proxy now (`infra/snippets/locations-api.conf`,
`location / → BEAM`); it emits none of these headers. If a proxy also
sends a `Content-Security-Policy`, the browser enforces the
**intersection** of all policies (not the union) — a prod-only footgun
that silently tightens the CSP and breaks the widgets it drops. Confirm
the BEAM emits them and nginx doesn't double them:
`curl -sD - http://127.0.0.1:4000/ -o /dev/null` inside the jail shows
exactly ONE `content-security-policy` line; through the public host it
must still show exactly one, byte-identical. Prod hosts:
**`irc.sniffo.org` / `irc.sindro.me`** (`irc.openssl.it` is the host
vhost name + redirect).

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

**Deploying a CSP change** — the CSP now lives in `SecurityHeaders`, so
editing it is a **code change** (a plain plug — `deploy-m42.sh`'s
auto-classifier treats it as HOT, and the running-module swap does update
the header). Still, PREFER a COLD deploy for any security-header change
and verify the live value explicitly — a wrong or intersection-narrowed
CSP is a security regression, not a cosmetic one. No nginx reload needed.
(This is the routine case; the one-time #485 cutover below is COLD because
`jail_install_nginx.sh` must run alongside the release.) Verify the live
header:

```sh
ssh m42 "curl -fsSL -D - -o /dev/null https://irc.sniffo.org/ 2>&1 | grep -i content-security-policy"
```

### m42: the #485 cutover is ONE coordinated COLD deploy

The move off the two-container topology on the jail is a single COLD
deploy that lands TWO changes at once, and they MUST land together:

1. the **release** (ships `SecurityHeaders`, so the BEAM starts emitting
   the CSP), and
2. a re-run of **`infra/freebsd/jail_install_nginx.sh`** (installs the
   dumb-proxy `nginx.conf` that no longer includes the header snippet).

If (1) lands without (2), prod **double-emits** the CSP (old nginx
snippet + new plug) and the browser enforces the intersection = an
incident. If (2) lands without (1), there's a **zero-header window**
(nginx stopped adding them, the BEAM isn't emitting them yet). Deploy
both in the same COLD window, then verify **exactly ONE** of each header
and that the CSP is byte-identical to the pre-#485 value:

```sh
ssh m42 "curl -fsSL -D - -o /dev/null https://irc.sindro.me/ 2>&1 \
  | grep -iE 'content-security-policy|x-frame-options|x-content-type|referrer-policy|permissions-policy'"
```

## Per-host compose overrides

Committed `compose.yaml` ships deployment-agnostic defaults: grappa
publishes on `${GRAPPA_PUBLISH:-127.0.0.1:4000}` (loopback only);
`--profile prod` adds only the `cicchetto-build` oneshot (#485 dropped
the in-stack nginx — the BEAM self-serves the SPA + owns its headers).
Anyone can clone + `docker compose up`; nothing depends on a particular
LAN, hostname, or vlan.

Personal bindings (LAN/VLAN IP for inbound, `PHX_HOST`,
`EXTRA_CHECK_ORIGINS`) live in gitignored `compose.override.yaml` —
template at `compose.override.yaml.example` covers the dev + prod
"bind-grappa-to-LAN-with-PHX_HOST" shapes (both bind `grappa` directly
now; there is no nginx service to bind). `scripts/_lib.sh` auto-detects
it and appends as a second `-f` flag. Use `ports: !override` to
drop+replace the base file's publish (NOT `!reset`, which drops without
re-adding), or just set `GRAPPA_PUBLISH` in `.env`.

When proposing a new IP-bound or hostname-pinned binding, put it in
the override, NEVER in the committed base. The CSP is host-agnostic —
`'self'` covers same-origin ws/wss automatically, so
`GrappaWeb.Plugs.SecurityHeaders` needs no per-host edit; don't
hardcode hostnames in it.

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
  `_build/.../tmp/log/`). On the Linux/systemd substrate, `bin/grappa
  start` runs in the foreground (no `run_erl`), so logs go to
  `journalctl -u grappa` instead — no `runtime/log/` file story there.
- **Config**: DB-driven (Phase 2 sub-task 2j replaced the TOML loader).
  Operator binds users + networks via mix tasks: `mix grappa.create_user`
  creates a `User` row, `mix grappa.bind_network --auth ...` writes a
  `Networks.Credential` (with encrypted SASL/NickServ passwords via
  Cloak.Vault). `Grappa.Bootstrap` reads every credential at boot via
  `Networks.list_credentials_for_all_users/0` and spawns one
  `Session.Server` per row. Adding a binding requires no config edit —
  next reboot picks it up.
  **Safe to run against a live host without stopping the service**
  (2026-07-23): every `grappa.*` operator mix task boots via
  `Mix.Tasks.Grappa.Boot.start_app_silent/0`, which suppresses both
  `Grappa.Bootstrap` (no upstream IRC connections) and
  `GrappaWeb.Endpoint` (no HTTP port bind) — so it no longer conflicts
  with an already-running release on the same port. Before this fix
  every admin task required `systemctl stop grappa` first.
- **`--services-flavor` (GH #349)**: optional at bind (or later via
  `PATCH /admin/networks/:slug {services_flavor: …}` / the admin Networks
  tab). Declares which services suite the network runs
  (`azzurra | atheme | oftc | unknown`, nullable). Only `azzurra` currently
  enables cicchetto's in-app "📝 Register nick" wizard — grappa's only
  registration-success signal is the lowercase `+r` umode, which only
  bahamut/Azzurra services emit (atheme has no registered umode, oftc uses
  uppercase `+R`; those flavors hide the button pending #388). Set it on
  Azzurra binds so users can self-register; leave it unset/`unknown`
  elsewhere. When a wizard registration completes (services set `+r`), the
  REGISTER password is committed to the credential and its `auth_method`
  flips to `:nickserv_identify` automatically, so the registered nick
  auto-identifies on the next reconnect.

## Monitoring

- **Health**: `scripts/healthcheck.sh` (curl `/healthz`) — dev. Prod
  (m42 jail): `ssh m42 "sudo bastille cmd grappa curl -fsS http://127.0.0.1:4000/healthz"`.
  Prod (Linux/systemd host): `curl -fsS http://127.0.0.1:4000/healthz`
  directly (no ssh-and-exec indirection needed), or
  `systemctl status grappa` + `journalctl -u grappa -f`.
- **Logs**: `scripts/monitor.sh` (docker compose logs -f) — dev. Prod:
  tail `runtime/log/erlang.log.*` inside the jail (see Runtime Data).
- **Runtime introspection**: `scripts/observer.sh` (observer_cli — see
  every supervised process, mailbox depth, memory).
- **Phoenix.LiveDashboard** mounted at `/admin` (dev only by default;
  Phase 5 hardening adds prod with auth).
- **Telemetry**: events emitted via `:telemetry`; metrics aggregated
  via `Telemetry.Metrics`. Phase 5 adds Prometheus exporter.
- **Session GC (#223)**: `Grappa.Accounts.Reaper` sweeps every 60s and
  physically deletes USER `sessions` rows idle past the 7-day auth
  window (the same TTL `authenticate/1` gates on — a swept row was
  already un-authenticatable). A productive sweep logs
  `expired sessions reaped affected=N`; an idle sweep is silent. No
  operator verb — the sweep is autonomous and needs none (unlike
  `reap-visitors`, session GC has nothing operator-actionable). Visitor
  sessions are NOT swept here — they CASCADE from the visitor row via
  `Visitors.Reaper`.

### Write-latency diagnostics (#357 — SQLite write-latency telemetry)

The "sending feels slow on busier channels" symptom is a **write-path**
problem, not a member-count one. #357 Deliverable 1 instruments it so the
mechanism is provable before any fix (Deliverable 2, deferred). Four signals,
mapped to the three mechanisms the issue traced:

- **`[:grappa, :scrollback, :persist, :start | :stop]`** — a `:telemetry.span`
  around every `messages` insert+preload, **tagged by `channel`** (also
  `kind`, `network_id`, `subject`, and `outcome`). `:stop` `duration` is the
  **pure insert** time (mechanism 3: index write-amplification grows it as the
  table grows). Correlate a channel's `:stop` durations against its inbound
  msg/s to confirm latency tracks **rate**, not member count.
- **`[:grappa, :session, :send_privmsg, :start | :stop]`** — a span around the
  outbound-send `GenServer.call` round-trip. Because it runs in the caller and
  the call blocks until reply, `:stop` `duration` is the **total** send latency
  **including mailbox queue-wait**. **`send_privmsg duration − persist
  duration` = head-of-line blocking (mechanism 1)** — the user's own send
  queued behind a busy channel's synchronous inbound inserts.
- **`[:grappa, :scrollback, :persist, :contention]`** — fires per transient
  SQLite write-contention fault in `with_pool_retry/3` (mechanism 2:
  single-writer contention). Metadata `fault: :queue_timeout | :busy_locked`,
  `dropped: false` (ridden out) / `true` (budget exhausted, row lost — the
  telemetry twin of the `scrollback persist unavailable: SQLite pool
  saturated` `Logger.warning`).
- **Mailbox depth (mechanism 1, direct)** — a rising mailbox on the *sender's
  own* session during a busy-channel burst proves the head-of-line blocking
  outright. No new surface — sample the already-shipped ones:
  - HTTP: `GET /admin/sessions` → each row's `live_state.mailbox_len` (+
    `memory_bytes`). Admin-authn'd; poll it during a burst.
  - CLI: `bin/grappa list-sessions` (the `mailbox` column).
  - High-frequency: `bin/grappa remote-shell --batch -e` a
    `Process.info(pid, :message_queue_len)` loop against the target session
    pid (from `list-sessions`).

**Which upstream server did a session land on? (netsplit triage, #550)** —
`GET /admin/sessions` carries, per row, `live_state.peer_address` +
`live_state.peer_port` (the destination the IRC socket actually connected to
— the round-robin DNS name, e.g. `azzurra.chat`, says nothing about where a
session ended up) plus `live_state.peer_name` (its reverse-DNS, resolved out
of band via `Grappa.Net.PtrCache`, #252 — never a blocking lookup on the
request path). During a netsplit, group the inventory by `peer_address`:
every session sharing the split-off server's address (e.g.
`2a01:4f8:201:2281:11::22` → `allnight6.azzurra.chat`) is a bounce candidate,
the rest are left alone — the question that used to need an `rpc` into the
live BEAM. A not-connected session (pre-connect, mid-reconnect, socket just
closed) shows `peer_address: null` + `:peer_address` in
`introspection_degraded` — never a stale address. cic renders this as the
**upstream** column (reverse name first, raw `address:port` alongside; the
reverse name is untrusted text for third-party networks). The reverse-DNS is
resolved lazily, so the first scan after a fresh connect may show the raw
address until the cache warms.

**The consumer ships in code (#357 D1-completion, 2026-07-26).** The D1 spans
originally emitted into the void ("no handler by default" — the Phase-5 PromEx
exporter is the eventual consumer), so sampling meant hand-attaching a forwarder
over `rpc` that every restart wiped. That is now a **permanent, boot-attached,
restart-surviving** handler: the supervised singleton `Grappa.DbLatency`. No
hand-attach — read it through either door (both drive the same
`Grappa.DbLatency.snapshot/0` + `reset/0`):

- **CLI:** `bin/grappa db-latency` (the aggregate as tab-separated tables) /
  `bin/grappa db-latency-reset` (zero the counters).
- **HTTP:** `GET /admin/db_latency` (JSON) / `POST /admin/db_latency/reset`
  (`204`). `:admin_authn`-gated (admin bearer + `is_admin`); reached
  through the dumb proxy, no allowlist to maintain (#485).

The handler folds **two** signal families:

- **`[:grappa, :repo, :query]`** (Ecto's per-query telemetry) into a
  `{source, op}` table — `SELECT count(...)` split from plain `SELECT`. This is
  the table that answers the **FIX-B / #395 gate** ("is the badge /
  `count_after_split` path still a top DB-time consumer?"). Reads dominate DB
  time, so this — not the write spans alone — is the measurement to compare
  against the baseline.
- **the D1 write-path spans** into `send_privmsg` / `persist` / `contention`
  rows.

**Taking a 25s under-load sample:** `bin/grappa db-latency-reset` → wait 25s
**under genuine daytime load** → `bin/grappa db-latency`. Counters are
cumulative-since-reset. An idle sample returns a green number that proves
nothing (the retracted "3.7x" figure); **compare line-by-line against the
baseline table, never a summary number**:

| total | n | mean | what |
|-------|---|------|------|
| 9809ms | 24 | 409ms | scrollback `SELECT` |
| 3925ms | 36 | 109ms | `INSERT`s |
| 2589ms | 6 | 432ms | `count_after_split` (fold predicate) |

(baseline: 19120ms of DB time in 25s, `queue_time` 1121ms — under real load,
2026-07-26.)

**Reading the three write-path mechanisms apart** (the deferred "busier channel
= slower send" investigation — do NOT conclude from an idle sample):

- **mechanism 1 (mailbox head-of-line):** `send_privmsg` `mean_ms` −
  `persist` `mean_ms`. A large gap = the sender's own `handle_call` queued
  behind a busy channel's synchronous inbound inserts.
- **mechanism 2 (single-writer contention):** the `contention` row —
  `queue_timeout` / `busy_locked` counts + `dropped`.
- **mechanism 3 (pure insert / index write-amplification):** the `persist`
  row `mean_ms`, watched as the table grows.

WAL/lock corroboration (mechanism 2, out-of-band): grep prod logs for the
`SQLite pool saturated` warning and busy/locked `%Exqlite.Error{}` lines during
the burst; watch WAL checkpoint pressure via the `runtime/*.db-wal` file size
(a large, slow-shrinking `-wal` = checkpoints falling behind the write rate).

## Pending operator follow-ups

Dated, operator-actioned items (not engineering work — migrated here from
the retired `docs/todo.md`). Check the condition, then act or drop.

- **Drop m42 fail2ban `/read-cursor` 400-exemption** (post-#44). The cic
  positive-int guard landed + deployed (cp58, bundle `BF6Dside`). Once
  prod access logs show `/read-cursor` 400s at zero (all clients on the
  new bundle), drop the CP55 `http-400` jail exemption for `/read-cursor\b`
  on m42. Log: `irc.openssl.it-access.log`. Recheck ≥2026-06-16 (a
  stale-bundle PWA bursts ~31×400 vs maxretry 8 → would ban a legit user).
- **Revisit m42 fail2ban `$home/messages` 404-exemption** (post-#81). The
  client fix (`kindHasScrollback` gate) landed + deployed hot 2026-06-26
  (bundle `Cra1LwMd`). The `ignoreregex` for
  `networks/<n>/channels/%24<x>/messages` is retained as defence-in-depth.
  Once prod logs show `%24home`/`%24admin`/`//messages` 404s at zero,
  DECIDE: keep (defence-in-depth) or drop (a permanent exemption masks the
  next synthetic-window regression). Recheck ≥2026-07-03.
- **Captcha-enabled-on-prod discrepancy** (2026-06-08, CP55). Prod
  `grappa.env` has NO `GRAPPA_CAPTCHA_*` → provider should be `disabled` →
  no widget. Yet vjt saw the captcha widget (+ its CSP inline-script block)
  on prod. Confirm where the provider is actually switched on, or whether
  it was stale client state. The CSP fix (sha256 in script-src, CP55) is
  correct regardless.
- **Sqlite "Database busy" intermittent test flake.** `Repo` / `Scrollback`
  / `Wire` occasionally fail inserts with `Exqlite.Error: Database busy` —
  contention between `async: true` Repo writes and the live dev container
  also writing `runtime/grappa_dev.db`. Benign noise during `ci.check`; not
  flaky on CI (fresh DB). No action unless it worsens.
# Passkeys and account recovery

Each Grappa instance is a separate WebAuthn relying party. A passkey enrolled
for one hostname cannot authenticate against another hostname. Changing the
public hostname invalidates existing passkeys because WebAuthn binds them to
the RP ID and origin.

Passwordless mode accepts a passkey or one-shot account recovery code. It does
not accept the account password or TOTP, and shottino cannot complete WebAuthn.
If a user loses both passkey and recovery codes, restore password login from the
instance host:

```sh
scripts/mix.sh grappa.reset_passkeys --user ACCOUNT_NAME
```

The reset removes every passkey and recovery code and revokes all live sessions.
It does not remove TOTP; an account with TOTP enabled returns to password plus
TOTP login.
