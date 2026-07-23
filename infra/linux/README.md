# Installing grappa on a native Linux host (systemd, no Docker)

A third deploy substrate alongside Docker (`INSTALL.md`, dev/self-host)
and the FreeBSD bastille jail (`infra/freebsd/`, `m42` production).
This one targets a plain Ubuntu/Debian host managed by systemd — no
Docker, no jail. See `infra/linux/README.md`'s sibling scripts for the
implementation; this file is the operator runbook.

## Prerequisites

- A fresh Ubuntu 22.04+/Debian 11+ host, root/sudo access.
- ~2GB+ free disk for the Erlang source build + deps + release
  artifacts, more over time for the sqlite DB and uploads.
- A public hostname you control (`PHX_HOST`).
- **This host does not terminate TLS.** A separate upstream machine
  must already reverse-proxy your public HTTP/HTTPS traffic to this
  host's nginx on plain HTTP. If you don't have that, see "Exposing
  beyond localhost" below before going further.

## Quick start

```sh
git clone https://github.com/vjt/grappa-irc /home/grappa/grappa   # or let install.sh clone it
PHX_HOST=irc.example.org infra/linux/install.sh
```

Run as root. Takes 10-20 minutes on first run (Erlang compiles from
source — this is expected, not a hang). When it finishes, grappa is
running under systemd, reachable at `http://127.0.0.1:4000/healthz`
directly and through the locally-installed nginx.

### What each step does

1. **`install_prereqs.sh`** — apt packages (build toolchain,
   `libsqlite3-dev`, `libimage-exiftool-perl`, `ffmpeg`,
   `ca-certificates`, `nginx`, Erlang build deps), creates the
   unprivileged `grappa` system user, creates `/etc/grappa`.
2. **Clone/update** — the checkout lands at `$REPO_ROOT` (default
   `/home/grappa/grappa`), owned by `grappa`.
3. **`install_toolchain.sh`** — installs asdf (Go binary) + the exact
   Elixir/Erlang versions pinned in `.tool-versions`, as the `grappa`
   user. This is the slow step.
4. **First build** — `mix local.hex/rebar`, `deps.get --only prod`,
   `compile --warnings-as-errors`, `release --overwrite`.
5. **Secrets bootstrap** — see below.
6. **First migration** — `Grappa.Release.migrate()` via `release.sh`.
7. **`cic_build.sh`** — builds the cicchetto PWA with bun into
   `runtime/cicchetto-dist/`.
