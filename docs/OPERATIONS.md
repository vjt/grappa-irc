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

## Contents

- [Operator dispatcher — `bin/grappa`](#operator-dispatcher--bingrappa)
- [Developer and deploy scripts (scripts/*.sh)](#developer-and-deploy-scripts-scriptssh)
- [Hot vs cold deploy — when each path triggers](#hot-vs-cold-deploy--when-each-path-triggers)
- [Emergency DB rollback (cold + irreversible migrations)](#emergency-db-rollback-cold--irreversible-migrations)
- [Letting a locked-out visitor back in (#982)](#letting-a-locked-out-visitor-back-in-982)
- [CSP / security headers (BEAM-emitted, NOT nginx — #485)](#csp--security-headers-beam-emitted-not-nginx--485)
- [The Docker compose stack (compose.yaml)](#the-docker-compose-stack-composeyaml)
- [The two images: Dockerfile (toolchain) vs Dockerfile.release](#the-two-images-dockerfile-toolchain-vs-dockerfilerelease)
- [The Docker deploy driver (infra/docker/)](#the-docker-deploy-driver-infradocker)
- [The shared deploy library (infra/lib/)](#the-shared-deploy-library-infralib)
- [The FreeBSD jail rails (infra/freebsd/)](#the-freebsd-jail-rails-infrafreebsd)
- [Native Linux and the cloud one-click box (infra/linux/, infra/cloud/)](#native-linux-and-the-cloud-one-click-box-infralinux-infracloud)
- [Packaging (infra/packaging/)](#packaging-infrapackaging)
- [Per-host compose overrides](#per-host-compose-overrides)
- [The shottino --ircd bridge as a compose service (#1027)](#the-shottino---ircd-bridge-as-a-compose-service-1027)
- [Runtime Data](#runtime-data)
- [Monitoring](#monitoring)
- [Pending operator follow-ups](#pending-operator-follow-ups)
- [Passkeys and account recovery](#passkeys-and-account-recovery)

## Operator dispatcher — `bin/grappa`

`bin/grappa` is the host-side operator interface. One verb per task,
boot-time mix tasks + live-state remsh verbs co-located under one
banner. Always invoke from the repo root (or any worktree dir) — the
dispatcher cd's to the main repo for docker compose and forwards
worktree volumes via oneshot bindings (same machinery as
`scripts/*.sh`).

**Where the flag table lives: `bin/grappa <verb> --help`** (or
`bin/grappa help <verb>`, or `-h` — anywhere in the args). Every verb
answers inline, needing neither a running container nor docker at all,
so it works exactly when you reach for it: mid-incident, on a cold host,
before the first build. That is the ONE authoritative flag list per
verb — for the boot verbs it is gated against the mix task's
`@switches`, both directions, by
`test/mix/tasks/grappa/operator_help_drift_test.exs`. This runbook
deliberately no longer repeats it (#1086): the copy it used to carry had
already drifted, advertising an `--host`/`--port` pair `add-server`
never had and omitting `bind-network`'s required `--server`, so anyone
following the runbook hit the very crash #1086 was filed for.

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
bin/grappa <verb> --help         # same, as a flag (or -h) — anywhere in the args

# Boot-time verbs (mix tasks; auto-detect MIX_ENV from container).
# Flags: `bin/grappa <verb> --help` — see the note above.
bin/grappa create-user               # create a Grappa user account
bin/grappa bind-network              # bind a (user, network) credential
bin/grappa add-server                # add a server entry to a network
bin/grappa remove-server             # remove a server entry from a network
bin/grappa set-network-caps          # set / clear per-network admission caps
bin/grappa unbind-network            # remove a (user, network) credential
bin/grappa update-network-credential # edit autojoin / nick / SASL fields
bin/grappa seed-scrollback           # seed dev + e2e scrollback
bin/grappa gen-encryption-key        # generate a Cloak.Vault key
bin/grappa gen-vapid                 # generate a VAPID keypair (push)

# Live-state verbs (--rpc-eval against the live BEAM via T-2 dist shell):
bin/grappa delete-visitor <uuid>     # sync terminate + Repo.delete; frees cap slot
bin/grappa reset-totp <account>      # disarm TOTP, revoke bearers, close its sockets
bin/grappa reset-passkeys <account>  # drop passkeys, revoke bearers, close its sockets
bin/grappa reap-visitors             # force-run Visitors.Reaper.sweep (otherwise 60s tick)
bin/grappa list-sessions             # tab-separated: subject, network_id, pid, mailbox, memory
bin/grappa list-credentials          # tab-separated: user, network, nick, state (ALL states)
bin/grappa list-visitors             # tab-separated: id, nick, network, expires_at, identified
bin/grappa db-latency                # #357 SQLite write/query-latency aggregate
bin/grappa db-latency-reset          # zero the counters, opening a fresh window

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

### The account door on a PACKAGED release (#1158)

Everything above is the SOURCE flavor: `bin/grappa` in a checkout is a
host-side dispatcher whose boot verbs shell out to mix tasks. A packaged
release ships no mix and no checkout, so on the published Docker image,
the bastille jail, the systemd host and the `.deb`/AUR install those
verbs do not exist — the file called `bin/grappa` there is a different
program.

That program now carries the account verbs itself
(`infra/release/grappa.sh`, installed over the generated boot script by
the `install_operator_cli/1` release step, which moves the generated one
to `bin/grappa-release`):

```
grappa create-user NAME [--admin] [--password PW]
grappa add-network USER NETWORK --server HOST:PORT --nick NICK --auth METHOD [...]
grappa remove-network USER NETWORK
grappa help                          # the account verbs' flags
```

Reached identically from every door — `docker run <image> create-user
vjt --admin`, `docker exec <ctr> bin/grappa create-user vjt`, `sudo
grappa create-user vjt` on a packaged host, and the release path
directly in the jail. No running node is required: the verb loads the
app, starts the vault and opens the database itself, which is what makes
it the FIRST-run door. Without `--password` the password is read from
the terminal rather than argv, so it stays out of shell history and the
process table.

The flags are the mix tasks' flags, spelled the same and gated against
them by `test/grappa/release/cli_flag_parity_test.exs`; the entities are
positional (`add-network vjt azzurra`) rather than `--user`/`--network`.
Underneath, all three call the same context functions the mix tasks and
the `/admin` REST surface call — `Grappa.Networks.add_network/3` is the
composition that creates the network + server when needed and REFUSES to
write access to a network with no enabled server, because a credential
alone is not a connectable account.

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

## Developer and deploy scripts (scripts/*.sh)

Sibling layer to `bin/grappa` for inner-loop development: gates,
container plumbing, ad-hoc shells. `bin/grappa` doesn't try to absorb
these — they're a different audience (developer iterating inside a
worktree vs. operator running against the live container).

**Always use relative paths from the repo root** (`/srv/grappa` for
main, or the worktree dir like `~/code/IRC/grappa-task2/`). Never
`cd /srv/grappa &&`, never absolute `/srv/grappa/scripts/foo.sh`. The
scripts are worktree-aware: they detect the worktree, cd to the MAIN
repo for docker compose (so the project name, the image, and the MAIN
repo's `./:/app` bind mount — which carries `_build`, `deps`, `.mix`,
`.hex` and the PLT cache — are shared across all worktrees) and
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

<!--
  #1159 — prose to APPEND to docs/OPERATIONS.md, inside the section being
  renamed to `## Developer and deploy scripts (scripts/*.sh)`.
  Starts at ### level: the `##` heading is NOT emitted here.
  Append AFTER the existing "Bash 4+ required." paragraph.
-->

### `scripts/_lib.sh` — the shared prelude every script sources

**Sourcing `_lib.sh` also imposes `set -euo pipefail` on the caller.**
The library sets it at source time, so a script that carries no `set`
line of its own (`scripts/release-image.sh`, for one) still runs under
errexit. Several of the traps below only make sense against that fact:
a bare `rm` that hits `Permission denied`, or a `docker compose` that
exits non-zero, does not merely warn — it aborts the whole script at
that line. When adding a command whose failure is acceptable, say so
explicitly with `|| true`; when adding one whose failure is not,
nothing further is needed.

**Compose file selection: one committed file plus an optional personal
override, and the override is read from the MAIN repo.** `compose.yaml`
is unified (the CP23 collapse — dev is grappa-only, prod is gated by
`--profile prod` at the call site, NOT by a separate base file), and
the gitignored `compose.override.yaml` is appended to `COMPOSE_ARGS`
when present. Every script `cd`s to `$REPO_ROOT` before invoking docker
compose, so relative paths resolve against the main repo — and the
override is deliberately read from `REPO_ROOT`, never `SRC_ROOT`. The
override encodes the *host machine's* deployment binding (a LAN/VLAN
address, `$PHX_HOST`, a pinned `$GRAPPA_PUBLISH`), not the worktree's
source, and every worktree on a host shares that one binding. See
`compose.override.yaml.example`, and § "Per-host compose overrides".

**`compose.oneshot.yaml` must be layered LAST.** Its `ports: !reset []`
and `container_name: !reset null` overrides exist to drop the host-side
bindings inherited from the base file or the personal override; a
`-f` moved ahead of `"${COMPOSE_ARGS[@]}"` silently reinstates them,
and any oneshot started while a long-lived container holds the same
host port then dies with `Address already in use`. It is a
one-character-edit hazard. What the file itself contains is in § "The
Docker compose stack (`compose.yaml`)".

**Caches ride the MAIN repo's bind mount, not named volumes.** From a
worktree, docker compose still drives the main repo's compose project,
and `_build`, `deps`, `.mix`, `.hex`, `priv/plts` and `runtime/` all
live inside main's `./:/app` bind (the `grappa` service declares no
named volumes — the earlier named-volume shadowing was dropped). The
worktree's own sources are bind-mounted on top via `-v` overrides
during oneshot runs, so the container compiles worktree code against
main's warm artifact cache.

**Worktree source mounts are READ-WRITE; the root-level config files
are READ-ONLY.** `lib`, `test`, `config` and `priv/repo` mount RW
because Elixir 1.19's incremental compiler updates source-file mtimes
(`File.touch!`) for staleness tracking — an RO mount produces
`File.Error: read-only file system` on every recompile cycle that
touches a changed source, so "harden it to RO" breaks the inner loop
outright. Container UID matches the host UID via `CONTAINER_UID`, so
container-side writes land as the host user; there is no privilege
boundary being relaxed here. The config files (`mix.exs`, `mix.lock`,
`.formatter.exs`, `.credo.exs`, `.sobelow-conf`) stay RO because the
compiler never touches them — but `mix deps.get` *would* mutate
`mix.lock`, and RO is what stops a worktree oneshot from drifting the
lock away from what is checked in.

Two escape hatches exist for the cases where a write is the point:

```sh
WRITABLE_LOCK=1 scripts/mix.sh deps.get   # flips mix.lock to RW
WRITABLE_CIC=1  scripts/mix.sh grappa.gen_wire_types
```

`WRITABLE_LOCK=1` is for deliberately adding or bumping a dep from a
worktree branch — commit the resulting `mix.lock` on that branch and
merge it back the normal way. `WRITABLE_CIC=1` flips `cicchetto/src`
to RW so the wire-type codegen can write `wireTypes.ts` back to disk;
without it the task hits a read-only filesystem, and the default RO
mount is what protects cic source from accidental container-side
mutation during ordinary mix tasks.

### `GRAPPA_CACHE_ID` — opt-in per-worker build caches (#1263)

The shared cache above is why two people (or two agents) on one host
cannot run `mix` at the same time: one `_build`, two concurrent
compiles, and a red naming a file neither branch touched. Set
`GRAPPA_CACHE_ID` to buy isolation for one caller:

```sh
GRAPPA_CACHE_ID=w2 scripts/check.sh
```

`_build`, `deps` and `priv/plts` are then bound from
`.caches/<id>/` under the main repo instead of the shared tree, and
`MIX_TEST_PARTITION` is derived from the id and forwarded into the
container so the two runs cannot collide on one
`runtime/grappa_test.db` either. Set `MIX_TEST_PARTITION` explicitly
and it wins.

**Unset, nothing changes** — that is the point of the knob being
opt-in, and a bats suite pins it (`test/scripts/cache_id_isolation_test.bats`).

Three things to know before using it:

* **The first run on a new id is cold.** Nothing is seeded from the
  shared cache, deliberately: artefacts compiled from another
  worktree's source are the contamination this exists to end. Run
  `GRAPPA_CACHE_ID=<id> scripts/mix.sh deps.get` first, then expect a
  full compile and a dialyzer PLT build. Measured after a real cold
  `check.sh`: **113M per id** — `_build` 70M (dev + test; the shared
  tree is bigger because it also carries `prod`), `deps` 32M,
  `priv/plts` 11M.
* **It forces a oneshot container.** A running container cannot be
  remounted, so execing into the live one would silently hand back the
  shared cache. From a main checkout with the stack up, the knob
  therefore costs you the warm-exec path.
* **It does NOT isolate the docker stack.** Compose project name and
  host ports are still shared, so `scripts/integration.sh` and the e2e
  stack remain a single-occupancy resource. That is a separate issue.

**Every root-level file a drift-pin test READS needs its own `-v`
override, or a worktree can never prove a fix green before merge.**
Root-level files sit outside the directory mounts above, so a worktree
oneshot reads MAIN's copy through the base `./:/app` bind. That is
fatal for the tests that assert docs-match-reality:
`application_supervision_tree_test.exs` reads `CLAUDE.md` (#369 theme
8), `env_registry_drift_test.exs` reads `compose.yaml` + `.env.example`
to assert every `runtime.exs` `System.get_env` is propagated and
documented (#369 X1), and `operator_help_drift_test.exs` reads
`bin/grappa` to assert each boot verb's inline help names exactly its
mix task's `@switches` (#1086 — the gate first surfaced red against a
worktree whose help was in fact correct). All mount RO; tests only read
them. `VERSION` gets the same treatment for a different reason (#652):
it is the version SSOT, read at COMPILE time by `mix.exs` and
`lib/grappa/version.ex`, so a worktree oneshot without the override
compiles against main's number — or, if the file is missing, raises
`File.Error`. **Adding a new drift-pin test that reads a root-level
file means adding its `-v` override here in the same change.**

**`e2e_force_rm`, never a plain `rm`, for the e2e-ephemeral paths.** A
prior container run can leave `runtime/e2e/cicchetto-dist`,
`runtime/e2e/grappa-runtime` or the Playwright `test-results` tree
owned by uid 0 despite the `--user` drop (an entrypoint writing before
`su-exec`, or a run that predated `e2e_export_uid`). A plain `rm -rf`
then fails with `Permission denied`, and under the inherited `set -e`
that aborts the NEXT `testnet up` with the three symptoms operators
keep re-hitting: `cicchetto-dist` AccessDenied, sqlite
`database_open_failed`, and "Pool overlaps". `e2e_force_rm` tries a
plain `rm` first, then non-interactive `sudo` for whatever survives and
is root-owned, and never blocks — it warns and moves on, because the
next compose write surfaces the real error loudly anyway. This replaced
a manual `sudo rm -rf runtime/e2e/*` ritual that everybody forgot.

**`detect_mix_env` returns the empty string when nothing is up.**
Callers must not treat that as "dev"; `scripts/mix.sh` is the one place
allowed to apply a default, and it logs when it does (below).

### MIX_ENV policy lives in `scripts/mix.sh`, and nowhere else

**`scripts/mix.sh` is the policy layer; `_lib.sh` injects no MIX_ENV.**
It auto-detects the env from the running container and accepts
`--env=<env>` as an explicit override — **first positional argument
only**, a parser constraint nothing in the invocation announces. When
nothing is running and it falls back to dev, it says so out loud: an
operator on a prod box who expected prod must see that they got dev. No
silent default.

**Sibling dev-tool scripts MUST route through `scripts/mix.sh
--env=dev`.** `credo.sh`, `dialyzer.sh`, `format.sh` and friends pin
dev because credo, dialyxir, sobelow, mix_audit, doctor and ex_doc are
all `only: [:dev, :test]` in `mix.exs` and are simply absent from a
prod-profile container. `scripts/test.sh` pins `--env=test` for the
mirror-image reason: auto-detect would pick the live container's env
(usually dev or prod) and the Repo would never get the Sandbox pool.

**`DATABASE_PATH` is a prod-only override (#364 docker S5).** Only
`config/runtime.exs`'s prod branch reads it — `config/dev.exs` and
`config/test.exs` hardcode the path and ignore the variable entirely.
So `scripts/mix.sh` injects it for prod and only prod: `compose.yaml`
interpolates `DATABASE_PATH` from the *host's* `MIX_ENV`, which can
diverge from the env this script resolved, and `--env=prod` on a dev
host would otherwise migrate or read the DEV database. Injecting for
dev/test would be inert theatre, and the naive `grappa_test.db` does
not even match `config/test.exs`'s `MIX_TEST_PARTITION` suffix. The
path shape comes from `_lib.sh`'s `db_path_for_env` single source of
truth, whose only two consumers are `scripts/mix.sh` (the prod
override) and `scripts/db.sh` (open the active env's DB) — it must stay
character-identical to `compose.yaml`'s `DATABASE_PATH:`
interpolation, and neither consumer opens a partitioned test DB.

**`scripts/db.sh` opens a prod DB `-readonly`.** That is a safety
property an operator relies on before typing anything that looks like
an `UPDATE`: against prod the sqlite handle physically cannot write.
Dev and test open read-write.

### Never `iex -S mix` against a live node (#364 docker S2)

`scripts/iex.sh` and `scripts/observer.sh` are two entry points onto
one incident. Both used to run `iex -S mix` inside the container, which
boots a **whole second `Grappa.Application`**: Bootstrap re-reads the
DB credentials and spawns a DUPLICATE `Session.Server` plus a duplicate
upstream IRC connection per binding (nick collisions upstream), and the
second node contends with the live one for the same sqlite WAL
("Database busy"). For `observer.sh` it was doubly broken — `in_container`
is `docker compose exec -T`, which gives the TUI no TTY, and
`observer_cli` then introspected the freshly-booted node rather than
the live one, defeating the tool's entire purpose.

Both are now thin aliases onto the attach path that already existed:
`bin/grappa remote-shell` (T-2 — `iex --remsh grappa@grappa`, gated by
`RELEASE_COOKIE`) joins the LIVE node's shell without starting a second
application. One attach path, one code path. `scripts/observer.sh`
reaches the same node with a throwaway `--sname obs-$$` node started
`--no-start --no-compile`, over `docker compose … exec` **without**
`-T` so the TUI keeps its TTY. `observer_cli` is the BEAM equivalent of
htop, strace and tokio-console combined; it is an `only: [:dev]` dep,
so running `observer.sh` against a prod-profile container fails with a
bare `UndefinedFunctionError`.

Neither script needs a worktree guard, unlike the old code-loading
path: remsh always attaches to the LIVE node, which runs main's source,
so there is no "am I poking main or my worktree" ambiguity to warn
about. **Do not "simplify" either script back into `iex -S mix`.**

### Deploy scripts assert main-checkout FIRST (#364 docker S10)

`require_main_checkout` refuses to run from a worktree or a non-main
branch, and `scripts/deploy.sh` and `scripts/deploy-cic.sh` MUST call
it as their **first** step, before any side effect. Deploys ship main's
code path: a worktree's source is not what the live container has
mounted, and a feature branch is not what should reach the dev or prod
stack.

The ordering is the whole point, because the pre-fix behaviour was
side-effect-then-refuse. `deploy.sh` ran its branch check AFTER `cd
$REPO_ROOT`, so it inspected main's branch and never caught a worktree
at all, and the `git pull` had already mutated `REPO_ROOT` by the time
`in_container`'s own worktree check fired. `deploy-cic.sh` had no
branch guard whatsoever: it shipped whatever the main checkout's branch
happened to hold, rebuilt the on-disk bundle the live server serves,
and only then tripped the worktree check — dist swapped, then a
non-zero exit. `ALLOW_DEPLOY_FROM_BRANCH=1` overrides the branch half
of the check (a pre-existing knob, for the cases where you mean it).

### `scripts/deploy.sh` — the Docker substrate consumer

**It is a thin consumer of `infra/lib/deploy_common.sh` (#503).** The
same library drives `infra/freebsd/deploy.sh` (jail) and
`infra/linux/deploy.sh` (systemd), so the hot-vs-cold DECISION can no
longer drift between substrates. This script's job is to set config,
flip the feature toggles this substrate has, and define the
Docker-specific `substrate_*` hooks. Today's toggle set:

```sh
DEPLOY_FEATURE_FORCE_FLAGS=1     # --force-hot / --force-cold
DEPLOY_FEATURE_REEXEC=1
DEPLOY_FEATURE_MARKER=1          # runtime/last-deployed-sha
DEPLOY_FEATURE_PREV_SHA_CARRY=1
DEPLOY_FEATURE_DEFER=0           # no --defer-restart on Docker
DEPLOY_FEATURE_NOTHING_TO_DO=0
```

The `substrate_*` hook names are a contract with
`infra/lib/deploy_common.sh` — see § "The shared deploy library
(`infra/lib/`)" for the algorithm those hooks are called from, and §
"Hot vs cold deploy — when each path triggers" for the classification
itself. **The preflight hook's stdout contract:** it prints `→ <kind>:
<files>` per cold class, or `→ no unsafe markers → HOT`, and halts 0
(HOT) / 3 (COLD); anything else is not a verdict and the library aborts
on it.

**`.env` and `MIX_ENV` are established for BOTH paths, in
`establish_deploy_env` (#1377).** They used to live inside
`substrate_build`, which returns early on hot — so a hot deploy reached
the theme seed with no `MIX_ENV` in the shell, compose fell back to
`.env` for the interpolation, and `.env.example` ships `MIX_ENV=dev`:
cold seeded `grappa_prod.db`, hot seeded `grappa_dev.db` on the same
box, silently. The function runs at the top of `substrate_pull` — the
earliest hook, so it lands after the library's flag parse (an unknown
flag still reads as a usage error) and before the first side effect.
Consequence for operators: a box with no `.env` now fails the same way
on hot as it always did on cold.

**Hot deploys are the normal case.** `git pull` plus `POST
/admin/reload` swaps modules in the live BEAM with no restart, and
sessions (`Session.Server`, `IRC.Client`) keep their state. What cannot
be hot-swapped is a change to module *shape* — `mix.lock`/`mix.exs`,
the `application.ex` supervision tree, a long-lived GenServer's state
shape — because the reload is accepted and the new code then crashes at
the first message that exposes the change. `lib/grappa/deploy/preflight.ex`
diffs for exactly those markers and refuses hot.

**`mkdir -p runtime` does not assume a git checkout.** A checkout has
`runtime/` already (tracked `.gitkeep` plus the DB), but the
deploy marker owns its directory: a checkout-less install (release
image, or the `curl | bash` bootstrap on a fresh host) reuses this same
write.

**Migrations run BEFORE the long-running container comes up (the S3
crash-loop fix).** A one-shot `run` against the same image and the same
bind-mounted DB runs to completion and exits before the long-lived
container starts, so Bootstrap's first DB hit can never race an
unapplied migration. Bringing the container up first and migrating
after is the crash loop.

**`--no-deps --remove-orphans` on the recreate.** `--no-deps` avoids
re-running the `cicchetto-build` oneshot; `--remove-orphans` sweeps a
stale `grappa-nginx` left behind by a pre-#485 two-container stack.

**The cic build gets `GRAPPA_VERSION` passed through the env (#538,
#652).** The `cicchetto-build` container mounts only `./cicchetto` and
cannot read the repo root, so the single-source version (from the
`VERSION` file) has to be handed to it explicitly; vite bakes it into
`<meta cicchetto-version>`.

**The staging-then-promote build (#1020), Docker side.** The build
never writes into the directory the live BEAM is serving:
`cic_dist_docker_stage "$cic_served"` computes a staging sibling, the
build runs with `CIC_BUILD_OUT="$cic_build_out"` scoped to the single
`docker compose run cicchetto-build` invocation (so no later compose
call inherits it), and `cic_dist_promote "$cic_served"
"$cic_build_out"` renames it in. The promote is also what plants the
tracked `.gitkeep` into the tree that lands. `scripts/deploy-cic.sh`
does the identical dance with `CIC_SERVED="runtime/cicchetto-dist"`.
WHY it must be staged — vite empties its `outDir` first, and the BEAM
resolves the dist per request — is in § "The Docker compose stack
(`compose.yaml`)"; the rename/ENOENT-window/crash-recovery mechanics
are in § "The shared deploy library (`infra/lib/`)".

**The health probe runs from INSIDE the container.** `scripts/healthcheck.sh`
and `deploy.sh`'s `substrate_healthcheck` both curl `/healthz` from
within the grappa container, so the check is independent of host port
binding — and since #485 dropped the nginx container, grappa
self-serves everything and the probe hits grappa directly. The two
copies must not drift apart.

### `scripts/deploy-cic.sh` — the bundle-only deploy

**Cic and server ship on independent cadences.** A cic deploy never
needs a server restart, and a server deploy never triggers a cic
refresh. Edit `cicchetto/src/`, run this, and connected browsers see
the refresh banner within seconds.

**How the banner fires.** `POST /admin/cic-bundle-changed` makes the
server re-read the new `index.html` via
`Grappa.Cic.Bundle.current_hash/0` and broadcast `{kind: "bundle_hash",
hash}` on every live user topic. cic compares it against
`bootBundleHash` — the hash baked into the page that browser loaded —
and on a mismatch surfaces a refresh banner whose click is
`window.location.reload()`.

**The POST goes through `_lib.sh in_container`, not `docker exec
grappa`.** The endpoint is loopback-gated, so the request has to
originate inside the grappa pod; routing it through `in_container`
shares the container-name lookup with every other operator surface
(H27, 2026-05-22 codebase review). A bare `docker exec grappa` assumed
`container_name: grappa` literally and broke under compose overrides.

**A 204 is a FAILED deploy, not a success (#526).** The response body
is the new hash on success and empty on 204 — meaning the server could
not READ the dist that was just built, so it broadcast NOTHING and no
live client will ever see the banner. The broadcast IS the point of the
step. The old code printed a ✓ here, which is how the 2026-07-28
production incident degraded silently: `CIC_DIST_ROOT` resolved to a
path the BEAM's CWD could not reach, and the deploy "succeeded". It now
fails loud and names the fix in the error text.

### `scripts/deploy-m42.sh` — the prod (bastille jail) wrapper

**It only wraps the incantation.** `ssh m42` plus `sudo bastille cmd
grappa <jail script>`, so the operator does not have to memorise it.
The jail-side scripts live in `infra/freebsd/` and are documented
"invoke from the m42 host"; this is that host-side caller, runnable
from anywhere with ssh access to m42 — workstation, repo checkout, CI.
Exit codes: 0 ok, 64 usage; everything else is an ssh or remote
failure, and the jail script's own exit code passes straight through.

**PUSH first — the script does not push for you.** The jail scripts
`git pull --ff-only` from origin/main, so unpushed local commits simply
are not there. As a guard the wrapper fetches origin and refuses to run
when local main is ahead of origin/main; without it you deploy a stale
tree and wonder why nothing changed.

**There is no nginx inside the jail.** No path in this script touches a
proxy: the BEAM binds `*:4000` and the m42 HOST vhost proxies straight
to it — the same posture as Docker since #485.

**`--full-restart` is a cold deploy that binds NEW jail vhosts in one
bounce, and it is deliberately two remote calls.** First the jail
stages the release and the rc.d wrappers and STOPS the BEAM
(`deploy.sh --force-cold --defer-restart` exits 0 without starting it);
then the host issues a single `bastille restart`, which boots the
staged release through the new wrapper and binds any new jail vhosts.
Use it when a new vhost or a jail-layer network change must take
effect. **The completed-deploy marker is written by the HOST, after the
post-bounce healthcheck passes** — the jail's `deploy.sh` deliberately
does not write it, because at its exit the BEAM is still down and
nothing has been verified.

### `scripts/release-image.sh` — the one wrapper that leaves the compose stack

**Why it exists.** Raw `docker` from a shell or an agent is forbidden
(see `docs/TESTING.md`), and every other wrapper drives the compose DEV
stack. The release image is a different artifact with a different
failure surface: #862 (no secrets on a bare run) and #867 (no migration
on a bare run) were both found by hand-typing docker commands, and
#503 unit D still carries a "run a real `docker run` of the published
image before trusting these one-liners" caveat. This script turns that
into a repeatable command. Runbook for the image itself: § "Running the
published image (`docker run` / `curl | bash`)".

**`fresh-boot` / `warm-boot` reproduce the DOCUMENTED one-liner, and
the only thing they may pass is `PHX_HOST`.** That value cannot be
invented; everything else must come from the image and the volume, or
the one-liner is a lie. Adding a convenience `-e SECRET_KEY_BASE=…`
would void the entire validity condition of the script — do not.

**The container log is printed on failure.** A dead bare run is the
whole point of this script, so its output must never be swallowed.

### `scripts/register-dns.sh` — operator DNS helper

**Not part of the standard dev or deploy flow.** It presupposes a
Technitium DNS server with API access and an env file exporting
`TECHNITIUM_TOKEN`; the env vars at the top of the script are meant to
be tuned per deployment.

**Idempotent in the strong sense: delete-then-add, never bare `add`.**
The post-condition asserts that the authoritative DNS answer matches
the desired IP after the run. If the record already resolves correctly,
no API call is made at all. If it exists but resolves to a different IP
(drift), the record is deleted and re-added — because `add` alone
silently no-ops on conflict and leaves the WRONG IP in place, which is
precisely the case worth automating.

**Technitium API quirks, which are the reason for the odd curl flags.**
Parameters go on the query string, not in a JSON body (hence
`--data-urlencode`); the server presents a self-signed certificate
(hence `curl -sk`); the response JSON carries `status` plus an optional
`errorMessage` at the top level.

**Never print a Technitium response body — only `status` and
`errorMessage`.** The API token rides every request, so if Technitium
ever echoes it in an error reply the leak lands in operator stdout and
CI logs. Current versions do not echo it; this is defence in depth, and
an `echo "$response"` added for debugging defeats it.

**The post-condition's short settle delay is diagnostic.**
Technitium's in-zone cache lags the add slightly. If the new answer has
not propagated within ~3s, something is wrong with the zone serial or
the upstream resolver — the delay is not padding.

### The e2e stack: `testnet.sh` (stack) + `integration.sh` (suite)

**The split.** Stack management lives in `scripts/testnet.sh` — bring
up, probe, tear down the testnet without running any tests by calling
it directly. `scripts/integration.sh` wraps it with a one-shot
Playwright run plus automatic tear-down on exit. What the stack
contains is in `docs/TESTING.md` § "The e2e stack".

**Submodules: auto-init, and `-c protocol.file.allow=always` is
REQUIRED, not cosmetic (#592).** Git worktrees do not inherit the
parent checkout's submodules — the gitlink and the `.git/modules` entry
are shared, but each worktree gets its own working tree — so a fresh
worktree always lands in the init path. Both `testnet.sh`
(`cicchetto/e2e/infra`) and `scripts/bats.sh` (`vendor/bats-core`)
therefore self-heal rather than dying on a manual step everyone
forgets; the init is idempotent and a no-op once present. In a worktree
git clones the submodule from the superproject's LOCAL module store
(`$REPO/.git/modules/…`) over the `file://` transport, which the
CVE-2022-39253 mitigation blocks by default — without the flag every
fresh worktree dies with `fatal: transport 'file' not allowed`, and the
auto-init that exists precisely to spare the manual step spares
nothing. (The SSH-clone variant of this failure, and the permanent
`url.…insteadOf` fix, are in the fresh-worktree gotcha above.)

`testnet.sh` also seeds `cicchetto/e2e/infra/.env` from the
submodule's `.env.example` when the file is absent.

**`e2e_export_uid` must run in the SAME shell that invokes `docker
compose`.** On Linux the bind mounts to `runtime/bun-cache` and
`runtime/e2e/cicchetto-dist` must be writable by the in-container UID,
so the helper drops `CONTAINER_UID`/`GID` to the host user's; on macOS
Docker Desktop translates ownership transparently and the helper is
effectively a no-op. It is called from BOTH `testnet.sh` and
`integration.sh` on purpose: `testnet.sh up` runs in a subshell when
invoked by `integration.sh`, so its export does not propagate back to
the parent. Get that wrong and the CI symptom is indirect — the
`cicchetto-build-test` config hash drifts between the two `compose up`
phases (testnet's, then integration's via the `playwright-runner`
`depends_on` chain, UID 1000 vs 1001), compose RECREATES the container,
and the second start exits 1 on AccessDenied writing to the dist/cache
directories the first run already wrote as the host UID.

**`testnet up` tears down before it brings up.** If a previous run is
still around, or an `integration.sh` run died mid-flight, the bahamut
leaf and the `grappa-test` container still hold ports, DB locks and
sqlite WAL state; the teardown-first makes the second run inherit a
clean slate. `down -v` is destructive but scoped: the named volumes it
wipes are e2e-only (deps, build and hex caches plus the runner's
`node_modules`), and the host bind mount under `runtime/e2e/` is wiped
by the same `e2e_force_rm` path the `down` branch uses.

**The seeder boots alone, in its own phase, via `compose run --rm`.**
Re-running an already-completed seeder through the dependency graph
trips on the duplicate user row, so phase 1 boots it by itself. It is
`compose run --rm` and NOT `up --wait` because `up --wait` treats a
one-shot's normal exit as a healthcheck failure and returns non-zero,
tripping the inherited `set -e`; `run --rm` is synchronous and returns
the container's actual exit code, which is what the mix-task seed
pipeline needs.

**Phase 2 passes `--build` again on purpose.** The seeder's `--build`
only rebuilds the grappa image; the azzurra-testnet bahamut images are
independent and would otherwise stay cached on whatever
`infra/bahamut/conf.{hub,leaf4,leaf6}.tmpl` was COPY'd at the last
build. Two services in that phase are easy to misread: `solanum-test2`
is the standalone second-network ircd (solanum, #221 — it keeps the
`bahamut-test2` *network alias*, but the compose SERVICE name is
`solanum-test2`), and `mailpit` (#349) is the mailcatcher the
registration-wizard e2e polls for the emailed NickServ AUTH code
(services relays via msmtp to `mailpit:1025`). Mailpit is a distroless
image with no healthcheck, so `--wait` treats it as up once running.

**`testnet.sh probe` and its one diagnostic.** It uses `nginx-test` as
a convenient netcat host — the alpine image ships `nc` and is already
on the `grappa-e2e` bridge — and auto-opers with the baked-in
`azzurra`/`azzt3st` credential so `/links` and `/stats l` report real
link state. The output is raw IRC wire, and the line that matters is
`255 :I have N clients and 0 servers`: zero servers means the testnet
is running SPLIT, unlinked. That diagnostic is why `probe` exists.

**`integration.sh` captures container logs in its EXIT trap, and it has
to be there (#702).** On a non-zero exit the trap dumps every
container's log to `cicchetto/e2e/container-logs/` BEFORE the tear-down
destroys the containers — by the time a CI workflow step could run
`docker compose logs` there is nothing left to read, and a CI-only
failure would have to be diagnosed from the browser side alone. The
Playwright trace shows the browser half of a failure whose cause is
usually upstream (grappa, bahamut, services). One file per container.
The run prints the captured sizes, so what this costs per failed run is
a measurement rather than an estimate — that is the number to revisit
if it ever grows into something worth capping. `KEEP_STACK=1` opts out
of the tear-down entirely for iterative debugging.

**The BYTES are failure-only; the MEASUREMENT is not (#1429).** Keeping
every run's logs is how an artifact store becomes a landfill — ~275 MB
uncompressed per run, ~20 MB in the artifact, and a fortnight's green
runs are on the order of 9 GB. But discarding them wholesale made the
other half of the sentence false: a green run's logs answered the one
question nobody could otherwise ask, because the open question about
the 30.1 s stall regime (#1420, #1421) is whether it also hits the runs
that PASS, and those were exactly the runs kept blind. The census that
came out of that investigation covered 7 of 59 runs *that produced
logs* — never 7 of 626, because the other 567 were never asked.

So the trap now streams each service's log through
`scripts/log-gap-scan.awk` on every exit and keeps only what it
measured: the largest silence between consecutive lines, every silence
at or over `GAP_THRESHOLD` (10 s — above the 5 s healthcheck cadence,
below the 30 s `busy_timeout`), and counts of the damage signatures
(`db=3xxxx`, `idle=3xxxx`, a dropped scrollback row, a saturated pool).
That lands in `container-logs/gap-scan.tsv`, a few KB, and on stdout as
well — on a green CI run the job log is the copy that survives without
an artifact. `tee` is the mechanism: on a red the stream reaches both
the disk and the scanner, on a green only the scanner. The workflow
uploads the census with `if: always()` and leaves the three existing
`if: failure()` artifact steps alone.

This is evidence collection, not a gate: neither branch of the trap
touches the exit code, and a green run stays green.

**The service list for that capture is DERIVED, never hand-written
(the #441 lesson).** A hand list stops covering the service added after
it was written, and looks like coverage the whole time it does; the
list is therefore taken from what compose actually has containers for.
`compose run --rm` one-shots (the Playwright runner) are already gone
by then and self-exclude — their stdout is the job log anyway.
`capture_container_logs` `cd`s into the e2e dir and that cwd change
leaks into the rest of `cleanup`; it is harmless only because
`$TESTNET` is an absolute path, so keep it one.

**`GRAPPA_VERSION` is exported in `integration.sh` too, not only in
`testnet.sh` (#538).** `integration.sh`'s own `docker compose run
playwright-runner` re-resolves the stack, so it needs the value in its
own environment. `SRC_ROOT` has `mix.exs`; the cic build container
mounts only `./cicchetto` and cannot read it. The runner image is built
separately from `testnet up` because the runner is e2e-suite-specific,
not part of the testnet stack contract.

**`--name e2e-runner` is load-bearing: it costs ~30s per peer connect
to drop it.** The default `compose run` synthesises a long container
name (`grappa-e2e-playwright-runner-run-<hex>`, 45 chars) which,
combined with the network suffix `.grappa-e2e_grappa-e2e` (22 chars),
overflows bahamut's 63-char `HOSTLEN` cap inside `dn_expand`
(`res.c:1064`). The function returns -1, `proc_answer` aborts mid-parse,
the DNS request stays PENDING through ~28s of retries, and
`check_pings`'s `CONNECTTIMEOUT=30s` then forces `SetAccess`. Net
effect: a ~30s pre-welcome stall on every peer connect, paid in CI
wall-clock. Keeping the runtime container name short sidesteps the
whole truncation path.

### `scripts/bun.sh` — the cic toolchain oneshot

**`bun.sh run build` is NOT a production preview (#538).** It builds
into `cicchetto/dist/` for local inspection; production deploys never
consume that directory. `scripts/deploy.sh` invokes the compose
`cicchetto-build` oneshot, which writes to the bind-mounted
`runtime/cicchetto-dist/` — the path the live BEAM serves. For a build
that matches what production serves, run `scripts/deploy.sh` (which
exports the #538 `GRAPPA_VERSION`; a bare `docker compose run
cicchetto-build` fails loud in vite without it).

**`node_modules` is PER-WORKTREE; the bun download cache is SHARED.**
`vitest`, `tsc`, `vite` and `biome` all live in
`cicchetto/node_modules`, which a new worktree does not have — so the
script pre-installs on demand for the non-install verbs (the
install-family verbs manage `node_modules` themselves and are skipped).
Since #484 the same applies to `cicchetto/e2e/node_modules`, whose
`@playwright/test`, `@types/node` and `irc-framework` are declared by
`e2e/package.json` rather than cicchetto's (e2e tracks no lockfile by
design — see `cicchetto/e2e/.gitignore`). The failure signatures a
missing install produces are in `docs/TESTING.md`. The bun *download*
cache, by contrast, is a host bind mount at
`REPO_ROOT/runtime/bun-cache` and is shared by every worktree
(`REPO_ROOT` is always main), so `bun install` is fast after the first
run. It is a host bind mount rather than a named volume so the
directory inherits the host user's ownership and the `--user` override
can write to it.

**`bun.sh` honours `CONTAINER_UID`/`GID` even though it is a raw
`docker run`.** `runtime/bun-cache` is SHARED with the compose
`cicchetto-build` path, which pins `CONTAINER_UID`; if this oneshot
used the live host UID instead, the two would write cache files under
different owners and produce intermittent EACCES. Related: the image's
default `/tmp` is root-owned, so `/tmp` is mounted as a tmpfs owned by
the dropped UID and `HOME` points at it — otherwise bun's tempdir
writes fail.

**The `oven/bun:1` image is digest-pinned (#103).** `1` is a
major-moving tag; the tag stays for human readability and the `@sha256`
INDEX digest enforces reproducibility while still resolving multi-arch
(amd64 CI, arm64 dev host). Refresh only on an intentional bump:

```sh
docker buildx imagetools inspect oven/bun:1 --format '{{.Manifest.Digest}}'
```

### `scripts/shellcheck.sh` — a derived lint set, not a list (#441)

**The gate this replaced was a hand-written list of eleven paths in
`ci.yml`, and a hand list is not a gate — it is a snapshot.**
`infra/linux/install.sh`, the file whose defects filed #441, was never
on it, and `bin/` was not linted at all; the next script added would
have been uncovered for exactly the reason the last one was. So the set
is DERIVED: every shell script under `bin/`, `infra/` and `scripts/` is
linted because it IS one, not because somebody remembered. Membership
is by extension OR shebang. There is deliberately no per-file dialect
table — that would be a second place for the per-script dialect to
drift.

**The linter is a digest-pinned container, not the host binary
(#103).** shellcheck's findings change between minors, so a laptop on
0.9 and a runner on whatever `ubuntu-latest` ships that month disagree
about what "clean" means — and the laptop's green is the one you trust
before pushing. One image, one verdict, both sides. A missing docker
is a hard `exit 1`: a gate that silently skips itself is worse than no
gate. Note that the in-file `# shellcheck source=` directives are part
of the gate, not decoration; a comment sweep is exactly the operation
that deletes them.

### `scripts/posix-parse.sh` — the same idea, one dialect down (#1377)

**A different property, a different tool: shellcheck lints, `dash -n`
parses.** Files that run as the FreeBSD jail's `/bin/sh` must be strict
POSIX, and this gate is the interpreter itself agreeing. Same derivation
discipline as its sibling above, one question narrower — membership is
the file's own line-1 dialect declaration (`#!/bin/sh`-family shebang,
or a `# shellcheck shell=sh` directive), which is the answer each file
already gives shellcheck. Twenty-eight files today; the `ci.yml` hand
list it replaced named five and missed, among others, two of the three
POSIX libs under `infra/lib/`. `--list` prints the set. A missing `dash`
is a hard `exit 1`, same doctrine as the missing-docker branch above.
See § "The shared deploy library (infra/lib/)" for what the gate is
protecting and for what `dash -n` does NOT catch.

### `scripts/quickstart*.sh` — deprecated shims (#503)

The three quickstart scripts (`quickstart.sh`, `-update.sh`, `-stop.sh`)
were absorbed into one verb-dispatched consumer of the shared deploy
library, `infra/docker/deploy.sh`. The shims remain and forward
verbatim, each with its own pass-through set (`--volumes`/`-v` on stop;
`--no-pull`/`--force-hot`/`--force-cold` on update), and the
environment they accept (`PHX_HOST`, `HTTP_BIND`, `SEED_*`,
`FRONTEND_SSL_*`) survives the `exec`. Prefer the successor command
directly. **The `update` verb is strictly smarter than the shim ever
was:** instead of always recreating, it classifies hot vs cold via
`Grappa.Deploy.Preflight` — HOT posts `/admin/reload` and preserves
sessions, COLD recreates.

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
- `lib/grappa/themes/builtins.ex` (the curated built-in gallery) — HOT,
  like any lib module, which is exactly why the theme seed is NOT a
  cold-only step. Since #440 `deploy_common`'s `substrate_seed` hook
  runs on EVERY deploy, hot and cold, on all four consumers: the seed set
  is versioned code and used to be materialised once, at install, so
  anything added later reached new installs only. Each substrate's door
  mirrors its `substrate_migrate` — jail and the published image via
  `Grappa.Release.seed_themes()`, systemd and both compose flavors via
  `mix grappa.seed_themes`. Ordering is schema-then-data on both paths:
  after `substrate_migrate` on cold, after the reload on hot (since #41
  the reload itself applies pending expand migrations). A seed failure
  WARNS and continues — the gallery is cosmetic, the upsert converges,
  and the next deploy heals it; the warning names the gallery, carries
  the retry command, and is repeated after the ✓ banner.
  **Since #1167 the same seed also runs on the doors that have no deploy
  script at all** — the `.deb`/`.rpm` postinstall, the Arch `_bootstrap`
  (both through the `grappa seed-themes` verb) and `release-entrypoint.sh`
  for a bare `docker run` — each right after its own migrate, and each
  keeping the non-fatal posture above. In the container it rides
  `GRAPPA_AUTO_MIGRATE` rather than taking a knob of its own: an operator
  who sets that to 0 did so to keep boot from writing to the database, and
  seeding is a write. Guarded by
  `test/infra/packaging_seed_themes_test.bats` and the seed arms of
  `test/infra/release_entrypoint_migrate_test.bats`.
  Deploy orchestrators
  (`scripts/deploy.sh`, `infra/freebsd/deploy.sh`),
  operator-on-demand verbs (`infra/freebsd/jail_*.sh`) and
  `grappa.env.example` are HOT on both substrates — nothing about
  them lands in the running BEAM (d8f354c).
- `priv/repo/migrations/*` — **CONTRACT migrations only** since #41.
  The hot path no longer skips the migration: `POST /admin/reload`
  applies pending migrations in-process on the live `Grappa.Repo` pool
  and only THEN reloads modules, so an all-**expand** migration is HOT
  (that is why the pre-#41 blanket rule existed — new tables/columns
  used to 500 on first query post-reload, and Bootstrap crash-looped if
  it read them).
  `Grappa.Deploy.Preflight.classify_migration/1` parses `change/0` /
  `up/0` and allowlists: `create table`, plain `create index`,
  `add`/`add_if_not_exists` of a nullable-or-defaulted column, and a
  `unique_index`/`constraint` on a table the SAME body created.
  Everything else — `remove`, `rename`, `modify`, `drop`, `add null:
  false` with no default, `unique_index` on an existing table, raw
  `execute`, `@disable_ddl_transaction`, anything unparseable — is
  COLD, and no annotation can override it (a migration cannot vouch for
  itself). **A DATA BACKFILL written as `execute(raw_sql)` is COLD by
  design**: reading raw SQL to guess would be exactly the false-HOT this
  exists to prevent.
  The rule is asymmetric on purpose: a false-COLD costs one restart, a
  false-HOT crashes a `Session.Server` → its linked `IRC.Client` → a
  visible QUIT upstream. The BEAM and sqlite share no clock, so a
  contract change has no safe ordering at all (and holding the DDL
  transaction open would starve the single sqlite writer instead).
  The reload handler re-checks the PENDING set against the same
  classifier and answers `409 contract_migrations_pending` — that is
  what keeps `--force-hot`, which skips preflight entirely, from
  applying a contract migration to a live BEAM.
- `infra/linux/nginx.conf` + `infra/snippets/*` — COLD on **`:linux`
  only**. `:linux` is the last deploy substrate that runs an nginx:
  #485 dropped the Docker container and the bastille jail's nginx was
  deleted outright (the m42 HOST vhost proxies straight to the jail
  BEAM on :4000). Neither reads these files, and charging a
  session-dropping COLD on m42 prod for a file nothing there opens is
  the #923 failure the scoping exists to prevent. Hot path doesn't
  reload nginx, so when a `:linux` change happens the hot BEAM swap
  won't pick it up — reload nginx by hand or COLD-deploy. NOTE: the CSP
  itself is NO LONGER here — it moved into the BEAM
  (`GrappaWeb.Plugs.SecurityHeaders`), so a captcha-provider CSP
  edit is now a code change (COLD), not an nginx reload. The snippet is
  ALSO included by the e2e proxy and fetched by the AWS box's
  `infra/cloud/first-boot.sh` — neither is a deploy substrate this
  classifier is ever called with.
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

**Since #1161 the BEAM says this at boot, before anything asks it for a
file.** `Grappa.Cic.Bundle.boot/1` warns when the resolved root holds no
`index.html`, naming the **expanded** path (the part a relative default
hides), what was missing there, and the variable that moves it:

```
[warning] cic bundle root does not exist: /home/grappa/runtime/cicchetto-dist
 — the SPA will 404 on every document request. Set CIC_DIST_ROOT to the
 directory holding the built SPA (the one with index.html).
```

So the first grep on a frontend-404 report is the startup log, not the
deploy wrapper's exit code. It warns and never raises — a bundle-less boot
is legitimate between a release and the first `cicchetto-build` — and it
never falls back to another path: a root that misses stays missed, so a
typo cannot quietly serve a different bundle than the one configured.

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

**There is no nginx inside the jail.** The BEAM binds `*:4000` and the
m42 HOST vhost proxies straight to it — the jail matches the Docker
posture (BEAM published directly, nothing in front of it inside the
box). #485 had already hollowed the jail nginx into a pure pass-through;
the shell was deleted after. So no deploy path installs, validates or
reloads an nginx config any more, and `infra/snippets/*` is not read on
this substrate. The host vhost (TLS termination, `/socket` upgrade,
`X-Forwarded-For`, body ceiling) is the operator's, lives outside this
repo, and is the ONLY proxy hop.

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
`VERSION` (an `@external_resource`). **Plan a restart for any release bump: a
`VERSION`-only bump is a COLD deploy** — measured on m42 2026-08-10,
correcting what #652 claimed here. `mix.exs` reads the same file to stamp the
OTP application vsn, so the bump moves the release's lib directory to
`lib/grappa-<new>/ebin`, while the running node keeps resolving
`:code.lib_dir(:grappa)` — the directory `Grappa.HotReload.reload_modified/0`
walks — to its BOOT directory `lib/grappa-<old>/ebin`. Nothing in there
changed, so `/admin/reload` answers `{"failed":[],"reloaded":[]}` and the node
serves the OLD number with the new code already on disk. **Preflight enforces
this since #1287** — a diff touching `VERSION` is COLD with reason
`version: VERSION` on `:jail` and `:linux`, so you no longer have to remember
it. It stays HOT on `:docker`, which boots `mix phx.server` over a bind-mount
and has no vsn in its lib-directory path; that asymmetry is pinned by a test,
so if the container ever moves to a release layout, that test is where it
surfaces. Corollary: an **unplanned** prod move (a
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
4. **News/Releases `news.json` entry.** An entry that LINKS the GitHub release
   plus a curated bilingual highlight (NOT a changelog dump), prepended to
   `items[]` in `grappa-www`'s `public/news.json`. **Whose lane it is: vjt's by
   default, but he hands it over** — on 2026-08-05 he told the orchestrator
   *"falla tu la copy news"*, so ASK rather than assume, and write it yourself
   when he says so.
   **Publishing, as MEASURED on 2026-08-05** (the old text here said "scp to m42
   `htdocs` + CF-purge"; both halves were stale, and what replaced them was
   wrong too — see the warning below):
   - The origin is a **pull** design: `/srv/www/grappa.chat/deploy.sh` `git
     fetch`es + hard-resets the checkout whose `public/` IS the nginx document
     root. No build, no upload. Cloudflare fronts it but answers
     `cf-cache-status: DYNAMIC`, so **no purge is needed** — verified with a
     cache-buster.
   - 🔴 **THE PULL IS NOT ACTUALLY WIRED, AND ITS DEPLOY KEY IS DEAD.** On m42
     there is **no cron entry** for it and **no `/var/log/grappa-www-deploy.log`**,
     and running it by hand as root fails at `git@github.com: Permission denied
     (publickey)`. So a `git push` alone publishes NOTHING. Until vjt restores
     the read-only deploy key, publish by copying the **committed** file into the
     doc root (`install -o root -g wheel -m 644`) and checksum both ends — the
     content still comes from a pushed commit, so nothing is
     deployed-not-committed.
   🔴 **VERIFY FROM THE LIVE URL** (`curl https://grappa.chat/news.json`), never
   from the push succeeding. That is exactly how the dead key was found: the push
   went fine, `last-modified` stayed a day old. *A pull-based deploy fails
   silently by construction — nothing you did reports an error.*
   Anti-drift: the News content is never deployed-not-committed (the trigger was
   testimonials left live-but-uncommitted); with a pull-based origin that is now
   structurally impossible, which is the point.
   ⚠️ **Check the page for GAPS at every cut.** v0.11.0 was tagged, released, and
   never got an entry — the page jumped 0.10.0 → 0.12.0 until it was backfilled a
   day later. A missing entry is invisible from the release side.
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

   - **Prepend** to `items[]` (newest first). `text` = a curated, bilingual
     highlight (NOT the raw dev changelog); `link` → the GitHub release.
     ℹ️ The "~20 words" this used to specify has never matched the file: every
     shipped entry is a ~150-word paragraph. **Follow the file, not this line** —
     lead with what changed for a reader who does not already run it.

   **Division of labor:** ORCHESTRATOR = create the GH release + ping vjt with
   (tag, URL, 2-line highlight), and write + push the news entry whenever he
   hands that lane over. vjt = the call on whether he writes the copy himself.
5. **Dual-net announce** (#grappa on Azzurra + Libera via the ircbot) + `gh issue
   close` the closed-at-release issues + strip their `status:soon`.
   ⚠️ **A TAG-ONLY release (no deploy) does NOT get the "we shipped" announce** —
   nothing changed for a user of the hosted instance, and saying otherwise is
   simply false. What is worth one line is that self-hosters have a tag to pull.
   🔴 **Not every `status:soon` issue is DONE.** #96 shipped one leg of three in
   v0.12.0 and vjt said explicitly the rest stays open: at the sweep it got the
   release comment and its label stripped, but was NOT closed. Check each one.

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
  `:latest`. Since #1162 it then DEPLOYS that image and probes it (the `smoke`
  job, below) instead of only proving it compiles — so the dry-run is a smoke
  test in fact and not just in name. deb/arch/rpm/publish are skipped for this
  run. The default
  (`docker_validation=false`) tag-push path is unchanged — it publishes. The
  arm64 leg is QEMU-emulated on the amd64 runner; a stale QEMU crashes the
  emulated BEAM JIT at the first `mix` call, so the job pins a recent
  `tonistiigi/binfmt` via `setup-qemu-action`. If the emulated arm64 leg proves
  unreliable on CI, the fallback (needs vjt's sign-off — it deviates from the
  buildx+QEMU decision) is native arm64 runners (`ubuntu-24.04-arm`) +
  `docker manifest`.
- **The image is DEPLOYED and PROBED, not just built (#1162).** A fifth job,
  `smoke`, `needs: [docker]` and brings a real box up from the image through the
  same `infra/docker/get.sh` → `deploy.sh` path an operator runs, then asks it
  questions over HTTP: `GET /` serves a shell whose chunk actually loads as
  JavaScript, `GET /api/config` reports this version, and a restart does not
  rotate the generated `/data/grappa.env`. On a tag it pulls the PUBLISHED
  `:v<version>` — the ref operators resolve; on a dry-run it probes the amd64
  image re-exported from the build cache. amd64 only (the arm64 leg is proven by
  the build). **An unobtainable image fails the job; it never skips.** The driver
  is `scripts/smoke-release-image.sh`, runnable by hand — probes, mutation
  evidence and the explicit non-coverage list are in
  `docs/TESTING.md` § "The release-image smoke".
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
- **Mix tasks: the `:4000` reason below is STALE — treat the caution as
  unverified, not as a rule.** This bullet used to read "mix tasks don't
  work in the jail: a second BEAM collides with the live node's Endpoint
  `:4000` in the shared netns". That collision was fixed on 2026-07-23:
  `Mix.Tasks.Grappa.Boot.start_app_silent/0` suppresses BOTH
  `Grappa.Bootstrap` and `GrappaWeb.Endpoint`, and runs `mix app.config`
  so `config/runtime.exs` is evaluated under `MIX_ENV=prod`. The jail also
  has the full source tree and Mix — `infra/freebsd/deploy.sh` runs
  `git pull`, `mix deps.get`, `mix compile`, `mix release --overwrite`
  and even `mix run --no-start -e 'Grappa.Deploy.Preflight.cli(…)'` on
  every deploy. So the recipe is:

  ```sh
  jexec grappa su -l grappa -c 'cd /home/grappa/grappa;
    set -a; . /usr/local/etc/grappa/grappa.env; set +a;
    MIX_ENV=prod mix grappa.<task>'
  ```

  **What is still NOT established:** whether a second BEAM writing the
  same SQLite file while the live node is running is safe in practice.
  WAL allows concurrent readers and one writer, but this has not been
  exercised against the live jail. Prefer a read-only / dry-run task
  first, and read `database is locked` in the output as a reason to stop
  and drive the LIVE node via `rpc` instead.
- **`grappa.repair_passwords` (#1001) is a mix task, and dry-run is its
  default.** Run it with no flags first — it writes nothing and prints
  the classification. `--write` applies only the deterministic repairs
  (`:nickserv_identify`, exactly two tokens); everything else is reported
  for a human. A repaired password is read at (re)connect via
  `SessionPlan.base_plan/6`, exactly like a #124 field edit, so the fix
  takes effect on the session's next reconnect rather than immediately.
  A non-zero count on a modern install is the signal of a NEW bug, not
  backlog — the task's own output says so.
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
  path, and since #923 a thin substrate entry point over the one
  implementation in `infra/lib/beam_wait.sh` (the Linux substrate's
  `grappa_beam_wait.sh` is the other entry point over the same file). If a restart still aborts with `name grappa@grappa … in use`
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

> ⚠️ **The derivation is keyed to YOUR deployment, and the key is
> `SECRET_KEY_BASE` (#1404).** The derived address is what the IRC
> network publishes as the user's host, so it must be private to your
> deployment. It is now `HMAC-SHA256` under a subkey derived from
> `SECRET_KEY_BASE` at boot; two deployments derive different addresses
> for the same subscriber.
> No new secret to manage — but two consequences you need before you
> hit them:
>
> * **Upgrading to the release carrying #1404 renumbers a mode-2
>   deployment ONCE.** Every subject moves to one new stable address at
>   its next connect. Nothing is lost: derived addresses are computed on
>   demand and never stored, so this is the same event as renumbering
>   the prefix, which this mode already supports —
>   `Grappa.Net.SourceAliasManager` reconciles the alias set at boot.
>   Expect a burst of alias churn on the first start, and expect users
>   to see a new host. If your ircd, your channel bans or your oper
>   tooling reference the old hosts, they need updating in the same
>   window.
> * **Rotating `SECRET_KEY_BASE` renumbers a mode-2 deployment again**,
>   for the same reason. On the default `pool_with_reservations` mode
>   neither of these applies: nothing is derived.
>
> Deployments on the default mode can ignore this note entirely.

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

## Letting a locked-out visitor back in (#982)

A visitor has no password — the browser session IS the identity. If the
device dies, the profile is wiped, or the cookie goes away, the account
is unreachable and there is nothing to "reset". The recovery verb is:

```
POST /admin/visitors/:id/share-token      # admin bearer, :admin_authn
→ 200 {"token": "...", "expires_at": "2026-08-07T12:10:00Z"}
```

Hand the person `https://<host>/#/share/<token>`; consuming it mints
them a fresh session for the SAME visitor identity.

**The link is a bearer credential for that visitor's session.** Anyone
holding it within the window becomes that visitor — there is no second
factor, because the identity has no first one. Therefore:

* **Send it over a private channel.** A pasted link in a public
  channel, a shared ticket, or an unencrypted mail thread is a handed-
  over account. Prefer the same channel you would use for a password.
* **It expires in 10 minutes and redeems exactly once.** Both limits
  are deliberate and must not be widened for convenience — they are
  what keep a leaked link from becoming a standing key. If the person
  misses the window, mint another one; that is cheaper than a longer
  TTL.
* **Every mint is recorded** as a `visitor_share_token_minted` admin
  event naming the admin who pressed it, visible in the console's
  Events tab, with telemetry distinct from the self-mint every subject
  can do for itself (#1306 — a user shares to a second device the same
  way). The capability is abusable by an admin by construction (see
  `docs/DESIGN_NOTES.md`); the audit trail is the mitigation, so do
  not expect the mint to be deniable.
* **Incognito visitors are refused (403).** An incognito session is
  deliberately non-portable (#363); there is nothing to restore.

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

**No proxy may re-assert them.** Every nginx that survives is a dumb
reverse proxy (`infra/snippets/locations-api.conf`,
`location / → BEAM`); it emits none of these headers. On m42 the only
proxy left is the HOST vhost — the jail's own nginx is gone — and the
rule binds it the same way. If a proxy also sends a
`Content-Security-Policy`, the browser enforces the **intersection** of
all policies (not the union) — a prod-only footgun that silently
tightens the CSP and breaks the widgets it drops. Confirm the BEAM emits
them and nothing doubles them:
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
CSP is a security regression, not a cosmetic one. No nginx reload needed —
on m42 there is no jail-side nginx left to reload at all. Verify the live
header:

```sh
ssh m42 "curl -fsSL -D - -o /dev/null https://irc.sniffo.org/ 2>&1 | grep -i content-security-policy"
```

After any security-header change, check the full set is emitted **exactly
once** through the public host (a duplicate means the operator's host
vhost started asserting one too):

```sh
ssh m42 "curl -fsSL -D - -o /dev/null https://irc.sindro.me/ 2>&1 \
  | grep -iE 'content-security-policy|x-frame-options|x-content-type|referrer-policy|permissions-policy'"
```

## The Docker compose stack (compose.yaml)

One file for dev and prod, one image, `mix phx.server` in every
environment; `MIX_ENV` is the only env-distinguishing variable. Profiles
select the extras: none for dev, `prod` for the `cicchetto-build`
oneshot, `ircd` for the bridge. This section is the WHY behind the
file's shape — the file itself only says what it does (#1159).

**The repo is bind-mounted, and that is a decision.** `_build/`,
`deps/`, `.mix/` and `.hex/` all live inside the bind-mounted tree.
Named volumes used to shadow them, to protect against host-arch artifact
contamination — but the host never runs `mix` ("the container IS the
runtime"), so there is nothing to contaminate. Bind mounts also dodge the
permission trap below. `mix phx.server` reads compiled artifacts from the
mounted tree on every boot, which is what lets a `git pull` plus an admin
reload POST swap modules without restarting the container. See also
"Toolchain image (#364 docker S1)" above: nothing is baked into the
image, because the mount would shadow it.

**The named-volume-as-root vs container-as-UID-1000 `EACCES` trap.** The
containers drop to UID 1000 so that writes into bind-mounted host
directories (`node_modules`, `bun.lock`) do not land as root on the host
filesystem. A fresh Docker *named* volume, by contrast, is created
`root:root`. Put the two together and the build dies at Vite's
prepare-out-dir step with `EACCES` on copyfile to `/app/dist/`. A host
bind-mount plus the deploy scripts' `mkdir -p` (whose ownership inherits
the operator's UID, 1000 on the canonical deployment) sidesteps the
collision and leaves `dist/` inspectable from the host. The same rule
governs the `cicchetto-build` service's `tmpfs`: its `uid`/`gid` MUST
track the service's `user:` field, because bun writes to `HOME=/tmp`. A
hardcoded `uid=1000` while `CONTAINER_UID` is something else fails every
write with `EACCES`, `bun install && bun run build` never completes, and
the `depends_on: service_completed_successfully` hangs the whole deploy.

**`CIC_BUILD_OUT` — never build into the directory being served
(#1020).** Vite empties `dist/` before it writes, and
`./runtime/cicchetto-dist` is the directory the BEAM serves *per
request*. Pointing the build mount straight at it made every deploy
serve an empty SPA for the entire duration of the build. The deploy
wrappers (`scripts/deploy.sh`, `scripts/deploy-cic.sh`,
`infra/docker/deploy.sh`) therefore set `CIC_BUILD_OUT` to a staging
sibling and rename it into place afterwards — one env var rather than a
second service, so there is still exactly ONE build definition. The
DEFAULT deliberately stays the served directory: it is what a bare
`compose --profile prod up` uses via grappa's `depends_on`, and there
nothing is serving yet, so there is no live window to protect.

**Two forms of env forwarding, and the difference is load-bearing.**
Most keys use the empty-default form, so they stay unset in dev (where
`config/dev.exs` covers them) and `config/runtime.exs` raises in prod if
the host shell or `.env` supplies nothing. `POOL_SIZE`, `PORT` and
`LOG_LEVEL` carry LITERAL defaults instead: the empty-default form
forwards `""`, which reaches `String.to_integer/1` and crashes at boot.
Before #369 X1 those three keys were absent from compose altogether, so
a `.env` override was a silent no-op — compose never forwarded the host
variable at all. A new numeric or enum knob takes a literal default.

**Use `:-`, not `:?`, in this file.** Compose interpolates `compose.yaml`
for EVERY command, including ones that have nothing to do with the
profile a variable belongs to, so a `:?` would abort them all. Left
unset, a value is passed through empty and the service fails at the
point of use — which is a worse error message but a working `compose
config`. `GRAPPA_VERSION` is the deliberate example: empty makes vite
fail loud rather than bake a blank `<meta cicchetto-version>`.

**`start_period: 180s` is sized for the first boot on a fresh clone**,
which fetches deps and then compiles from the bind-mounted source with
no `_build/${MIX_ENV}/` cached on host disk. `start_period` only
suppresses failure-counting during that window; the healthy flip still
happens on the first `/healthz` 200. Warm reboots finish in seconds.

**`depends_on: … required: false`** on `cicchetto-build`: the oneshot is
prod-profile-gated, so under a plain dev `docker compose up` it is not in
the active profile (vite serves cic there) and grappa must start anyway.
The deploy wrappers run the build explicitly first; this `depends_on` is
the safety net for a hand-run `--profile prod up`.

**`compose.oneshot.yaml`** is layered on top by `scripts/_lib.sh`
`in_oneshot()` for ephemeral mix tasks. `container_name: !reset null`
lets compose generate a unique name per run, so several oneshots can run
concurrently and none collides with the long-lived `grappa` container;
`ports: !reset []` drops every host-side publish from the base file and
from any personal `compose.override.yaml`, which is safe because a
oneshot boots Phoenix on port 4002 bound inside the container and nothing
external connects in.

**Base images are digest-pinned (#103 supply-chain).** Refresh a pin only
on an intentional bump:

```
docker buildx imagetools inspect oven/bun:1 --format '{{.Manifest.Digest}}'
```

`test/infra/base_image_digest_pin_test.bats` fails the build if any real
image reference in a tracked build file loses its `@sha256:`.

## The two images: Dockerfile (toolchain) vs Dockerfile.release

They are two images with two roles, and conflating them is the mistake
this section exists to prevent.

`Dockerfile` is the single-stage **toolchain** image — dev = prod = CI =
one path. It bind-mounts the repo, boots `mix phx.server`, and HAS
`Phoenix.CodeReloader`. The release build was dropped from it
deliberately (CP23 `cluster/code-reload`) precisely so that running
sessions can be hot-deployed.

`Dockerfile.release` is the self-contained **release** image published to
ghcr.io (#503 unit C): bundled ERTS, compiled beams and the built
cicchetto SPA, and nothing to compile with — no Elixir, no mix, no
source, no code reloader, no inotify. It boots `bin/grappa start`, and a
hot update swaps beams into `lib/grappa-<vsn>/ebin` and fires
`Grappa.HotReload` (unit E), never the dev reloader. Do not expect the
compose hot-edit loop from it. `code_reloader: true` survives in the prod
Endpoint config and is harmless in a release — the reasoning is in
DESIGN_NOTES 2026-07-31, "#503 unit C".

**Base image: `elixir:1.19-otp-28-alpine` (Docker Hub official).** The
earlier multi-stage debian build used
`hexpm/elixir:VSN-erlang-VSN-debian-VSN` for tighter tuple pinning, but
`hexpm/elixir` does NOT publish alpine variants for Elixir 1.19 / OTP 28,
so the official image is the upstream-supported alpine path. Elixir and
OTP stay pinned by the tag; the alpine version floats with whatever the
Docker library publishes for it.

**Do not add a deps layer to the toolchain image.** It is toolchain-ONLY
by design (#364 docker S1, described above): every runtime shape mounts
the repo over `/app`, and `MIX_HOME`, `HEX_HOME`, `deps/` and `_build/`
all live under `/app`, so any baked `mix local.hex` / `COPY mix.exs
mix.lock` / `mix deps.get` / `mix compile` layer is fully shadowed at
runtime. It buys nothing — it cannot seed the host tree — and last time
it was there it made every `docker compose build` re-run C-NIF dep
compilation, invalidated the `COPY . .` layer on any repo edit, and made
the clone-and-go claim false.

**`alpine:3.24` in the release runtime stage is a FLOOR, not a mirror of
the build base.** `elixir:1.19-otp-28-alpine` resolves to *different*
alpine minors per architecture at the same instant (amd64 3.23, arm64
3.24) and the tag floats, so no single runtime minor could ever "match"
it — and the minor is cosmetic anyway, since 3.23 and 3.24 share musl 1.x
and openssl 3.x. What matters is the ABI contract, which the in-image
gate proves: the same musl and openssl SONAME majors, and a runtime never
older than what the release linked against (musl has no symbol
versioning, so build-new/run-old can miss symbols). The floor is chosen
at or above the newest build-base minor across architectures and still
floats within its patch line, so security fixes flow. When a build base
outgrows it, the gate fails loud — that is the signal to bump the floor.
Gate logic lives in `infra/docker/assert-abi-lockstep.sh`, pinned by
`test/infra/abi_lockstep_test.bats`.

**Why `bash` is in a release image at all.** It runs
`infra/packaging/gen-secrets.sh`, the ONE secret generator (#862).
Alpine's `/bin/sh` is busybox ash, which has no `trap … RETURN`, and the
generator also leans on `set -o pipefail` to catch a failed `openssl`
mid-pipeline, which Debian's dash (the `.deb` host's `/bin/sh`) lacks.
Both could be worked around by POSIX-ifying the generator — at the cost
of dropping `pipefail` from the script that writes the Cloak key.
Shipping 1.6 MB of shell is cheaper and safer than forking or weakening
it. The entrypoint resolves the generator as `dirname $0`, so
`release-entrypoint.sh` and `gen-secrets.sh` MUST stay siblings in
`/app`.

**Secrets are never baked into the image.** Baking them would ship one
identical Cloak key and `SECRET_KEY_BASE` to every puller. They are
generated per-install on the `/data` volume by the entrypoint's
first-boot bootstrap (#862), and anything the operator supplies via `-e`
or `--env-file` wins and is never overwritten. `PHX_HOST` is the one
exception — it cannot be invented, so a bare `docker run` still raises in
`config/runtime.exs` for that alone.

**Build-sequence facts worth not rediscovering.** `VERSION` is COPYed
alongside `mix.exs` because `mix.exs` reads it at project-eval time, so
every mix task needs it present, `deps.get` included (#652). Compile and
assemble happen in ONE `mix compile`; a separate `mix deps.compile` step
was dropped because `mix compile` compiles the deps anyway and the extra
step only added an emulation-heavy pass under the arm64 QEMU leg. `.git`
is excluded by `.dockerignore`, so `Grappa.Version` takes its no-git path
and the artifact reports the bare `X.Y.Z`, the same path the AUR source
tarball uses (#391); the release CI checks out the release tag and
asserts `tag == VERSION` (#652), so the bare version equals the tag, and
the #542 version-sha guard logs its no-git skip and proceeds.

## The Docker deploy driver (infra/docker/)

Four files, four audiences. `deploy.sh` is the verb-dispatched driver an
operator runs on a vanilla single-host Docker box; `get.sh` is the
`curl | bash` bootstrap that lays `deploy.sh` onto a host with no
checkout; `release-entrypoint.sh` runs INSIDE the published ghcr image;
`assert-abi-lockstep.sh` runs at image BUILD time. Each file now says
only what it does — this section is the why (#1159).

Read it alongside the three sections that own the neighbouring
machinery, which it does not repeat: § "The shared deploy library
(`infra/lib/`)" owns the hot-vs-cold algorithm, the dist-swap mechanics
and the BEAM-readiness wait; § "Running the published image (`docker
run` / `curl | bash`) — #503 unit D" is the OPERATOR runbook for the
release-image path (knobs, one-liners, what `update` does); § "The two
images: `Dockerfile` (toolchain) vs `Dockerfile.release`" owns the
image shapes and the ABI floor argument.

**What `deploy.sh` replaced, and what the shared `update` verb won
(#503 unit B).** It is ONE entry point for the vanilla single-host
Docker box, in place of the three `scripts/quickstart*.sh` scripts —
now thin deprecated forwarders that `exec` into it. The win is the
`update` verb: it classifies hot-vs-cold through
`infra/lib/deploy_common.sh`, the same algorithm driving the jail, the
native Linux host and the operator-Docker substrates, where
`quickstart-update.sh` ALWAYS recreated the stack off a hand-maintained
regex table. The bare (verbless) form is the idempotent "make it so" —
no `.env` on disk means not installed, so it installs; otherwise it
updates. That is the single command a `curl | bash` one-liner (unit D)
can always run.

**One script, two substrates, and the source tree is the
discriminator.** A real checkout runs the SOURCE path: bind-mounted dev
image, `docker compose`, hot-on-HOT. A checkout-less host — the
`curl | bash` one-liner, or anyone driving the published ghcr image —
runs the RELEASE-IMAGE path: no source, no compose, no mix, plain
`docker` against `ghcr.io/vjt/grappa`, COLD-only updates (hot-on-image
is #503 unit E). The discriminator is `compose.yaml` two levels up
(`infra/docker/` → repo root): a real checkout has it, a curl'd copy
sitting in `$GRAPPA_HOME` does not. `GRAPPA_DEPLOY_MODE=source|release`
forces the choice, for tests and for operators who want no guessing.

In release mode all state — the prod env file, with every secret —
lives per-user under `$GRAPPA_HOME` so the `update` verb finds the box
`install` created, and `/data` is a named docker volume. Nothing is
written into a checkout, because there is none.

**`PHX_HOST` is load-bearing, and three separate mechanisms exist to
stop it going wrong (#468).** It is the source of the host-alias set
the app derives upload links and origin checks from
(`lib/grappa/http_hosts.ex`), so a box serving under a real name while
`.env` still says `localhost` mints links pointing at the wrong host
and rejects every WebSocket handshake on `Origin` — silently. Hence:

- `force_env` (as opposed to `set_env`) is used ONLY for what the
  caller passed on THIS run. A second run with a different `PHX_HOST`
  must actually move the box, not silently keep the first run's
  hostname.
- A `.env` copied from `.env.example` carries the example's hostname,
  which is someone else's host. Inheriting it is the copy-trap;
  whatever the current run resolved to wins over it.
- In release mode the value comes from the `PHX_HOST` env var (the
  non-interactive path a piped one-liner uses), else from a prompt on
  the CONTROLLING TERMINAL (`$GRAPPA_TTY`, default `/dev/tty`). A
  `curl … | bash` one-liner binds stdin to the SCRIPT, so a bare `read`
  would eat the script text or hit EOF. With neither a value nor a
  usable tty (CI, a non-interactive pipeline) it FAILS LOUD with the
  exact fix rather than defaulting to `localhost`.

**The cic bundle's version input is derived at each launch point, never
once at startup (#538/#652/#692).** vite bakes `GRAPPA_VERSION` into
`<meta cicchetto-version>` and REFUSES to build without it rather than
ship a bundle that lies about its version; the `cicchetto-build`
container mounts only `./cicchetto`, so it cannot read the repo-root
`VERSION` itself — `export_cic_version` derives it and compose passes
it through. Calling it once at startup would be wrong twice. `update`
pulls BEFORE it builds, so a startup derive stamps the bundle with the
version the box was ALREADY on: exactly the staleness #652 exists to
prevent, and invisible, because the build still succeeds. And `stop`
must not depend on a readable `VERSION` — a box you cannot bring down
because a file went missing is the trap `cmd_stop` is written to avoid.

**One box per host, because `container_name` belongs to the daemon.**
`compose.yaml` pins `container_name`, so those names belong to the
docker daemon and not to a compose project. A second checkout operating
its own box collides with the first, and docker's own error — "The
container name /grappa is already in use" — names neither the owner nor
the fix. `assert_box_ownership` asks each pinned container who owns it
(the compose working-dir label) and refuses before anything has
happened, naming the other checkout. The release path has the same
guard in miniature: an existing container on `$GRAPPA_CONTAINER` means
an existing install, and `install` refuses.

**Pre-#485 boxes carry an nginx-shaped `.env` (#485).** A box created
by a checkout older than #485 has `NGINX_PUBLISH=<host>:80` (the
LAN-facing nginx container) plus `GRAPPA_PUBLISH=127.0.0.1:4000`
(grappa behind it). nginx is gone, so grappa must take over that LAN
binding — `migrate_publish_env` rewrites `.env` in place, on `update`
only. `install` deliberately does NOT migrate the port binding: it
would leave grappa on the loopback default and silently orphan the old
LAN URL, so it warns and points at the upgrade path instead. `stop`
passes `--remove-orphans` for the same generation of box: a stale
`grappa-nginx` was removed from `compose.yaml` but is not stopped by a
plain `down`, and it holds the project network open.

**The `install` seed: admin by default, themes outside the user block
(#475).** A seeded account gets the admin bit by DEFAULT, because the
admin console is the only place some install-level switches live
(visitor access) — a box seeded without it cannot be finished from the
UI it hands you. `SEED_ADMIN=0` is for a box that should deliberately
start with no administrator. The built-in theme gallery is seeded
OUTSIDE the `SEED_USER` block: the curated gallery is a property of the
install, so a box with no seeded user still ships its themes. It is
idempotent (upsert on `(system owner, name)`) and non-fatal — an empty
gallery is cosmetic, not worth failing a healthy install over. The same
posture covers both seed steps on a re-run: neither task is destructive
(duplicate name / existing credential both fail), so a failure
downgrades to a note instead of aborting a healthy box.

**Two docker-specific reasons `update` forces cold when the operator
left it on auto.** A stopped stack cannot be hot-reloaded — this is
also the start-again-after-stop path, which `stop`'s own banner points
at — and `--no-pull` deploys the working tree, whose empty `prev..new`
range preflight cannot classify. A recreate is never wrong (unlike a
hot reload), so both force cold. Everything else is classified by
`Grappa.Deploy.Preflight` with substrate `"docker"`, the same source of
truth the operator and native substrates use; see § "Hot vs cold
deploy — when each path triggers".

**The reload hook's stdout is a protocol, not chatter.** The shared lib
captures `substrate_reload`'s stdout as the reload response body, so
every pre-reload message MUST go to stderr — otherwise it pollutes the
JSON that the lib's `"failed":[]` honesty glob inspects, and a real
`:old_code_in_use` refusal can be missed.

**The cic bundle is built beside and renamed in, never in place
(#1020).** The BEAM serves `runtime/cicchetto-dist` per request and
vite empties its `outDir` first, so building in place blanked the SPA
for the whole duration of the build — on a box that is UPDATING, i.e.
one that is already live. `substrate_cic` builds into a staging sibling
and promotes it with a rename; the helpers themselves and the
promote/rollback semantics belong to § "The shared deploy library
(`infra/lib/`)". `infra/lib/cic_dist.sh` is sourced inside `cmd_update`
rather than at the top of the file, and that is deliberate: only source
mode builds a bundle (the release path ships a prebuilt image), so the
`get.sh` mirror — which reproduces exactly what a checkout-less host
sources — needs no extra file.

**Release mode passes `GRAPPA_AUTO_MIGRATE=0`, and that flag is the
whole ordering decision (#867).** The image's entrypoint migrates on
boot by default because a bare `docker run` has no other door to the
migrator. This path HAS one and already uses it: `release_migrate` runs
from the host, before the container is recreated, which is the ordering
a schema change needs. Saying so explicitly keeps the decision in ONE
place per path — without it, a crash-looping old container could
restart INTO a migration while `release_migrate` is running, and two
BEAMs migrating one sqlite file is corruption, not contention. The
theme seed goes through the same door for the same reason: the image
ships no Mix, so it runs as `… eval 'Grappa.Release.seed_themes()'`,
and the entrypoint deliberately does not migrate on an `eval` verb — so
that is exactly one BEAM doing exactly the seed.

**REFUTED, and kept refuted on purpose: "host openssl cannot safely
reproduce a raw P-256 point" (#862).** `write_env_file` used to
transcribe four `openssl rand` calls of its own and spend a throwaway
`--env-file` plus a whole `docker run … eval` on the VAPID pair, on
that stated ground. The claim is FALSE:
`test/infra/gen_secrets_test.bats` re-derives the public point from the
generator's own scalar and requires a byte-exact match. Two openssl
transcriptions of the same six secrets is precisely the drift #862
removed — `infra/packaging/gen-secrets.sh` is the ONE generator. This
paragraph exists so nobody re-derives the refuted argument and adds the
second transcription back.

### `get.sh` — the `curl | bash` mirror

**What it mirrors, and the invariant that keeps the mirror honest.** It
lays down the files the release-image deploy path needs — today
`infra/lib/deploy_common.sh`, `infra/packaging/gen-secrets.sh` and
`infra/docker/deploy.sh` — into `$GRAPPA_HOME`, then hands off to
`deploy.sh` in RELEASE mode with the requested verb (default: the bare
install-or-update). Everything else — secret generation, the `PHX_HOST`
prompt, the data volume, the COLD-only update — is `deploy.sh`'s job;
this script only lays down files and `exec`s. The invariant is NOT the
file count (it was "two shell files" until `gen-secrets.sh` joined):
**whatever `deploy.sh` resolves relative to ITSELF must be mirrored at
the same relative layout**, because `deploy.sh` sources
`$SELF_DIR/../lib/deploy_common.sh` and resolves the generator at
`../packaging/`. Re-running re-downloads every file first, so a box
always updates against the latest deploy machinery.

**`gen-secrets.sh` is fetched eagerly, not lazily (#862).**
`deploy.sh` refuses to write an env file without it, so a lazy fetch
would only move the failure later, onto a half-installed box.

**The `curl` check comes before any file is written.** `curl` is what
fetched THIS script, so in the piped one-liner it is definitionally
present — but a hand-run `get.sh` may not have it. Checking first,
before a single file is touched, makes the failure one honest line
instead of a cryptic half-written mirror.

**RELEASE mode is forced on hand-off.** A curl'd copy in
`$GRAPPA_HOME` has no `compose.yaml` two levels up, so `deploy.sh`'s
auto-detect would land there anyway; forcing it means an odd layout can
never flip a checkout-less host into source mode.

**Updates on this path are ALWAYS cold (#503 unit E).** The release
image ships no `CodeReloader`, so a recreate is the only safe verdict;
`deploy.sh`'s done-banner states which kind of update it performed.

### `release-entrypoint.sh` — inside the published image

**`bin/start.sh` cannot be reused verbatim.** It self-heals hex + deps
and ends in `exec mix phx.server`, and none of that exists in a
self-contained release — no mix, no source. The entrypoint is the
release twin of the same rationale: it mirrors `bin/start.sh`'s BEAM
resource caps (the Docker-specific fix), bootstraps the prod secrets on
first boot (#862), migrates (#867), then execs the release.

**Why the caps exist at all — the numbers are not re-derivable from the
code.** Docker on Linux 6.x inherits `NOFILE = 2^30`, so WITHOUT a `+Q`
cap the BEAM sizes its port table at `min(ulimit -n, 2^27-1)` ≈ 134M
ports and reserves roughly **1.5 GB of `ll_alloc` carrier at boot**;
`+SDio` separately defaults to a fixed 10 dirty-IO scheduler threads
regardless of CPU count. Same knobs and same ratios as `bin/start.sh`
(see its header for the per-user derivation).

**The caps travel via `ERL_ZFLAGS`, not a baked `rel/vm.args`.**
`ERL_ZFLAGS` is honored by `erlexec` for a `mix release` start, and it
is APPENDED to — never clobbers — any operator value. A `rel/vm.args`
would ship inside the release and so change the jail, `.deb` and `.rpm`
consumers too, and these caps are THIS image's concern. That is the
same reasoning the boot-time migration switch below uses for living in
the entrypoint rather than in `Grappa.Application`.

**The `/data` ownership split.** On a fresh anonymous `/data` volume
Docker inherits the image's `grappa` ownership, so the entrypoint's
`mkdir -p` succeeds; a root-owned BIND mount is the operator's to
`chown` (see § "Running the published image" for the operator side).

**The first-boot secret bootstrap, and why its three rules are in that
order (#862).** The image ships no secrets on purpose, and before #862
nothing on the bare `docker run <image> start` path ever generated any:
the operator got a config-provider stacktrace pointing at
`scripts/mix.sh`, a script this image does not contain. The entrypoint
now fills whatever `runtime.exs` would raise on, using the SAME
generator the `.deb`/`.rpm` hosts run (`infra/packaging/gen-secrets.sh`
— openssl-only, no BEAM, idempotent; it is bash, not the busybox ash
running the entrypoint, because it leans on `set -o pipefail` and
`trap … RETURN`). The three rules are ordered by how much they can
hurt:

1. **OPERATOR ENV WINS.** Only vars absent (or empty) in the container
   env are taken from the file, so `-e SECRET_KEY_BASE=…` and
   `--env-file` behave exactly as before. When the environment already
   carries all of them — `deploy.sh`'s `--env-file` install — nothing
   is generated and `/data` is not touched at all.
2. **NEVER ROTATE.** The file lives on the `/data` VOLUME, beside the
   DB, so it follows a relocated `DATABASE_PATH`, and the generator
   only fills blanks. Re-rolling `SECRET_KEY_BASE` would log every user
   out; re-rolling `GRAPPA_ENCRYPTION_KEY` would make every
   Cloak-encrypted upstream credential undecryptable — data loss, not
   an inconvenience. A restart MUST reuse the file byte-for-byte.
3. **`PHX_HOST` IS NOT INVENTABLE.** It stays the operator's, so a bare
   run still fails — for that one variable, with the message
   `config/runtime.exs` now words for every install flavour.

**Boot-time migration: the bug, where the switch lives, and why the
default is ON (#867).** With #862's secrets in place the documented
one-liner got one step further and died on `no such table:
admin_events` — the image ships the migrator (`eval
'Grappa.Release.migrate()'`) but nothing on the bare-run path ever
invoked it, and the operator has no other door: no mix, no checkout, no
deploy script inside the image.

WHERE the switch lives, and why here and not in the BEAM: this
entrypoint exists ONLY for this image. The jail, the `.deb`/`.rpm`
hosts and the linux systemd box each migrate deliberately from their
own deploy script, BEFORE swapping code — ordering that is load-bearing
for a hot deploy (#41: only "expand" migrations are hot-safe). An
auto-migrate inside `Grappa.Application` would change all of them at
once.

WHY the default is ON: the only shipped consumers of THIS image are
single-container — the bare `docker run` of the docs, and
`infra/docker/deploy.sh` in release mode (one container name, one named
volume). Two BEAMs sharing one sqlite file is not a supported topology
with or without migrations, so defaulting OFF would break the
documented path in order to protect a path that is already broken.
**This is NOT a claim that concurrent starts are safe: they are not,
and nothing here serialises them.** `GRAPPA_AUTO_MIGRATE=0` is the door
out, and `deploy.sh` passes exactly that on its `docker run`. Unknown
values are REJECTED rather than guessed — reading `true` as false would
silently reinstate the very bug this closes.

**Log honesty in the migrate line.** It prints "checking", not
"applying": an up-to-date DB applies nothing and the migrator stays
silent, and claiming work we did not do is the log-honesty rule in
`CLAUDE.md`.

### `assert-abi-lockstep.sh` — the build-time ABI gate

The gate runs as a `RUN` line in `Dockerfile.release` (#503 unit C).
Why the runtime stage's `alpine` pin is a FLOOR rather than a mirror of
the build base is argued in § "The two images: `Dockerfile` (toolchain)
vs `Dockerfile.release`"; this is what the gate actually compares, and
why each comparison exists.

**The alpine MINOR is a cosmetic label, not the ABI contract.** 3.23
and 3.24 both ship musl 1.x + openssl 3.x, and the
`elixir:…-alpine` build base resolves to DIFFERENT minors per
architecture at the same instant (amd64 3.23, arm64 3.24). A naive
build-vs-runtime minor compare is therefore BOTH a false positive (it
fails a safe pairing) and a false negative (it passes a dangerous one).
The real contract is the linked SONAMEs plus their versions — eight
values in, one verdict out. The numbering below is the numbering
carried inline in the file (`1 + 2:`, `3:`, `4:`):

1. **Identical musl SONAME major.** A musl major bump
   (`libc.musl-*.so.1` → `.so.2`) breaks the bundled ERTS's link in
   either direction.
2. **Identical openssl SONAME major.** A `libcrypto`/`libssl` SONAME
   bump (`.so.3` → `.so.4`) breaks the crypto NIF's link in either
   direction.
3. **Runtime musl NEVER older than build.** musl has NO symbol
   versioning, so a binary linked against a newer musl may reference
   symbols absent from an older one: build-new/run-old is the dangerous
   direction, run-new/build-old is safe. The asymmetry is why rules 3
   and 4 are inequalities and rules 1 and 2 are equalities.
4. **Runtime openssl NEVER older than build**, same reasoning.

**It is a pure decision function.** Eight values in, verdict out — no
image inspection, no docker, no side effects, which is what makes it
testable off-image; `test/infra/abi_lockstep_test.bats` pins it.
Version ordering defers to `apk version -t`, the canonical alpine
comparator: this file never hand-rolls a version parse. The calling
contract (the `usage:` block and the exit-code table, `2` =
usage/extraction failure and never a silent pass) stays in the file
itself, because that is what a `Dockerfile` `RUN` line must get right.

## The shared deploy library (infra/lib/)

Three POSIX-sh files under `infra/lib/` carry the parts of the deploy
that must be identical everywhere: `deploy_common.sh` (the hot-vs-cold
deploy algorithm, #503), `beam_wait.sh` (the BEAM stop/start race
killer, #923) and `cic_dist.sh` (the SPA bundle swap, #1020). All three
are SOURCED, never executed, and all three are strict POSIX sh — no
bash arrays, no `[[ ]]`, no `local` — so the FreeBSD jail's `/bin/sh`
can run them. Consumers keep their own shebangs and may use bashisms in
their own hooks. This section is the WHY behind those files; the files
themselves say only what they do (#1159).

**A fourth file, `deploy_docker.sh`, is deliberately NOT POSIX (#1384).**
It holds the Docker substrate's thirteen `substrate_*` hooks, shared by
the two entry points onto that substrate — `scripts/deploy.sh` and
`infra/docker/deploy.sh update` — and it takes the compose invocation as
a bash ARRAY, because that is what both callers already have (the
operator door's carries the host's `compose.override.yaml`). The POSIX
rule exists so the jail's `/bin/sh` can source these files; the jail
never sources this one, and nothing else on a Docker box runs `sh`. It
declares `# shellcheck shell=bash`, which is also how
`scripts/posix-parse.sh` derives its set — the gate reads the declared
dialect, so the file is excluded by saying what it is rather than by an
exception list someone has to maintain.

**That claim is gated, and over a DERIVED set (#1377).**
`scripts/posix-parse.sh` runs `dash -n` over every file under `bin/`,
`infra/` and `scripts/` whose first line declares the sh dialect — a
`#!/bin/sh`-family shebang, or the `# shellcheck shell=sh` directive
these three libs use in place of one. Twenty-eight files today; the
hand-written list in `ci.yml` it replaced named five, and two of the
three libs above were not among them. `dash -n` checks GRAMMAR only
(`arr=(a b)` is a syntax error; `[[ ]]` and `local` parse fine and fail
at run time) — shellcheck's sh dialect, over the same files, is what
covers the rest.

**Why a shared library exists at all: the 2026-06-11 outage.** Before
#503 each substrate had its own near-identical deploy script, and the
three had drifted. The post-mortem numbered three defects — #7, #8 and
#9 (that post-mortem's own numbering, not GitHub issues; the same
labels are used in "Hot vs cold deploy" above) — and every one of them
had the same shape: *fixed in one script, still live in another*. The
extraction is the fix for the class, not for the three instances. The
rule it encodes: an algorithm that more than one substrate must get
right lives in `infra/lib/`, and a substrate contributes only the 20%
that genuinely differs.

### What the library owns, and what a substrate owns

**The lib owns everything substrate-independent**: flag parse, the
`DEPLOY_PREV_SHA` carry across re-exec, the re-exec guard, the marker
base-select and validation, the nothing-to-do predicate, the preflight
verdict→mode mapping, the reload `"failed":[]` honesty check, the
healthcheck loop, and the marker write. Every one of those is a
documented invariant that previously lived — and drifted — per script.
The consumer supplies hooks (`substrate_pull`, `substrate_build`,
`substrate_reload`, `substrate_migrate`, `substrate_restart`, …); the
hook list in the file header is the API, because hook names are only
ever called indirectly and nothing about them is greppable from a
consumer. `substrate_done_banner` is a hook rather than a shared
`printf` because the wording is genuinely substrate-specific: sessions
preserved (jail hot), container recreated (Docker), daemon respawned
(systemd).

**Consumers of `deploy_common.sh`** are `scripts/deploy.sh` (operator
Docker), `infra/docker/deploy.sh` (standalone / published-image
install, plus the `get.sh` bootstrap that fetches it),
`infra/linux/deploy.sh` (systemd host) and `infra/freebsd/deploy.sh`
(m42 bastille jail). The release-image path is a fifth *role* rather
than a fifth script: it is always COLD and never shells out to
preflight — see "Hot vs cold deploy" above.

**Per-mode healthcheck retries are an override, not a second loop.**
`HOT_HEALTHCHECK_*` / `COLD_HEALTHCHECK_*` are resolved at loop time
and fall back to the shared `HEALTHCHECK_*` defaults, so a consumer
sets only what actually diverges. The jail and the Linux host leave
them unset; Docker is the one substrate with a genuinely short hot
loop and a long cold one (image rebuild plus recreate).

### Capability toggles versus the one correctness toggle (#440)

Every `DEPLOY_FEATURE_*` toggle except one defaults OFF and the
consumer opts in, because each names a CAPABILITY a substrate may
legitimately lack: no marker, no `--defer-restart`, no re-exec guard.
**Seeding is not a capability, it is a correctness property (#440), so
`DEPLOY_FEATURE_SEED` defaults ON and a substrate would have to opt
OUT.** Defaulting it off would rebuild the very defect #440 reports: a
substrate that silently forgets to seed. For the same reason there is
deliberately NO fallback `substrate_seed` — a consumer that fails to
define the hook must break loudly in CI, not quietly seed nothing.

### The re-exec guard — a script that pulls its own replacement

**`git pull` replaces files by rename, so a running interpreter keeps
executing PRE-PULL bytes from the old inode.** Without a guard, a fix
to the deploy pipeline silently no-ops on the first deploy that ships
it, and only takes effect on the second (live-repro 2026-05-31). The
guard re-execs after the pull so the NEW bytes run downstream of it.

Detection is by DIFF RANGE touching the consumer script OR the shared
lib — the lib appends its own path (`DEPLOY_LIB_REL`) precisely so a
change to the shared algorithm re-execs too; the extracted bytes must
reload exactly as the inlined bytes did. The range is the PRE-PULL one
(`prev..new`), NOT the marker range: the question being asked is "did
THIS pull change the bytes I am running?", to which the marker is
irrelevant.

Two details are load-bearing on re-exec. `DEPLOY_REEXEC_PREFIX` carries
the verb for a verb-dispatched consumer (`infra/docker/deploy.sh
update …`), or the re-exec drops it and the second run falls through
to a usage error. `DEPLOY_PREV_SHA` carries the FIRST invocation's
pre-pull SHA, because the re-exec'd run re-pulls a no-op — its own
`prev == new`, and the nothing-to-do check would wrongly exit 0.

### The marker, and what "nothing to do" is allowed to mean

**"No new commits" is not enough to skip a deploy (defect #8).** The
fast path exits 0 ONLY when the mode is auto AND there are no new
commits AND the last deploy COMPLETED (marker == HEAD). Bare "no new
commits" lies when a prior deploy died mid-flight, and an explicit
`--force-*` is an operator order, not a heuristic input. This is the
general rule from CLAUDE.md applied to a deploy script: a fast path
states what it OBSERVED, not what it did.

**A present-but-garbage marker aborts loudly rather than falling back
(defect #7).** Silently falling back to the pre-pull SHA would re-open
the range hole the marker closes, and feeding garbage to `git diff`
would crash the preflight oneshot with an opaque exit 1 that the
verdict case-statement cannot interpret. Only an ABSENT marker falls
back. The marker's role as the preflight range base, and why a cic-only
deploy makes pre-pull HEAD the wrong base, are in "Hot vs cold deploy"
above.

### Classification sees changed PATHS only (#440 / #646)

**This is the shared root of two hooks, and the reason both run on BOTH
deploy paths and must both be idempotent.** `Grappa.Deploy.Preflight`
classifies a diff — it can only ever reason about files that changed.
Anything whose staleness is not expressed as a changed path is
invisible to it:

- `substrate_reconcile` installs artifacts the substrate keeps OUTSIDE
  the repo (the source-alias privilege wrapper and the config it
  reads). The config is rendered from the DB, so it has no path to
  classify at all; and charging a session-dropping cold restart just to
  copy a file would be the wrong trade even when there IS a path
  (#646). Shipping #610 left the old wrapper installed in prod and
  disarmed mode 2 — that is the incident. So reconcile runs on both
  paths, after the build and before either the reload or the restart,
  so the new code never meets the old artifact.
- `substrate_seed` materialises versioned built-in data (the theme
  gallery) that used to be materialised ONCE, at install, so anything
  added later reached new installs only. Adding a built-in touches a
  plain lib module, which classifies HOT — seeding on the cold path
  alone would miss the very path that ships themes (#440). Same
  reasoning as reconcile, one layer down: no changed path tells the
  classifier that the seed set grew.

Both hooks therefore run every deploy, forever, and both MUST be
idempotent. "Hot vs cold deploy" above carries the per-substrate seed
doors and the schema-then-data ordering.

**A failed seed is non-fatal, and that is not a silent swallow.** On
the cold path the seed runs after the migration and before the restart,
so aborting there would leave a migrated DB, the old daemon still up,
and no restart — trading a stale gallery for a half-applied deploy. On
an always-on bouncer that is the worse of the two by a wide margin. The
failure is still reported: the completed-deploy marker is written only
after a 200, the upsert converges, so the next deploy re-runs the seed
and heals it. The warning is also re-asserted AFTER the ✓ banner —
a warning 200 lines up a build log is a warning nobody reads — and it
is gated on the OUTCOME, because a warning that fires every run means
nothing.

**On the hot path the seed lands after the reload, for two reasons.**
The first is the same schema-before-data ordering as the cold path:
since #41 the hot path is not migration-free, `POST /admin/reload`
applies pending expand migrations on the live pool and only THEN loads
modules (`Grappa.HotReload.migrate_and_reload/0`), so a seed placed
before it would run against the PRE-migration schema. The second is
that it lands after the reload-honesty check on purpose — a refused or
partly-failed reload exits above, and seeding into a deploy that did
not take is wasted work at best and confusing at worst.

**When the reload POST fails, the message names two causes, not one.**
Every `substrate_reload` uses `curl -f`, which discards the response
body on a non-2xx, so that branch knows the POST failed and nothing
about why. It prints both live causes: the daemon is down or
unreachable, OR it refused the hot reload — and HTTP 409 means a
pending CONTRACT migration, which is an instruction to run a cold
deploy (#41 added that second cause; before it the message asserted the
one we used to guess).

### Waiting for the BEAM (`beam_wait.sh`) — defect #9

**The 2026-06-11 outage, mechanism first.** A `service grappa restart`
started the new BEAM while the old node was still draining WebSocket
connections. The new node died at boot with *"the name grappa@grappa
seems to be in use by another Erlang node"*, and rc.d walked away
silent — the restart "succeeded" with nothing running. The rule: a
restart must not start the new BEAM until the old one has exited AND
epmd has released the node name. `beam_wait.sh` is the single
implementation of that wait, with two verbs: `wait-stopped` (block
until `beam.smp` is gone and the name is free, escalating) and
`wait-name-free` (block on the name only, NO escalation — it is the
pre-start guard, where the registered name may belong to a
still-draining old node that must not be shot).

**The drift argument, and why it is the strongest one in this
directory.** The wait was extracted for the same reason
`deploy_common.sh` was, but it had already begun to drift before anyone
noticed: `infra/linux/grappa_beam_wait.sh` described itself as a
"trimmed port" and had LOST the two escalation-safety comments that say
why pkill'ing epmd is only conditionally safe. The copy that dropped
the safety reasoning is exactly the copy that would one day drop the
safety. One algorithm, one test suite, no second place to fix a bug in.
`test/infra/beam_wait_test.bats` pins this: it asserts that
`grep -rl 'wait_name_free()' infra` matches exactly one file, matching
as a SUBSTRING so it also catches a re-copy under the pre-#923 name. A
third copy — or a doc that quotes the algorithm into `infra/` — trips
it.

**pkill'ing epmd is safe ONLY once the BEAM is confirmed dead.** Under
a live BEAM, killing epmd makes the BEAM respawn it and re-races the
registration (live-repro 2026-05-31). The escalation inside
`beam_wait_stopped` therefore fires only in the second loop, after the
first loop has established that no `beam.smp` is alive: at that point
the listing is a stale registration, nothing is alive to respawn epmd
mid-kill, and the next release start spawns a fresh one. `wait-name-free`
has no escalation at all, for the same reason inverted — it runs when a
live old node is the likeliest explanation for the name.

**The epmd-on-PATH probe lives in the entry point, not at source
time.** If `epmd` is not on PATH, every name check reads as "free" and
the wait silently degrades to BEAM-exit-only, so the probe warns
loudly. It must run after the consumer has set up its substrate config
(the jail pins the Erlang package's bin dir onto PATH), which is why it
sits in `beam_wait_main` — and also because a library that warns merely
because it was sourced is a footgun.

### Swapping the cic bundle (`cic_dist.sh`) — #1020

The premise — never build into the directory the BEAM serves, because
vite empties `outDir` before it writes — is argued in "The Docker
compose stack (`compose.yaml`)" above. `cic_dist.sh` is the mechanism
that implements the fix for every substrate: build into a sibling
nobody serves, then rename it into place. `--emptyOutDir` is not the
defect; the cleanup is wanted (vite emits content-hashed chunks, and
without it every deploy accretes the previous bundle's assets forever)
and the flag is only vite's consent prompt for an out-of-root `outDir`.
The TIMING is the defect.

Consumers are `infra/freebsd/jail_cic_build.sh`,
`infra/linux/cic_build.sh`, `scripts/deploy.sh`,
`scripts/deploy-cic.sh` and `infra/docker/deploy.sh`.
`infra/packaging/build.sh` is NOT a consumer: it already builds into a
staging tree under `staging/usr/share/grappa/` that no server is
serving — it is the shape this library generalises.

**Staged and served must be siblings.** Both live inside `runtime/` on
purpose: `rename(2)` cannot cross filesystems, and a cross-device `mv`
degrades to copy-then-delete, which is neither atomic nor fast. A
consumer that stages somewhere else loses the whole property. One
derivation (`cic_dist_staging`) produces the `<served>.next` name,
because every consumer needs it twice — once to aim the builder, once
to promote — and two spellings of it is a silent no-op deploy.

**The swap, and its failure window.** `mv` is `rename(2)`, atomic per
call, but there is no portable two-directory EXCHANGE (Linux's
`RENAME_EXCHANGE` is not reachable from sh, and FreeBSD has no
equivalent), so the promote is two renames:

```
mv <served> <served>.prev     # served path momentarily ABSENT
mv <staged> <served>
```

Between them the served path does not EXIST — `Plug.Static`'s `from:`
misses and requests fall through to the SPA history-fallback or a 404.
That window is two syscalls wide against the whole vite build it
replaces, and it is ENOENT rather than a half-written tree, so a client
gets either the old bundle or the new one, never a mix.

A related trap sits between the two renames: `mv a b` where `b` is an
EXISTING DIRECTORY moves `a` INSIDE `b`. The served path must therefore
be GONE — not emptied, gone — before the second rename, or the new
bundle lands at `<served>/<staged-basename>/` and the server keeps
serving the old one with no error anywhere.

**Die mid-swap and nothing is lost.** `<served>.prev` holds the
complete previous bundle and `<served>.next` the complete new one;
whichever rename landed, the next run starts by clearing `.prev` and
re-staging `.next`. Only a crash inside the microsecond gap leaves the
served path missing, and the fix is to re-run the build. The final
`rm -rf <served>.prev` is what keeps `--emptyOutDir`'s stale-chunk
cleanup: the old content-hashed assets go with the old directory
instead of accreting in the served one.

**A build that exits 0 having written nothing is the same outage,
moved later.** A wrong `outDir` or a plugin that swallowed its own
failure can produce an empty tree with a zero exit status, and
promoting that swaps emptiness into the served path. `cic_dist_promote`
therefore refuses unless `index.html` exists in the staged tree — the
one file the server must find (`Bundle.current_hash/0` parses it and
the history-fallback serves it) — and leaves the served tree untouched
on any refusal.

**`runtime/cicchetto-dist/.gitkeep` is planted BEFORE the swap, never
restored after it.** That file is TRACKED (it bakes the bind-mount
target so a fresh clone does not get it auto-created root-owned — see
`.gitignore`), so it belongs to the tree that LANDS. A post-hoc `touch`
would be a repair with a window of its own, and a tracked path missing
for even an instant is what once left a `D .gitkeep` in the working
tree, stalling the next `git pull --ff-only` on a deploy.

**Docker's staging dir has two traps of its own**, both re-introduced
by "simplifying" `cic_dist_docker_stage`: a compose bind-mount source
without a `./` or `/` prefix is parsed as a NAMED VOLUME rather than a
host path, and a directory Docker autocreates is root-owned, so the
UID-1000 container cannot write vite's output into it. The helper
pre-creates the directory and echoes it in the `./`-prefixed shape.

## The FreeBSD jail rails (infra/freebsd/)

**A "rail" is a named, checked-in script the m42 host is allowed to run
inside the production jail — and the set is closed on purpose.** The
host never reaches into the jail with a generic `jexec grappa sh -c
'…'`; every operation it can perform is one of the
`infra/freebsd/jail_*.sh` files, invoked as `sudo bastille cmd grappa
/home/grappa/grappa/infra/freebsd/<rail>.sh …`. That is what makes the
host→jail surface auditable: to know what prod can be told to do, read
the directory. Adding an operation means adding a rail and reviewing
it, not typing a new command at a prompt. The host-side caller
(`scripts/deploy-m42.sh`) and the ssh incantation are documented in
§ "m42 (FreeBSD bastille jail) — host-side wrapper"; the day-to-day
operator recipes in § "Running operator actions against the live jail
(prod)". This section is the rails' own contract and the traps each one
was paid for.

The current set:

| Rail | What it does |
| --- | --- |
| `deploy.sh` | the server deploy (hot/cold), a thin consumer of `infra/lib/deploy_common.sh` |
| `jail_deploy_cic.sh` | cic-only bundle deploy — pull, build, broadcast; never touches the BEAM |
| `jail_cic_build.sh` | the vite build itself (npm, as `grappa`) |
| `jail_beam_wait.sh` | block until the BEAM exits and epmd releases the node name |
| `jail_install_rcd.sh` | install/refresh the rc.d wrapper + `rc.conf.d/grappa` |
| `jail_install_source_alias.sh` | install the #543 mode-2 privilege wrapper + render its scope config from the DB |
| `jail_mix.sh` / `jail_release.sh` | run `mix …` / the release's `eval`/`rpc` as `grappa`, under the env file |
| `jail_db_query.sh` / `jail_db_write.sh` | sqlite3 against the prod DB as `grappa` |
| `jail_import_db.sh` | swap a DB file in (service must be stopped) |
| `jail_dns_check.sh` | resolve a hostname *from inside the BEAM* — the OS resolver can be fine while Erlang's `:inet_res` still holds a stale cache |
| `jail_git_pull.sh` | `git pull --ff-only` in the jail checkout |

### The rails' contract — three shapes, all deliberate

**(a) A named script in the repo, never an ad-hoc shell string.** See
above: the closed set *is* the security posture.

**(b) Every build step drops privilege.** A rail is invoked as root
(that is a property of `sudo bastille cmd`, not of what the rail does),
and root is spent only on the things that need it — `install -o root -g
wheel`, `service`, writing `/usr/local/etc`. Everything else runs
through `su -l grappa -c '…'`, so build artifacts stay grappa-owned and
a compile never runs as root. Two consequences worth remembering
before editing any rail: `su -l` **scrubs the environment**, so `PATH`,
`MIX_ENV`, `GRAPPA_VERSION` and friends must be re-exported *inside*
the login shell — dropping one of those re-exports breaks the build
silently; and rc(8)/root shells have no `/usr/local` paths, which is
why the Erlang bin dir is prepended explicitly. **That pin
(`/usr/local/lib/erlang28/bin`) exists at exactly three sites** —
`deploy.sh`'s `run_as_grappa`, `jail_beam_wait.sh`, `jail_mix.sh` — and
all three must move together the day the FreeBSD pkg becomes
`erlang29`. In `jail_beam_wait.sh` the pin is what keeps `epmd` on
PATH; without it the shared probe warns instead of silently degrading
to a BEAM-exit-only wait.

**(c) argv is reconstructed and handed over through a temp file, never
re-quoted into a shell string.** `bastille cmd <jail> <script> a b c`
invokes the script with `a` as `$0` (the script name is eaten), `b` as
`$1`, and so on, so every arg-taking rail restores the real argv with

```sh
case "$0" in
	*/jail_mix.sh|jail_mix.sh) : ;;   # invoked normally
	*) set -- "$0" "$@" ;;
esac
```

and then writes `"$@"` into a `mktemp` file that the `su -l` body reads
back. `jail_mix.sh`, `jail_release.sh`, `jail_db_query.sh`,
`jail_db_write.sh` and `jail_dns_check.sh` all carry the reconstruction;
the first four also use the temp file, which is a quoting/injection
decision as much as a convenience — the sqlite query reaches `sqlite3`
as `< "${QUERY_FILE}"`, so it never has to survive a round trip through
the outer shell's quoting.

**Generated artifacts carry auto-generated banners, and those banners
are product.** `jail_install_rcd.sh` writes `/etc/rc.conf.d/grappa` from
a heredoc, and `jail_install_source_alias.sh` writes
`/usr/local/etc/grappa/source-alias.conf` from a `printf`; the `#`
comment lines in both land verbatim on the production machine and tell
the next operator that a hand edit will be re-rendered. They are
operator-facing output, not code comments — leave them byte-identical.
**`test/infra/jail_install_source_alias_test.bats` greps only for
`^PREFIX=…$`**, so the banner line in the source-alias config is
unguarded: a test run will not notice if you drop it.

### Reconcile out-of-repo artifacts on EVERY deploy — never classify your way to correctness (#646)

**This is the one general ruling in this group. It reads jail-specific
and is not: it applies to any substrate that installs a file outside the
running application.**

The rule: if a deploy installs an artifact *outside* the checkout — a
privilege wrapper on `secure_path`, an rc.d script, a config file
rendered from the database — then that install must run on **every**
deploy, unconditionally, so the installed state is a pure function of
`(checkout, DB)`. Do not try to trigger it from a diff classification.

The incident that bought this: `jail_install_source_alias.sh` used to
live inside `jail_install_rcd.sh`, which the deploy invokes only from
`substrate_restart` — i.e. on COLD. No preflight class covers
`infra/freebsd/bin/*`, so a wrapper-only change classifies HOT and the
installer never ran. Shipping #610 (whose `arm_check` calls the new
`probe` subcommand) therefore left the **pre-#610 wrapper** installed:
every probe exited 64, mode 2 disarmed, and **44 visitors were rejected
in production** (#646).

Widening the cold classification was the obvious fix and is the wrong
one, for two independent reasons:

1. It would charge a **full session drop** — every IRC connection in
   the bouncer — to copy one file that the running BEAM never loads.
   The wrapper is exec'd fresh by `sudo` on each call; a restart buys
   nothing.
2. It would still miss the other half of the incident. The wrapper's
   scope config is derived from **`ServerSettings.static_mapping_prefix`
   in the DB**, not from a changed path, so no file-based verdict can
   ever detect that it drifted. A classifier cannot classify a diff
   that does not exist.

Reconciliation has neither problem. Running the installer on both paths
is free — it is a copy, a chmod and a rendered file, idempotent by
construction — so on a cold deploy it simply runs twice. That is also
why the call was **split into its own script** rather than left inside
`jail_install_rcd.sh`: `deploy.sh` needs to call it directly (via
`deploy_common`'s `substrate_reconcile` hook, `DEPLOY_FEATURE_RECONCILE`)
on hot deploys too, while `jail_install_rcd.sh` keeps calling it so the
fresh-jail bootstrap stays one command. The classification side of the
same decision — `infra/freebsd/bin/*` is HOT **on purpose** — is
recorded in § "Hot vs cold deploy — when each path triggers".

**The privilege-scope half of the contract, which is what makes
fail-closed safe.** The wrapper reads the prefix it may alias inside
from a root-owned config file and refuses to run without it. That
prefix MUST equal the DB's `addressing.static_mapping_prefix`: a drift
does not misbehave quietly, it refuses the arm probe with **exit 65**,
i.e. it surfaces as an outage rather than as a wrong-source egress —
which is why the file is rendered from the DB instead of maintained by
hand. The exception is the empty case: **with no prefix in the DB (mode
1, or a fresh install) the installer leaves any existing file alone
rather than truncating it.** In that configuration the wrapper is never
invoked, and a half-written scope is worse than a stale one. The
operator-facing consequences of the same design — the sudoers grant, the
exit-66 fail-closed on a missing/malformed file, the #609 prefix-drift
incident and the "changing the prefix is not a pure admin-UI operation"
loop — are in § "Running operator actions against the live jail (prod)"
under **Static-mapping source aliases (#543 mode 2)**.

### `deploy.sh` — the substrate hooks and their traps

`infra/freebsd/deploy.sh` is a **thin consumer** of the shared algorithm
in `infra/lib/deploy_common.sh` (#503): it sets config, turns on every
feature toggle (the jail is the most complete substrate) and defines the
substrate-specific hooks. The hot-vs-cold decision, the marker
base-select, the re-exec guard, the nothing-to-do guard, the reload
honesty check, the BEAM-readiness wait and the healthcheck loop all live
in the library — see § "The shared deploy library (`infra/lib/`)". What
follows is only what is specific to the jail's hooks.

- **`substrate_pull` reads git as the `grappa` user**, not as root: root
  cannot `git rev-parse` in a grappa-owned directory without a host-wide
  `safe.directory` config we would rather not require.
- **`substrate_write_marker` does `mkdir -p runtime`** — the marker owns
  its directory. A no-op on a checkout where `runtime/` already holds
  the DB; required for any checkout-less reuse.
- **`substrate_commit_exists` suppresses stdout as well as stderr.** The
  library evaluates the predicate inside a `base=$(…)` capture, so a
  `su -l grappa` login shell printing a banner would splice straight
  into the captured preflight range base.
- **Preflight runs `mix run --no-start` under the env file.**
  `--no-start` boots the BEAM without starting the app, so the check
  never talks to the live DB or steps on the running release;
  `MIX_ENV=prod` evaluates `config/runtime.exs`, which raises on a
  missing `DATABASE_PATH` & co., so the rail sources
  `/usr/local/etc/grappa/grappa.env` first (`set -a` exports every
  assignment). The posture is *refuse to run blind*: a crash must never
  decide a mode.
- **`mix deps.get` runs BEFORE the preflight oneshot (#541,
  Co-authored-by abonforti).** A pull that moved `mix.exs`/`mix.lock`
  leaves deps stale and `mix run` aborts on that — preflight would then
  exit 1 (a crash, not a 0/3 verdict) and the deploy would strand before
  ever reaching the build step's own `deps.get`. The two are chained
  with `&&` so a `deps.get` failure surfaces as a non-verdict abort. It
  is idempotent and cheap when in sync, and the build re-runs it, so the
  preflight-skipping `--force-*` paths still fetch before compiling.
- **`substrate_reload`'s chatter goes to stderr.** The library captures
  this hook's **stdout** as the reload response body; anything else
  printed there pollutes the JSON that the `"failed":[]` honesty check
  inspects.
- **`substrate_migrate` and `substrate_seed` both go through
  `jail_release.sh`** — one source-env-then-exec flow, so `deploy.sh`
  never re-implements env sourcing inline. The release has no Mix, so
  the seed is a `Grappa.Release` entry point rather than the mix task
  the systemd substrate drives. Running a second BEAM against the live
  DB is this substrate's already-proven shape: `substrate_migrate` does
  exactly that while the daemon is still up, and a seed is a lighter
  write than a migration.
- **The cold path re-asserts BEAM exit even though `service grappa stop`
  is synchronous.** It has been synchronous since defect #9, but the
  rc.d refresh runs BETWEEN stop and start — so a deploy that *ships* an
  rc.d fix stops through the **previously installed** wrapper, possibly
  one that returns mid-drain. A timed-out wait must never race the
  start.
- **The rc.d refresh sits between stop and start, deliberately.** The
  old daemon is stopped through the wrapper that started it, and the new
  daemon boots through the new wrapper. An `infra/freebsd/rc.d/grappa`
  diff classifies COLD (preflight class `:rc_d`) precisely so that a
  shipped wrapper change takes effect here. This step runs as root.
- **`mix release --overwrite` is required on BOTH paths** — the single
  most re-introducible bug in this file is "surely the hot path does not
  need a release". § "Hot vs cold deploy — when each path triggers"
  explains why: the daemon's code path includes the release-internal
  `ebin`, not `_build/prod/lib/grappa/ebin`.

### `jail_beam_wait.sh` — the path is a cross-deploy contract (#923)

**Do not move or rename this file.** Two call sites reach it: the
installed rc.d wrapper (via `rc.conf.d`) and `deploy.sh`'s cold path,
after `service grappa stop`. Both resolve it from the repo checkout, so
the path is a contract with the **previously installed** wrapper — the
one currently on the machine, written by the last deploy. Renaming it
breaks the machine you are standing on, and no test in the repo can see
it. The #923 dedupe made this rail a thin substrate entry point over
`infra/lib/beam_wait.sh` (the Linux substrate has its own entry point
over the same implementation) and left the path deliberately unchanged
for exactly this reason. The cold path calls it even though rc.d's stop
is synchronous, for the transition-deploy reason above.

### The cic rails — `jail_cic_build.sh` and `jail_deploy_cic.sh`

**The jail builds cic with `npm`, not `bun`** — it has node24 and
FreeBSD has no bun port. Everything below follows from that.

- **Output is `runtime/cicchetto-dist/`, and the BEAM self-serves it via
  `Plug.Static` since #485.** There is no `/usr/local/www/cic` symlink
  and no nginx inside the jail at all; the m42 HOST vhost proxies
  straight to the BEAM. The path is shared with the Docker substrate
  (`compose.yaml` bind-mounts the same final path into the build
  oneshot) because `Grappa.Cic.Bundle`'s `@bundle_path` reads it
  unconditionally — one server-side anchor, both substrates.
- **The build never writes into the directory being served (#1020).**
  It targets a staging sibling and `infra/lib/cic_dist.sh` renames it
  into place; the failure window of that swap, and the `--emptyOutDir`
  outage that motivated it, are in § "The Docker compose stack
  (`compose.yaml`)". `cic_dist.sh` is **sourced, not executed**, so the
  promote runs in this shell, as `grappa`, with the same relative cwd —
  changing `.` to an exec silently breaks it.
- **`GRAPPA_VERSION` comes from the repo-root `VERSION` file via the
  POSIX `infra/packaging/version.sh` (#538/#652)**, because this jail has
  `/bin/sh` and npm but no bash and no bun. vite bakes it into
  `<meta cicchetto-version>`; single source of truth, same env channel
  every cic build uses. `su -l` scrubs the environment, so it is set
  INSIDE the login shell.
- **Never pipe the build into `tail` (2026-06-10 uploads-2 deploy).**
  Plain `sh` has no `pipefail`, so `cmd | tail` makes the pipeline's exit
  status `tail`'s: `set -e` never fired on an npm failure and the deploy
  **reported success over a stale bundle**. The build now buffers to a
  log file and prints the tail only on failure — the full log stays on
  disk for diagnosis and `set -e` does its job.
- **`npm ci` falls back to `npm install`.** `npm ci` requires
  `package-lock.json` to be in sync with `package.json`, but bun owns the
  canonical lock in-repo and the npm lock is generated in-jail — so a dep
  added via bun makes `ci` fail. `npm install` regenerates the lock.
- **`jail_deploy_cic.sh` pulls for itself** (`git pull --ff-only`, so the
  tree matches what is about to be built — the operator can skip a
  separate `jail_git_pull.sh`) and **does not touch the BEAM**: no `mix
  compile`, no `mix release`, no `service restart`. Use it for cic-only
  changes (`cicchetto/src/`, `index.html`, vite manifest tweaks) where
  bouncing the bouncer is unacceptable; server-side changes still go
  through `deploy.sh`, which auto-classifies. Its HTTP-204 failure mode
  (#526) is covered in § "Hot vs cold deploy — when each path triggers".

### `jail_install_rcd.sh` — re-assert the exec bit every time

The rail installs the rc.d wrapper and `rc.conf.d/grappa`, and is
idempotent: re-run it after a `git pull` to refresh the wrappers without
waiting for a cold deploy. **It re-asserts the exec bit on
`jail_beam_wait.sh` on every install.** The wrapper's stop/start
synchronization delegates to that helper straight from the repo
checkout, so a checkout that lost the exec bit would silently degrade
`stop` back to asynchronous — the exact defect-#9 behaviour the wrapper
exists to prevent, reintroduced by a file mode.

### `jail_mix.sh` — why the build lock is disabled

`MIX_OS_CONCURRENCY_LOCK=0` is set because the jail's `/tmp` cannot take
the cross-uid hard links mix uses as a build lock. **The override is
safe only while deploy runs are serialized** — that caveat is the
condition, not a footnote; a concurrent second deploy in the same
checkout is outside what this is safe for.

## Native Linux and the cloud one-click box (infra/linux/, infra/cloud/)

The WHY behind `infra/linux/*.sh` (the plain Ubuntu/Debian systemd
substrate) and `infra/cloud/*.sh` (the shared bootstrap the AWS
one-click box execs). The operator-facing runbooks are elsewhere and are
not repeated here: § "Linux (systemd) — no host wrapper needed" for the
three verbs and the `Type=exec` stop/start posture, § "AWS one-click box
(CloudFormation) — #665" for the launch/DNS/TLS flow, § "Hot vs cold
deploy — when each path triggers" for the classifier, § "The shared
deploy library (infra/lib/)" for everything the substrates have in
common, and `infra/linux/README.md` for first-install and day-2. This
section is the record of the decisions and the production incidents that
shaped these scripts — the things a reader "tidying up" a shell script
would otherwise delete.

### The toolchain pin is the repo's pin, never the distro's

**A distro's Erlang packaging cannot be trusted to give you the OTP the
release needs.** This is one rule with two production-paid faces, and it
governs every substrate that builds Grappa from source:

- **Wrong version.** Debian/Ubuntu apt carries no pinned build of the
  exact elixir/erlang pair in `.tool-versions`. A drifted OTP here
  silently diverges from what CI (`erlef/setup-beam`, reading the same
  file) and the FreeBSD jail actually run — the divergence surfaces as a
  behaviour difference in production, not as an install error. So
  `infra/linux/install_toolchain.sh` installs asdf into `~grappa` and
  runs a bare `asdf install` inside the checkout: `.tool-versions` is
  already in asdf's native format, so the pin CI runs is the pin
  installed here, with no second hand-maintained pin to drift. asdf over
  raw kerl for exactly that reason — kerl would need its own pin.
- **Wrong shape.** A distro that SPLITS OTP into per-application
  packages leaves you with a valid-looking Erlang that is missing
  modules the release loads at runtime. Arch is the live case
  (`infra/packaging/aur/PKGBUILD`): `elixir` runtime-depends on only
  `erlang-core` (erts, kernel, stdlib, compiler, crypto), while `mix
  release` bundles Grappa's whole app tree — which also needs
  `public_key` (the TLS cacerts path, § "Upstream TLS trust store"),
  `ssl`, `inets` and `runtime_tools`. The PKGBUILD therefore
  build-depends on `erlang-headless`, the meta that pulls the FULL OTP
  minus the wx/observer GUI, rather than enumerating subpackages — an
  enumerated list drifts the moment a dep changes. Never "slim" that
  back to bare `elixir`.

The corollary on a source build: **strip the GUI, not the apps.**
`install_toolchain.sh` passes `KERL_CONFIGURE_OPTIONS` that skip
wx/observer's X11/GTK chain and the debugger/javac interop — none of it
is used (the observer tooling here is `observer_cli`, not OTP's
`:wx`-based observer), and putting `--with-wx` back drags an X11/GTK
chain onto a server. Dropping those flags is what a future editor tries
first when a build fails; it is the wrong lever.

Two consequences worth stating in advance so they do not read as bugs:
Erlang is **built from source** (there is no prebuilt asdf-erlang binary
for an arbitrary pin), so the first `install.sh` spends ~10-20 minutes
in that step and looks hung; and six of the packages
`install_prereqs.sh` apt-installs (autoconf, m4, libncurses-dev,
libssl-dev, unzip, zlib1g-dev) exist ONLY to make that source build
work. Prune the apt list without knowing that and the next fresh install
fails in the toolchain step.

### Under `set -euo pipefail`, two shapes still swallow an abort

Both `install.sh` (#441) and `infra/cloud/first-boot.sh` (#748) paid for
the same lesson in production, from opposite directions. State it once:
**a failure inside a command substitution in ARGUMENT position, and a
no-match `grep` inside a pipeline, do not stop the script — they produce
a confident, silent, wrong success.**

- **Argument position (#441).** `set_env_if_blank KEY "$(gen …)"` cannot
  fail the script: `gen`'s `exit 1` exits the SUBSHELL, and the
  enclosing command's status is `set_env_if_blank`'s, so neither `set
  -e` nor `pipefail` ever sees it. The loud ERROR got printed and the
  blank was written anyway — and because the only explicit empty-check
  in the file sat OUTSIDE a substitution (the VAPID one), a different
  failing generator let the run continue to `systemctl start` and exit 0
  announcing a healthy host, with `GRAPPA_ENCRYPTION_KEY` set to the
  empty string: a Cloak vault keyed on nothing. Measured, #441. The fix
  is the shape, not a message: **capture into a variable, CHECK, then
  write.** Assigning first makes the failure real (`set -e` fires on the
  assignment) and `require_nonempty` additionally catches the other
  shape — a generator that exits 0 with nothing to say.
- **Pipeline position (#748).** `first-boot.sh` distinguishes "could not
  read the GitHub release API" (non-zero) from "read it, no such asset"
  (empty stdout). Keeping those apart needs the trailing `|| true`: a
  no-match `grep` exits 1, `pipefail` promotes that to the pipeline's
  status, and in the caller's command substitution `set -e` then killed
  the script — so the `die` that names the problem was unreachable, and
  a release with no amd64 asset aborted first boot with exit 1 and not
  one word of explanation. Deleting that `|| true` is exactly the tidy-up
  a reader makes; two bats cases in
  `test/infra/cloud_first_boot_test.bats` pin both arms.

Related, and the reason a blank secret survives so long: **an env var
set to `""` is not `nil`, so a `System.get_env(…) || raise` guard never
fires.** That is how empty VAPID keys reached production
(2026-07-24) — `config/runtime.exs` read `""` for both halves, the `||`
never triggered, the app booted "fine", nothing logged, and Web Push
subscriptions simply never worked. A boot-config guard that must reject
blanks has to test emptiness, not `nil`.

### install.sh — the secrets bootstrap

`infra/linux/install.sh` is run by hand, once, as root; it is idempotent
and re-run by every re-install. Its whole middle is a secrets bootstrap,
and nearly every line of it is scar tissue. `test/infra/install_linux_test.bats`
pins the outcomes (#441); the reasons follow.

- **Full `mix deps.get`, NOT `--only prod`.** The secrets step runs
  several mix tasks under `MIX_ENV=dev` on purpose: a prod-env mix task
  reads `config/runtime.exs`, which raises on the very secrets being
  created (the chicken-and-egg the Docker `quickstart.sh` and the
  FreeBSD path already work around the same way). Those dev-env
  invocations need the dev-only deps (credo, dialyxir, sobelow, …) on
  disk; `--only prod` skips them and every task dies with "the
  dependency is not available, run mix deps.get" (found live on a fresh
  native-Linux install, 2026-07-22). The later `MIX_ENV=prod`
  compile/release steps use only the prod subset — the extra deps on
  disk are harmless bytes, not a mistake.
- **Generators fail LOUD, with stderr captured.** With `set -e` active,
  a failing mix task inside a command substitution aborts the script
  immediately — and with stderr discarded that abort was SILENT (found
  live 2026-07-22: three secrets written as empty strings with zero
  indication anything had failed). `gen_raw` is the shared
  run-then-fail-loud-then-strip-warnings step; `gen` additionally takes
  only the LAST line, which is correct for the single-line generators
  (`phx.gen.secret`, `gen_encryption_key`) and **wrong** for `mix
  grappa.gen_vapid`, which prints FOUR lines (both keys plus two comment
  lines). Routing VAPID through `gen`'s `tail -n1` kept the last comment
  line and discarded both keys — the 2026-07-24 blank-VAPID incident
  above. VAPID now calls `gen_raw` and greps each key out of the full
  multi-line output. Anything that prints more than one line must do the
  same.
- **Both halves of the VAPID pair are checked, not just one.**
  `vapid_key_needs_gen` looks at public AND private. Simplifying it to
  test only `VAPID_PUBLIC_KEY` re-creates a permanently half-blank pair,
  and install.sh's idempotency means it never self-heals.
- **Secrets are never silently regenerated; config values are always
  overwritten.** Two different helpers on purpose. `set_env_if_blank`
  guards secrets. `force_set_env` handles install-computed config
  (`PHX_HOST`, `PORT`) because `grappa.env.example` ships non-blank,
  non-`REPLACE_ME` example values for readability — `set_env_if_blank`
  reads `PHX_HOST=grappa.example.org` as "already set" and never writes
  the operator's real host, which is exactly what happened (2026-07-22:
  `PHX_HOST` stayed at the template's `example.org` forever).
- **Re-lock the env file after every rewrite, or the secrets go
  world-readable.** The `grep -v >tmp && mv` rewrite replaces the env
  file with a fresh inode born under root's umask — 0644 root:root,
  dropping the 0640 root:grappa set at creation. `chmod` alone is not
  enough: the daemon reads the file via the GROUP, so the `chown` is
  load-bearing too. `force_set_env` runs LAST (config after secrets), so
  it is the one that decides the final mode; without its re-lock the
  finished file is 0644 with every secret readable by anyone on the box.
  Pinned by "the finished env file is 0640, not the tmp+mv default (#441)".

### Migrations run a mix task, never the release's `eval`

**On this substrate the packaged release's `eval` / `remote` / `rpc`
crash the BEAM at kernel boot** — even for a trivial `eval '1 + 1'`.
Symptom: `Kernel pid terminated (logger)`, a
`{badarg,[{persistent_term,get,[code_server]…}` trace. Found live
2026-07-22; **root cause still unidentified.** The isolation result is
what makes it actionable: raw `erl -eval` works fine, and `bin/grappa
start` — the FULL boot, exactly what `grappa.service`'s `ExecStart`
uses — works fine too, so the fault is specific to the mix-release
`bin/grappa` script's minimal `start_clean` boot variant, not the
release packaging and not the asdf toolchain. Full trace, the ruled-out
hypotheses and the console fallback are in `infra/linux/README.md`
"Day-2 operations".

So `install.sh` and `deploy.sh` (`substrate_migrate` and
`substrate_seed` both) drive a plain **mix task** instead — viable
here precisely because this substrate keeps the whole mix/asdf toolchain
around permanently, unlike a minimal prod container, and consistent with
what Docker already does (§ "Hot vs cold deploy": Docker and Linux via
`mix grappa.migrate`, the jail via `Grappa.Release.migrate()`). Do not
"restore symmetry" with the jail by routing these through the release.

**Any mix task that STARTS THE APP against a LIVE host on this substrate
must go through `Mix.Tasks.Grappa.Boot`.** It suppresses both
`Grappa.Bootstrap` and `GrappaWeb.Endpoint`, so the task neither opens
upstream IRC connections for every bound network nor fights the running
daemon for port 4000 (`:eaddrinuse`). That is what makes seeding safe on
a HOT deploy, which is the entire point of seeding on one.

The rule is about the APP START, not about the words "mix task", and the
migrate door has always sat outside it: `mix ecto.migrate` starts the
Repo and nothing else — no Bootstrap to connect, no Endpoint to bind —
which is why `substrate_migrate` has run it bare against a live host
since this substrate existed. `mix grappa.migrate` (#1348) keeps exactly
that regime: `app.config`, the duplicate-version audit and the migrator,
all inside `Ecto.Migrator.with_repo/2`, with no
`Application.ensure_all_started/1` anywhere. Satisfying the rule's
reason by starting NOTHING is stricter than satisfying it by starting
everything with two children suppressed — so do not "tidy" that task
onto `Boot`, it would ADD an app boot to the cold path of the substrate
whose documented pathology is a boot that kills the BEAM.

### deploy.sh — what is Linux-specific

The hot/cold decision, the marker, the re-exec guard and the shared
verbs all belong to `infra/lib/deploy_common.sh` (§ "The shared deploy
library (infra/lib/)"); `infra/linux/deploy.sh` is a thin consumer.
Three things are its own:

- **`mix deps.get` runs BEFORE the preflight oneshot (#541).** A pull
  that moved `mix.exs`/`mix.lock` leaves deps stale and `mix run` aborts
  on that, so the preflight would exit 1 — a CRASH, not a 0/3 verdict —
  and the deploy would strand before ever reaching the build step's own
  `deps.get`. The two are chained with `&&` so a `deps.get` failure
  surfaces as a non-verdict abort rather than a misclassified deploy.
  Idempotent and cheap when in sync, and the build re-runs it, so the
  preflight-skipping `--force-*` paths still fetch before compiling.
  Pinned by `deploy_linux_test.bats` "#541: a dep-moving pull still
  reaches a verdict".
- **Every `deploy_common` feature is ON here except DEFER.**
  `FORCE_FLAGS`, `NOTHING_TO_DO`, `REEXEC`, `MARKER` and
  `PREV_SHA_CARRY` are all `=1`; `DEPLOY_FEATURE_DEFER=0` is the lone
  opt-out. (`--defer-restart` is the m42 two-bounce collapse — see
  § "m42 (FreeBSD bastille jail)"; no rationale for the Linux opt-out is
  recorded anywhere, see FLAGGED.)
- **`substrate_reload` applies pending EXPAND migrations and 409s on a
  pending CONTRACT one (#41)** — wire-level behaviour an operator
  reading a 409 out of a Linux deploy needs; the classifier rules live
  in § "Hot vs cold deploy".

### Rendering config templates: substitution, not sed, once values go multi-line

`install_nginx.sh` renders its template with bash string substitution
(`${var//find/replace}`), NOT `sed`, because `@TRUSTED_UPSTREAM_BLOCK@`
is **multi-line** (an allow/deny pair) and `sed`'s `s|find|replace|`
chokes on an unescaped embedded newline in the replacement
("unterminated `s' command", found live 2026-07-22). The sibling
`install_systemd.sh` still uses `sed` and that is fine — its three
substitutions are all single-line. The rule is the value's shape, not
the tool: a single-line substitution may use `sed`; the moment a
replacement can contain a newline it must not.

Two more notes on these installers:

- **`install_systemd.sh` enables the unit but does NOT start it** —
  starting is the caller's job, and both `install.sh` and `deploy.sh`
  depend on that split.
- It `chmod +x`es `grappa_beam_wait.sh` in place rather than copying it:
  `grappa.service`'s `ExecStartPre` references the script at its
  checked-in repo path, so there is nothing to install, only an
  executable bit to re-assert after a fresh clone or pull. That is why a
  `chmod` sits inside an "install the unit" script, and why the deploy
  re-runs that script before every cold restart.
- **`install_prereqs.sh` installs `sudo` FIRST**, before anything else:
  it is NOT preinstalled on a minimal Debian netinst/LXC template (found
  live 2026-07-22), and every other script here drops to the grappa user
  via `sudo -u grappa`, so without it they all fail with "sudo: command
  not found".
- **`ca-certificates` is the ENTIRE Linux upstream-TLS trust story** —
  `Grappa.IRC.Client.tls_connect_opts/1` reads the OS store via
  `:public_key.cacerts_get/0`, and there is no FreeBSD-style extra step
  (see § "Upstream TLS trust store (`--tls`, #89)" and CLAUDE.md's
  security section for the per-OS anchor sets). It is load-bearing, not
  boilerplate: prune it out of the apt list and upstream TLS stops
  verifying.

### cic_build.sh — bun here, npm only on FreeBSD

The SPA build's staging/promote mechanics (`vite` must never write into
the served `OUT_DIR`, the tracked `.gitkeep` placeholder, #1020) are the
shared library's — § "The shared deploy library (infra/lib/)" and
§ "The Docker compose stack (compose.yaml)". Linux-specific:

- **This script uses `bun` directly.** `infra/freebsd/jail_cic_build.sh`
  is the same script with an `npm` fallback ONLY because FreeBSD pkg has
  no bun port, and that fallback regenerates `package-lock.json` from
  the canonical `bun.lock`. **`bun.lock` is canonical;
  `package-lock.json` is a FreeBSD-only regenerated artefact.** Someone
  reading the jail script without knowing this will "fix" the npm
  fallback and break the jail build.
- **PATH must include `~grappa/.local/bin`.** bun lives there
  (`install_toolchain.sh` puts it there), and `sudo -u … bash -c`
  otherwise falls back to the system default PATH, which does not — the
  failure is "bun: command not found" on a host where bun demonstrably
  works (found live 2026-07-22). The same trap is why `install.sh`
  carries `asdf_path_export`: one lesson, three files.
- **The lib is sourced from the SCRIPT's own dir**; the argument only
  names the checkout the bundle is built FROM. Load-bearing whenever the
  script is run from a different checkout than the one it builds.
- `cic_dist_promote` plants the tracked `.gitkeep` placeholder itself.
  No caller should re-add a post-build `touch` — that only ever existed
  to undo an in-place wipe that no longer happens.

Related, `infra/linux/release.sh` is a port of the jail's
`jail_release.sh` and is simpler by one thing: there is no `bastille
cmd` argv-eating quirk to work around, so no `$0`-vs-`$@`
reconstruction dance. The jail's version of that dance looks like cargo
cult and is not — do not "simplify" it to match this file.

### grappa_beam_wait.sh — why it survives Type=exec

The causal chain that made this script exist on FreeBSD: `rc.d`'s
`service grappa stop` is asynchronous → a restart starts the new node
while the old one is still draining → the two collide on the same epmd
name → outage (defect #9, 2026-06-11). systemd `Type=exec` with
`bin/grappa start` in the foreground closes that at the root cause here
(§ "Linux (systemd) — no host wrapper needed"); the wait algorithm and
the epmd rule itself are the shared library's.

Which makes the obvious cleanup — "systemd blocks, delete this file" —
wrong. It is retained for two narrower purposes: `wait-name-free` as a
defense-in-depth `ExecStartPre` guard on the START path, and
`wait-stopped` as an **operator tool with no caller at all** (`deploy.sh`
never invokes it; only `grappa.service` and a human do). Without that
record the file reads as dead code and gets deleted.

### The cloud one-click box — two hand-written doors, one bootstrap (#665)

The launch flow is § "AWS one-click box (CloudFormation) — #665". The
design decisions behind `infra/cloud/`:

- **A second cloud costs a wrapper, not a rewrite.** The doors (CFN
  YAML today, Terraform HCL when it lands) share `first-boot.sh` and the
  knob names in `infra/cloud/params.contract`, and NOTHING else — the
  resource graph stays a hand-written file per provider.
- **A checker, deliberately not a generator.** Generating both templates
  from one source means CDK/cdktf: a Node toolchain plus synthesized
  artifacts committed anyway, to save ~30 lines of resource graph. The
  cost was judged higher than the drift it removes, so
  `infra/cloud/check-drift.sh` is a CI guard instead — it never edits a
  template, it only fails loud. Exit 0 clean, 1 drift, 2 misuse; an
  absent provider directory is not drift and is tolerated silently.
- **All three of its checks read the EXECUTABLE surface, never prose
  (#746).** This is the principle that must survive any edit to that
  file, and it is a lesson, not a preference: the whole-file grep for
  `first-boot.sh` used to be satisfied by the four PROSE mentions that
  survive deleting the real `UserData` bootstrap, and a knob marker left
  behind by a deleted parameter passed as a detached comment. Check (3)
  — that both sides export the same env — did not exist at all, and it
  is the drift that actually happens: rename `GRAPPA_DOMAIN` on one side
  and every launched stack dies in `UserData` while both files stay
  individually valid. Each defect is pinned by a named case in
  `test/infra/cloud_drift_guard_test.bats`. The one-line form, worth
  keeping: **read from the assignment itself, never from a comment — a
  comment is the thing this guard exists to stop trusting.**
- **Corollary: the required-knob assignments in `first-boot.sh` have a
  SHAPE, and check-drift parses it.** "Cleaning up" a knob to
  `GRAPPA_DOMAIN=""` or `: "${GRAPPA_DOMAIN:=}"` silently removes it
  from the CI handshake, and the guard goes green on a broken door.
- **Config paths get test seams; privilege checks do not.** The
  uppercase path variables are genuine config defaults (correct in
  production) that double as seams so
  `test/infra/cloud_first_boot_test.bats` can sandbox the filesystem —
  the same pattern as `gen-secrets.sh`'s `GRAPPA_ENV_FILE` and `get.sh`'s
  `GRAPPA_HOME`. `require_root` deliberately has NO such escape hatch
  (#747), which is the half a future agent will try to add on the next
  test failure. Both halves are one rule.
- **This script is bash, not the strict-POSIX `sh` of the shared deploy
  library.** The library is POSIX for substrate portability; this
  script's only substrate is Ubuntu, which always ships bash, so it uses
  bash for readable string handling.
- **Everything inside its heredocs is DATA, not comments.** The
  `grappa-tls` helper, the `grappa-tls.service` unit and the nginx site
  are written to the operator's disk with their `#` lines intact —
  those lines are the documentation of THEIR config and are untouchable
  by a comment sweep. Same for `final_notice`'s printed text (deferred-TLS
  instructions, the `GRAPPA_ENCRYPTION_KEY` backup warning).

## Packaging (infra/packaging/)

**One format-agnostic substrate, three OS packages.** `infra/packaging/`
holds the FHS layout, the systemd unit, the openssl secret bootstrap and
the `/usr/bin/grappa` operator wrapper ONCE, and three renderers consume
it: `nfpm.yaml` (the `.deb` and the `.rpm`, driven by `build.sh`),
`aur/PKGBUILD` (the Arch **source** package), and — indirectly — the
release image and the from-source substrates, which reuse
`gen-secrets.sh` and `version.sh` without any packaging of their own.
Everything here is exercised by `.github/workflows/release.yml`'s
`deb` / `arch` / `rpm` / `publish` jobs and pinned by the bats suites
under `test/infra/`. The container image path is a different substrate
entirely — see § "The two images: `Dockerfile` (toolchain) vs
`Dockerfile.release`" and § "The published release image (ghcr.io) —
#503 unit C".

### The version single source of truth — `version.sh` (#538, #652)

**Every version carrier DERIVES from the repo-root `VERSION` file; there
is no second hand-edited copy.** `infra/packaging/version.sh` is the
shared derivation primitive — it echoes the file's first line and
nothing else. Bump the version by editing `VERSION`, never by editing a
carrier. The release-cutting order (bump rides in as the last commit of
the shipped range, then tag) is § "Release-cutting — version-first, then
GitHub release + tag + News/Releases"; this is the *carrier map* that
several other sections point at:

- `mix.exs` and `lib/grappa/version.ex` read the SAME file at **compile**
  time (`@external_resource`, #652), so the number is baked into the beam
  and cannot drift from the package metadata. It does NOT make the bump
  hot-reloadable: `mix.exs` stamps the OTP application vsn from that same
  read, which moves the release's lib directory out from under the running
  node — a `VERSION`-only bump is COLD, see § "Release-cutting".
- `build.sh` sources `version.sh` to export `GRAPPA_VERSION`, which
  `nfpm.yaml` interpolates into `version:` for BOTH the `.deb` and the
  `.rpm`.
- `release.yml`'s Arch job and `aur/regen.sh` run it to fill PKGBUILD's
  `pkgver=@GRAPPA_VERSION@` sentinel before `makepkg`.
- Every cicchetto build entrypoint exports `GRAPPA_VERSION` from it so
  vite can bake `<meta cicchetto-version>`: `scripts/bun.sh`,
  `scripts/deploy.sh`, `scripts/deploy-cic.sh`, `scripts/integration.sh`,
  `scripts/testnet.sh`, `infra/linux/cic_build.sh`,
  `infra/freebsd/jail_cic_build.sh`, `Dockerfile.release` and the
  Arch `build()`. The container builds mount only `./cicchetto` and
  cannot read the repo root themselves, which is why the value travels
  as an env var rather than being read in-place.

`version.sh` is **POSIX `/bin/sh`, not bash**, because the FreeBSD jail
build runs `/bin/sh` with no bash port and calls it; it is always
EXECUTED, never sourced. A bashism added here breaks a production build
path with no local signal. The `deb` and `arch` release jobs both assert
`v$tag == $(infra/packaging/version.sh)` before building, and
`test/grappa/version_single_source_test.exs` fails if the committed
PKGBUILD stops carrying the sentinel.

### `build.sh` — one throwaway build tree, one format at a time

**It deliberately does NOT drive the dev compose stack (`scripts/*.sh`).**
Those share the main repo's `_build` through the `./:/app` bind mount, so
a package build routed through them would contend with concurrent dev and
CI compiles. `build.sh` wants its OWN, throwaway `_build`, and runs on a
Debian/glibc host with Elixir 1.19 / OTP 28 + bun on PATH — the release
runner or the official `elixir:1.19-otp-28` image, never the alpine dev
image (a musl ERTS will not run on a glibc target).

**`GRAPPA_PKG_FORMAT` picks the nfpm output format; it does NOT make the
payload portable (#438).** The staging tree is format-agnostic, but the
release bundles ERTS + crypto NIFs — and, since it ships, `shottino` —
linked against the BUILD host's glibc/libssl. A Debian-built payload is
therefore a valid `.deb` and NOT a valid `.rpm`. Build each format on its
own distro: `release.yml`'s `rpm` job runs in a `fedora:43` container with
its own Fedora ERTS, the `deb` job on the Ubuntu runner. The Arch recipe
sidesteps the constraint completely by being a source package (below).

**PRODUCTION TRAP — `./configure` dirties a TRACKED file.** The shottino
step runs `./configure`, which rewrites `config.mk`, and `config.mk` is
tracked. Leaving it modified makes `git status --porcelain` non-empty;
`Grappa.Version` reads a dirty tree as unreleased and appends
`-<shortsha>` instead of reporting the bare tag, which fails the release
workflow's "Prove the artifact reports the bare tag version" step. The
`mix release` runs earlier in the current step order, so today the damage
is invisible — silently depending on that ordering is the trap for
whoever reorders this next. `build.sh` snapshots `config.mk`, installs a
`trap … EXIT` so the restore fires on ANY exit path including a failed
compile, and restores explicitly afterwards. Deleting either half of that
trap dance reintroduces the dirty tree.

### shottino ships inside the bouncer package

**One package, not a `grappa-shottino` split — considered and rejected.**
The terminal client is one ~180 KB binary whose runtime libs (`libssl`,
wide `ncursesw`) are ALREADY in `nfpm.yaml`'s `depends` for the bundled
ERTS, so shipping it costs a binary and adds no new dependency, while a
separate package would add something to maintain and buy nothing. It is a
client for THIS server: installing grappa and getting a way to talk to it
is the expected shape. The AUR recipe makes the same call for the same
reason.

It is **built here rather than shipped prebuilt** because it links the
build host's ncurses/openssl exactly like the ERTS payload — the same
constraint that makes a build valid for one format only. `SKIP_SHOTTINO=1`
opts out (mirroring `SKIP_RELEASE` / `SKIP_CIC`); without the opt-out a
shottino build failure FAILS the whole package build, because a package
that silently ships without a binary it advertises is worse than one that
refuses to build. `build.sh` then runs the staged binary's `--help` — no
server, terminal or config needed — so a link error surfaces before nfpm
wraps it.

### `gen-secrets.sh` — the packaging half (#862, #419)

The one-generator decision, the openssl-vs-BEAM argument and why `bash`
ships in the release image are already written in § "The two images:
`Dockerfile` (toolchain) vs `Dockerfile.release`" and § "Running the
published image (`docker run` / `curl | bash`) — #503 unit D". What is
packaging-specific:

- **Three consumers, three permission contracts.** The `.deb`/`.rpm`
  postinstall runs it as root against `/etc/grappa/grappa.env` and leaves
  it `0640 root:grappa` (systemd reads the file as root before dropping to
  `User=grappa`); the release image's entrypoint runs it unprivileged, as
  the grappa user, on a volume it already owns, and asks for `0600`;
  `infra/docker/deploy.sh` asks for `0600` too. Anyone editing this script
  without knowing it has three callers will break one of them.
- **SECURITY TRAP — re-lock after EVERY write.** `set_env` rewrites the
  file via tmp+`mv`-shaped logic, and a fresh temp file is born under
  root's umask as `0644 root:root`. Writing without re-locking would drop
  the `0640 root:grappa` contract and world-leak every secret, so
  `relock()` is called after each write, not once at the end.
- **PRODUCTION TRAP — `chown` only as root (#862).** `chown` is a
  root-only syscall. An unconditional call killed the unprivileged
  release-container path under `set -e` before it wrote a single secret.
  Skipping it there loosens nothing: there is nobody to chown to, and the
  caller asks for `0600`, which is tighter than the packaged `0640`. The
  packaged flow IS root and keeps its contract unchanged.
- **Off the release `eval` path (#419).** Generation is openssl-only with
  no BEAM in the loop, which also keeps first-boot secret generation off
  `bin/grappa eval` — the path #419 has to prove works on the packaged
  ERTS (see § "Native Linux and the cloud one-click box (infra/linux/,
  infra/cloud/)" for the native-Linux boot crash this sidesteps).
- **The openssl/VAPID equivalence is measured, not asserted.** Extending
  the note in § "Running the published image": `test/infra/gen_secrets_test.bats`
  re-derives the public point from the emitted scalar alone and requires a
  byte-exact match, with its own derivation pinned to the published FIPS
  186-4 P-256 vector.

### `release_assets.sh` — the expected-asset SSOT (#573)

**PRODUCTION INCIDENT: two releases shipped without their `.rpm` and the
artifact list was indistinguishable from a complete one.** The `publish`
job used to inline its "collect what built" find glob and had NO notion of
what SHOULD have built, so when the rpm leg died on `v0.8.0` and `v0.9.0`
publish attached whatever downloaded and succeeded. Both runs were red and
nobody looked. (Both releases carry their `.rpm` today — they were
back-filled by the repair path below.)

`release_assets.sh` closes the hole by deriving BOTH halves from ONE
expected-kinds table, so they cannot drift: `found` yields the attach
list, `missing` / `notice` / `apply-body` yield the audit. A new package
kind is added to that table and both halves follow. `found` matches by
NAME at ANY depth rather than by path because `download-artifact` has
unpacked the tree flat before — in run `30399152630` a path-coupled glob
matched nothing while the `.deb` sat right there. `apply-body` keys its
strip/replace off HTML sentinels, never off the block text, so the warning
wording can change without breaking idempotency, and it is idempotent both
ways: an incomplete set prepends one block however many times it runs, and
a now-complete set REMOVES a stale one (the `#573` "(b) repair" dispatch,
which uploads to the existing release with `--clobber` and reconciles the
body back to clean).

The logic lives in a script rather than inline in `release.yml` precisely
because the bug lived in untested inline YAML: it is pure filesystem +
string logic — no docker, no network, no mix — so it runs under bats
(`test/infra/release_assets_test.bats`).

### The packaged operator CLI and the migrate path (#419)

**`/usr/bin/grappa` is the only door to the release on a packaged host.**
`grappa-wrapper.sh` sources `/etc/grappa/grappa.env` INSIDE the target
user's shell (so secrets live only in that process's environment) and
drops to the `grappa` system user with `runuser`, which ships in
`util-linux` on both the Debian and RHEL families — that is why the rpm
override can depend on it. `gen-secrets` is the exception: it writes
root-owned `/etc/grappa` and never drops.

**`grappa migrate` is sugar for `eval 'Grappa.Release.migrate()'`** — the
same `Ecto.Migrator` the FreeBSD/Docker deploy paths call, reachable
WITHOUT a dev toolchain. That is the #419 "packaged migrate": a packaged
host has only the compiled release and its boot scripts, no mix and no
project source. It runs on every (re)configure and every upgrade under
BOTH `.deb`/`.rpm` postinstall and the Arch `_bootstrap`, because only
PENDING migrations apply — and it FAILS LOUD in all three, so a broken
migrate surfaces as a failed package transaction instead of a silently
half-migrated install.

**`grappa seed-themes` is its twin over `Grappa.Release.seed_themes()`
(#1167)**, and it is not sugar alone: the two install scriptlets INVOKE
this verb, so it is the packaged host's only door to the built-in gallery
and the command an operator re-runs to heal a failed seed. It sits right
after the migrate in both, schema-then-data, and unlike the migrate it is
NON-FATAL — see the seed posture under the hot/cold classification above
(#440). Before #1167 neither scriptlet seeded at all, so a `.deb`/`.rpm`
or AUR install landed with an empty theme section while the palettes sat
compiled inside the release it had just installed.

### The maintainer scripts — dpkg's `$1` is not rpm's

**TRAP: a bare `case $1 in configure)` silently no-ops the entire rpm
install path.** nfpm embeds `scripts/postinstall.sh`, `preremove.sh` and
`postremove.sh` VERBATIM into both packages, and the two managers pass
different `$1` conventions — dpkg passes `configure` / `remove` / `purge`
/ `abort-*`, rpm passes a NUMBER (`1` install, `2` upgrade, `0` final
uninstall) and has no `purge` concept at all. Matching on `configure`
would make the rpm install and do nothing: no dirs, no secrets, no
migrate. The bodies are written idempotent instead and run under either
manager, skipping only dpkg's `abort-*` rollback.

The same asymmetry shapes removal: **rpm's plain uninstall cannot reach
the config removal at all**, so it takes the same conservative
keep-the-secrets path as dpkg `remove`. That is coherent with the
packaging side — `/etc/grappa/grappa.env` is intentionally NOT a packaged
file and not a conffile, so no upgrade can clobber an operator's live
secrets, and rpm never touches it either way. `/var/lib/grappa` is never
auto-deleted on any path.

### `grappa.service` — `Type=exec`, and never auto-restart on upgrade

The unit installed by the package ships **fixed FHS paths because the
package owns them**, unlike `infra/linux/systemd/grappa.service`, which is
a sed-templated unit for the build-from-source substrate.

**`ExecStart` runs `bin/grappa start` in the FOREGROUND with `Type=exec`,
and must not become `daemon`.** A detached PID reintroduces the stop/start
epmd-name race (FreeBSD defect #9) and needs a custom `ExecStop` wrapper;
in the foreground, systemd tracks the real PID, so stop/restart send
SIGTERM and BLOCK until exit, which lets `Grappa.Session.Server`'s
`terminate/2` QUIT upstream cleanly (#215). That closes the race at the
root cause rather than papering over it.

**No package path auto-restarts on upgrade** — the `.deb`/`.rpm`
`preremove` stops the service only on a REAL removal (dpkg
`remove`/`deconfigure`, rpm `0`), and the Arch `post_upgrade` only
`daemon-reload`s. Both then tell the operator to run
`systemctl restart grappa`. This keeps the same stop/start epmd-name race
off the upgrade path; the Arch scriptlet's fail-loud posture is
deliberately identical to the `.deb` postinstall, which runs the same code
on install and upgrade under `set -e`.

`Environment=LANG=C.UTF-8` is load-bearing and pinned by
`test/infra/service_locale_pin_test.bats`: systemd sets no `LANG`, and
without a UTF-8 locale the BEAM warns about latin1 native name encoding —
a real risk when nicks, channels and filenames are UTF-8. The problem was
first observed on the #419 R1 migrate-proof boot in a locale-less
container.

### Arch / AUR (`infra/packaging/aur/`)

**The Arch package is a SOURCE package (#419 R2), and that is what makes
it immune to the cross-distro payload problem.** `makepkg` builds the mix
release and the cicchetto SPA on the target host, so the bundled ERTS and
crypto NIFs link the user's own Arch libs — no Debian-built payload
pretending to be portable, and it matches AUR convention
(rebuild-on-upgrade). Everything else is reused from the shared substrate;
only the PKGBUILD, `grappa.install` and the sysusers/tmpfiles
declarations are Arch-specific. It ships shottino in the same package for
the same reason the `.deb` does.

- **`makedepends` names `erlang-headless`, not bare `elixir`.** The
  general rule — a distro that SPLITS the Erlang package leaves you
  without modules the release needs, so take the full erlang package — is
  written once in § "Native Linux and the cloud one-click box
  (infra/linux/, infra/cloud/)". The Arch witness for it: `elixir`
  runtime-depends only on `erlang-core`, and an elixir-only builder died
  with `(Mix.Error) The application "public_key" could not be found`.
  `erlang-headless` is the meta that replaces the old `erlang-nox`.
- **`git` is deliberately absent from `makedepends`.** The tag tarball has
  no `.git`, and `Grappa.Version` (#419 R3) reports the bare package
  version from the `.app` metadata when `.git` is absent — the same no-git
  path the release image takes (see § "The published release image
  (ghcr.io) — #503 unit C").
- **No `--warnings-as-errors` in `build()`.** The recipe compiles on the
  user's own Arch toolchain, which can be newer than the dev pin; a distro
  rebuild must not hard-fail on a newer compiler's warnings.
- **The committed `pkgver=@GRAPPA_VERSION@` sentinel is deliberate.**
  `makepkg`'s pkgver lint REFUSES `@`, so an UNDERIVED build fails LOUDLY
  instead of silently shipping `grappa-@GRAPPA_VERSION@`. `regen.sh` is
  the ONE path that fills it (from `version.sh`), refreshes the checksums
  with `updpkgsums` and regenerates `.SRCINFO`. Run it from a checkout ON
  the release tag — `updpkgsums` fetches the `vX.Y.Z` tarball, so the tag
  must already exist — and do NOT commit the result.
- **BUILD ≠ PUBLISH (#538).** No AUR credentials live in this tree; the
  push to `aur.archlinux.org` stays a human `git push`, and the
  PKGBUILD/.SRCINFO ride out as release assets. Deriving the version is
  scripted anyway, because "derive the version" must not be a manual step
  a publisher can forget — that is the same forget-a-step class #538
  fixed.
- **The sysusers/tmpfiles alpm hooks fire at TRANSACTION END**, i.e. AFTER
  the install scriptlet, but the first `grappa migrate` drops to the
  grappa user and writes the DB into `/var/lib/grappa`, so both must
  already exist. `grappa.install` therefore force-runs `systemd-sysusers`
  and `systemd-tmpfiles --create` explicitly, in order, before migrating.
  The same ordering note is repeated at each of the three sites
  (`grappa.install`, `grappa.sysusers`, `grappa.tmpfiles`) on purpose:
  deleting the corresponding call at any one of them breaks the install,
  and a packager reading only the sysusers file would otherwise get no
  warning. `systemd-sysusers`/`systemd-tmpfiles` are standalone tools and
  need no live PID 1; the `systemctl` calls ARE guarded, because a
  chroot/container install has no running manager.

### `grappa.env.example`

Copied verbatim to `/etc/grappa/grappa.env` on FIRST install and never
clobbered afterwards — the comments in it are the operator product, so it
is kept deliberately verbose. One implementation detail that does not
belong in an operator's config file: `CIC_DIST_ROOT` is read once at app
start by `Grappa.Cic.Bundle.boot/1`, which is why pointing it at a
writable directory (or changing it live) is not a runtime knob.

## Per-host compose overrides

Committed `compose.yaml` ships deployment-agnostic defaults: grappa
publishes on `${GRAPPA_PUBLISH:-127.0.0.1:4000}` (loopback only);
`--profile prod` adds only the `cicchetto-build` oneshot (#485 dropped
the in-stack nginx — the BEAM self-serves the SPA + owns its headers);
`--profile ircd` adds the `shottino-ircd` bridge (#1027, its own section
below) and nothing else does.
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

## The shottino --ircd bridge as a compose service (#1027)

For people who want a normal IRC client — irssi, weechat, hexchat,
goguma — pointed at grappa instead of the web PWA. `shottino --ircd`
listens as an IRC **server** and translates; this is the supported way
to run it under compose rather than arranging one by hand.

Opt-in, on its own profile: neither `docker compose up` nor
`--profile prod` builds it or starts it.

```
# .env (see .env.example for the whole block)
SHOTTINO_USER=you
SHOTTINO_PASSWORD=…            # the grappa login
SHOTTINO_IRCD_PASS=…           # what downstream clients must send

docker compose --profile ircd up -d
```

Then, from any IRC client:

```
/connect 127.0.0.1 6667
/quote PASS azzurra:<SHOTTINO_IRCD_PASS>
```

**One service per USER, not per network.** The network is chosen per
CONNECTION in `PASS <network>:<password>` and held per downstream client
(`struct ircd_client.network`, eight slots), so one bridge fronts every
network that grappa account holds: three networks are three `/connect`s
to this same port, the way people already use a bouncer. What is
singular here is the LOGIN — a second grappa account needs a second
service on a second port.

**The bridge password is not optional.** A published port is
off-loopback from the process's point of view, and off loopback shottino
refuses to listen without `SHOTTINO_IRCD_PASS`. That is deliberate and
the service does not work around it: whoever reaches that port owns the
whole IRC session — every channel, every DM, and the ability to speak as
you. `SHOTTINO_IRCD_PUBLISH` defaults to `127.0.0.1:6667`; widening it
is a decision about who that is.

**The log is the sharp edge.** Headless there is no screen, so every
message of the session goes to `ircd.log` in plain text, mode 0600, and
it is **never rotated** — it grows for as long as the bridge runs. The
service mounts `./runtime/shottino` as the bridge's XDG data home, so it
lands at `runtime/shottino/shottino/ircd.log`, under `runtime/` with the
rest of the per-env state where a backup or retention policy can see it.
Two things put it there rather than somewhere worse: the image sets
`XDG_DATA_HOME`, and — unlike every other service in the stack — this
one does **not** bind-mount the repo, so the operator's checkout is out
of reach by construction. Know the file is there before pointing a
backup at anything.

**When it will not stay up**, check `SHOTTINO_USER` first: unset, it is
passed through as an empty username and the failure is an authentication
failure at login, not an argument error, which `restart: unless-stopped`
turns into a loop. The bridge waits for grappa's healthcheck before it
starts, so a boot race is not the explanation.

**Why it builds its own image (`Dockerfile.shottino`).** shottino's build
dependencies are not the bouncer's: its `configure` probes the `ncursesw`
and `openssl` pkg-config MODULES, so it wants `ncurses-dev` +
`openssl-dev` + `pkgconf`, where the bouncer image installs the ncurses
RUNTIME library and no pkg-config at all (`build-base` does not carry
pkg-config on alpine, so `configure` fails at its very first check
without `pkgconf`). Adding all that to the bouncer image would grow an
image every operator pulls, for a feature most will never switch on, and
the top-level `Dockerfile` is deliberately single-stage. It also needs no
ABI lockstep gate, unlike `Dockerfile.release`: both its stages sit on
the SAME alpine tag, so there is one musl and one openssl by
construction, with nothing to prove.

**Pulling the bridge instead of building it (#1168).** Every `vX.Y.Z`
release now publishes the bridge image too, multi-arch (`linux/amd64` +
`linux/arm64`), next to the bouncer's:

```
ghcr.io/vjt/grappa-shottino:<tag>     # e.g. :v0.13.0, or :latest
```

Same tag scheme as `ghcr.io/vjt/grappa`, same `:latest`-only-on-the-highest
rule, and both are cut from the same tag by the same release job — a bridge
tag always has a bouncer tag of the same name. **This is for the operators
who cannot build it**: the release-image paths (`compose.release.yaml`,
`infra/docker/get.sh`, plain `docker run`) have no checkout, so
`Dockerfile.shottino` is out of reach for them entirely. `compose.yaml`
still BUILDS the bridge, deliberately — it is the from-source stack, it
already has the tree, and the compile is seconds.

The image ships **no CMD** (§ above), so the whole command is yours:

```sh
docker run -d --name grappa-shottino \
    -p 127.0.0.1:6667:6667 \
    -v /srv/shottino:/state \
    -e SHOTTINO_PASSWORD=… \
    ghcr.io/vjt/grappa-shottino:latest \
    shottino --ircd=0.0.0.0:6667 --foreground https://grappa.example.net USER
```

Everything the compose service is careful about applies here and is now
yours to get right: the published port stays on loopback unless you also
set `SHOTTINO_IRCD_PASS` (off-loopback without it the bridge refuses to
start), and `/state` is where the plaintext session transcript lands.

**`--foreground` is required**, because compose supervises what it
started and reads the default fork-after-bind as a crash. Inside the
container it listens on `0.0.0.0`, which is what makes the published port
reachable at all; the host-side binding is what decides who can get to
it.

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
  - Dev: `scripts/mix.sh grappa.migrate`. The same migrator plus the
    #1348 audit — and a long-lived dev database is precisely where a
    duplicated version goes silent, because the version is already
    applied there long before anyone deploys it.
  - Deploys: the preflight classifies ANY new migration file as COLD
    (Class 5 — there is no in-reload migrate until #41 lands). The
    cold paths run it: Docker and native Linux via `mix grappa.migrate`,
    the jail via `Grappa.Release.migrate()` before `service grappa
    restart`. Every one of those doors — plus the hot
    `POST /admin/reload`, the published image's boot entrypoint and the
    `grappa migrate` operator verb — runs the #1348 duplicate-version
    audit first, and refuses rather than migrate past a version claimed
    by two files.
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
## Passkeys and account recovery

Each Grappa instance is a separate WebAuthn relying party. A passkey enrolled
for one hostname cannot authenticate against another hostname. Changing the
public hostname invalidates existing passkeys because WebAuthn binds them to
the RP ID and origin.

Passwordless mode accepts a passkey or one-shot account recovery code. It does
not accept the account password or TOTP, and shottino cannot complete WebAuthn.
If a user loses both passkey and recovery codes, restore password login from the
instance host:

**A headless client uses a per-client token instead (#1196).** Arming TOTP or a
passkey does not have to lock shottino, weechat, or any other unattended client
out any more: the account holder mints a token from a browser session (`POST
/me/client-tokens`, label plus the account password) and the client sends it in
the `password` field of the ordinary login. Nothing on the client side changes.
The token does not age out, is revocable one at a time, and cannot reach
`/admin/*`, the account password, the second factors, or the token surface
itself — a leaked one reads and sends as the account, and nothing more. The
account's own device list is `GET /me/client-tokens`, which shows a `handle`,
the label, `last_seen_at` and the last source IP, and never the secret again.

The two reset verbs below revoke client tokens along with everything else, so
a user whose factors you reset has to mint a new one for each client.

```sh
bin/grappa reset-passkeys ACCOUNT_NAME
```

The reset removes every passkey and recovery code, revokes all live sessions
and closes the account's open WebSockets. It does not remove TOTP; an account
with TOTP enabled returns to password plus TOTP login. The TOTP side has its
own verb:

```sh
bin/grappa reset-totp ACCOUNT_NAME
```

Both are `rpc` verbs — they run inside the live BEAM. They used to be the mix
tasks `grappa.reset_passkeys` / `grappa.reset_totp`, which no longer exist: a
mix task boots a SECOND `:grappa` instance, so its in-node effects never
reached the node actually serving traffic. Recovery is exactly the verb whose
in-node effects have to take, so the lane was wrong.
