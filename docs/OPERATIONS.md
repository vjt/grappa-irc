# Operations Runbook

Operator + developer runbook for Grappa. CLAUDE.md links here for the
verbose catalogs (verbs, scripts, deploy machinery, per-host overrides,
runtime data, monitoring). Keep this file in sync when adding a verb,
script, deploy class, or runtime knob.

## Operator dispatcher — `bin/grappa`

`bin/grappa` is the host-side operator interface. One verb per task,
boot-time mix tasks + live-state remsh verbs co-located under one
banner. Always invoke from the repo root (or any worktree dir) — the
dispatcher cd's to the main repo for docker compose and forwards
worktree volumes via oneshot bindings (same machinery as
`scripts/*.sh`).

```
bin/grappa help                  # list verbs grouped by category
bin/grappa help <verb>           # per-verb help

# Boot-time verbs (mix tasks; auto-detect MIX_ENV from container):
bin/grappa create-user --name <user> --password <pw>
bin/grappa bind-network --user <user> --network <slug> --nick <nick> --auth <method>
bin/grappa add-server --network <slug> --host <host> --port <port> [--tls]
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
scripts/deploy.sh            # unified deploy: auto-detects hot-vs-cold via git-diff preflight
scripts/deploy.sh --force-hot   # bypass preflight, hot-deploy unconditionally
scripts/deploy.sh --force-cold  # skip preflight, cold-deploy (rebuild + recreate)
scripts/deploy-cic.sh        # cic bundle deploy: vite build + broadcast bundle_hash for refresh banner
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
present (was wrongly trusted on Docker prod — see the 2026-05-16
M-4 incident). `POST /admin/reload` walks `:code.modified_modules/0`
and `:code.load_file/1`s each — release-friendly, Mix-free, works
identically in dev, Docker prod, and the jail release.

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
On the jail, the cic bundle is rebuilt on COLD only by
`infra/freebsd/deploy.sh` (no separate cic-only flow yet; add one
when the `cicchetto/src/` edits start happening between server
deploys). The server broadcasts the new bundle hash on every live
user-topic; cic's `BundleRefreshBanner` surfaces a refresh CTA on
mismatch with the hash baked into the page the browser loaded.
Server deploys never auto-trigger a cic refresh.

When the auto-detect gets it wrong (rare), `--force-hot` and
`--force-cold` override the preflight on both substrates. Use
sparingly and document why in the commit message.

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

- **Database**: sqlite via `ecto_sqlite3`. WAL journal mode in prod
  (set in `config/runtime.exs`). Files at `runtime/grappa_dev.db`
  (dev) / `runtime/grappa_prod.db` (prod). Bind-mounted from the host
  via `compose.yaml` so the volume survives container rebuilds.
- **Migrations**: standard Ecto.
  - Write migration in `priv/repo/migrations/<timestamp>_<name>.exs`.
  - Run: `scripts/mix.sh ecto.migrate`.
  - Migration files travel with the bind-mounted source — `scripts/deploy.sh`
    runs `mix ecto.migrate` as part of the cold path. New migrations are
    NOT auto-detected as cold-required (they're idempotent at boot via the
    existing migration runner) but adding a column that Bootstrap reads
    races the supervision tree boot — when in doubt, `--force-cold`.
  - Never apply DDL manually via raw SQL. Always Ecto.Migration so
    `schema_migrations` stays in sync.
  - Use `:text` for free-text columns. Don't bake length limits into
    sqlite — adjust at the schema layer if needed.
- **Log file**: container's stdout, captured by Docker JSON logger
  (max 5MB × 3 files in dev, 10MB × 5 in prod). Tail via
  `scripts/monitor.sh`. On the FreeBSD jail, `bin/grappa daemon`'s
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

- **Health**: `scripts/healthcheck.sh` (curl `/healthz`).
- **Logs**: `scripts/monitor.sh` (docker compose logs -f).
- **Runtime introspection**: `scripts/observer.sh` (observer_cli — see
  every supervised process, mailbox depth, memory).
- **Phoenix.LiveDashboard** mounted at `/admin` (dev only by default;
  Phase 5 hardening adds prod with auth).
- **Telemetry**: events emitted via `:telemetry`; metrics aggregated
  via `Telemetry.Metrics`. Phase 5 adds Prometheus exporter.