8. **`install_systemd.sh`** — installs + enables (doesn't start) the
   `grappa.service` unit.
9. **`install_nginx.sh`** — installs nginx config + the shared
   `infra/snippets/*.conf`, symlinks the PWA dist, starts/reloads nginx.
10. **Start + healthcheck** — `systemctl start grappa`, poll
    `/healthz` until it's green.

Re-running `install.sh` is safe: it never regenerates an
already-populated secret, never re-clones an existing checkout, and
every sub-script is independently idempotent.

## Secrets

Only `PHX_HOST` is a required manual input. Everything else
self-generates on first run into `/etc/grappa/grappa.env` (chmod 640,
`root:grappa`):

- `SECRET_KEY_BASE`, `SECRET_SIGNING_SALT` — Phoenix/Plug session
  secrets.
- `GRAPPA_ENCRYPTION_KEY` — Cloak vault key, encrypts stored
  IRC/NickServ credentials at rest. **Back this up separately, now.**
  Losing it makes every stored credential unrecoverable.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — Web Push keypair.
- `RELEASE_COOKIE` — BEAM distribution cookie (needed for
  `release.sh remote`).

See `infra/linux/grappa.env.example` for the full var reference
(optional knobs: `POOL_SIZE`, `LOG_LEVEL`, captcha provider, BEAM
resource caps).

## Exposing beyond localhost

Phoenix binds `0.0.0.0:$PORT` (not env-configurable — a
`config/runtime.exs` fact, not a Linux-substrate limitation).
**Firewall `$PORT` (default 4000) to localhost-only** before this host
is reachable from the internet — only nginx (127.0.0.1) should talk to
it directly.

This host's own nginx does **not** terminate TLS. The expected
topology (mirroring how the FreeBSD jail's `m42` host nginx works):
a separate machine you already run reverse-proxies your public
`https://` traffic to this host's nginx on port 80. Point that
upstream machine at this host, then:

```sh
TRUSTED_UPSTREAM_CIDR=<upstream box's address/CIDR> infra/linux/install_nginx.sh
```

to restrict nginx to only accept connections from that upstream (skip
this and nginx accepts from anywhere on port 80 — fine on a private
network, not fine once this host has a public IP and no CIDR set).

No certbot/ACME needed on this host — TLS is entirely the upstream
machine's job.

## Creating the first user

```sh
sudo -u grappa -H bash -c '
  export PATH="$HOME/.local/bin:$HOME/.asdf/shims:$PATH"
  set -a; . /etc/grappa/grappa.env; set +a
  cd /home/grappa/grappa
  MIX_ENV=prod mix grappa.create_user --name you --password "change-me"
'
```

Same task `INSTALL.md` uses for the Docker path. Runs via the
checkout's own mix/toolchain (not the compiled release) since it's a
mix task, not a `Grappa.Release.*` function.

Then log in via the web UI. To connect the bouncer to an IRC network,
see `README.md` "Bind a network".

## Day-2 operations

```sh
systemctl status grappa
systemctl restart grappa
journalctl -u grappa -f              # live logs (no file-based log on this substrate)
infra/linux/deploy.sh                # pull + rebuild + migrate + restart
```

**`infra/linux/release.sh eval`/`remote`/`rpc` are currently broken on
this substrate** (found live 2026-07-22) — even a trivial `eval '1 +
1'` crashes the BEAM immediately at kernel boot:

```
(no logger present) unexpected logger message: {log,error,...
Kernel pid terminated (logger) ({badarg,[{persistent_term,get,[code_server],...
```

This is a genuine BEAM/kernel-level crash, not application code (the
same trace appears for `1 + 1` as for `Grappa.Release.migrate()`),
isolated to the mix-release-generated `bin/grappa` script's `eval`
code path specifically — `remote` (live IEx console) and `rpc` share
the same boot variant, so they're presumed equally broken (not yet
individually re-tested).

What's confirmed NOT broken — ruled out a general toolchain/release
problem: raw `erl -eval '...' -noshell` (asdf-installed Erlang
directly, outside any release) works fine, and `bin/grappa start` —
the FULL boot, exactly what `grappa.service`'s `ExecStart` uses —
works fine too, getting as far as a real, expected, unrelated error
(missing migrations) with no kernel-level crash at all. So the bug is
specific to the release's minimal `start_clean` boot script variant
(used for `eval`/`remote`/`rpc`), not the release packaging or the
Erlang/Elixir installation in general. Root cause not yet identified —
plausibly an OTP 28.5-specific interaction with `--boot-var
RELEASE_LIB` and the persistent_term-based code-loading fast path.

Workaround in place: `install.sh`/`deploy.sh` run migrations via plain
`mix ecto.migrate` (sourcing the env file, `MIX_ENV=prod`) instead of
`release.sh eval 'Grappa.Release.migrate()'` — viable here because
this substrate keeps the full mix/asdf toolchain around permanently
(unlike a minimal prod container), so routing through the packaged
release for one-off tasks was never strictly necessary in the first
place. For a live console, `iex -S mix` in a plain (non-release) dev
checkout is the fallback until the actual boot-script bug is found.

## What's NOT here yet

Deliberately out of v1 scope (to keep the first install simple) — add
these later against the same conventions once the base install is
proven, using the FreeBSD equivalents as the pattern to follow:

- Hot/cold `Grappa.Deploy.Preflight` classification (`deploy.sh` here
  is always a full cold cycle).
- Cic-only hot bundle deploys (`infra/freebsd/jail_deploy_cic.sh`).
- DB query/write helpers (`infra/freebsd/jail_db_query.sh` /
  `jail_db_write.sh`).
- DB import/rollback tooling (`infra/freebsd/jail_import_db.sh`).

## Design notes (why this isn't a literal port of `infra/freebsd/`)

The FreeBSD jail's `rc.d` wrapper needed a hand-rolled synchronous
stop/start guard (`jail_beam_wait.sh`) because `bin/grappa daemon`
backgrounds via `run_erl` and `rc.d`'s async stop let a restart race a
still-draining old node into an epmd name collision (defect #9,
2026-06-11 outage). This substrate runs the release in the
**foreground** instead (`bin/grappa start`, systemd `Type=exec`) —
systemd tracks that PID directly, so `systemctl stop`/`restart` block
natively until the process actually exits. `lib/grappa/session/server.ex`'s
`terminate/2` already handles SIGTERM with a clean upstream QUIT
(issue #215), so this closes the same race at the root cause without
porting the FreeBSD wrapper's full machinery. `grappa_beam_wait.sh`'s
`wait-name-free` is kept as a defense-in-depth `ExecStartPre` guard,
not the primary sync mechanism. See comments in
`infra/linux/systemd/grappa.service` for the full rationale.
