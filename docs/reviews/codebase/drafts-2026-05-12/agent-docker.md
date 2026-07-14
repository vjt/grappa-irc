# Codebase Review Draft — Docker + Infra (SIMPLIFICATION focus)
**Agent:** docker
**Scope:** Dockerfile + compose.yaml (+ override.example, oneshot, prod.override) + scripts/*.sh + infra/nginx.conf + .env.example + .dockerignore + .github/workflows/
**Date:** 2026-05-12

After CP23's collapse the substrate is genuinely tight — single-stage, single compose, single boot path. Almost all findings here are simplification nibbles or drift-against-gospel debt, not structural rot. The two real bugs are (1) `deploy.sh` preflight regex misses two long-lived GenServers and (2) a stale committed `compose.prod.override.yaml` file that contradicts the gospel.

## CRITICAL

_None._

## HIGH

### H1 — `compose.prod.override.yaml` is committed but obsolete and shouldn't exist post-CP23

`/Users/mbarnaba/code/grappa/compose.prod.override.yaml` is checked into git. It hardcodes `192.168.53.12` (vjt's LAN IP) + `voygrappa.bad.ass` and pins a personal `PHX_HOST` — exactly the shape `compose.override.yaml.example` says belongs in the gitignored personal override.

CP23 collapsed prod into `--profile prod` — there is no longer ANY layered "prod compose" file. `_lib.sh`'s `COMPOSE_ARGS` does NOT reference it; nothing in `scripts/*.sh` reads it. `infra/nginx.conf:7` and `infra/snippets/security-headers.conf:13` still mention `compose.prod.yaml` in comments.

**Fix:** `git rm compose.prod.override.yaml`, add it to `.gitignore` (it's already shaped like a personal override; don't tempt operators), and grep-replace stale `compose.prod.yaml` doc references in `infra/nginx.conf` + `infra/snippets/security-headers.conf` with `compose.yaml`.

### H2 — `deploy.sh` long-lived-GenServer regex misses two real long-lived processes

`scripts/deploy.sh:110`:

```
local long_lived='lib/grappa/session/server\.ex|lib/grappa/session/[a-z_]+\.ex|lib/grappa/irc/client\.ex|lib/grappa/irc/auth_fsm\.ex|lib/grappa/ws_presence\.ex|lib/grappa/admission/network_circuit\.ex'
```

GenServers `use GenServer` enumeration (verified via grep on `lib/`):
- `lib/grappa/session/server.ex` ✓
- `lib/grappa/session/backoff.ex` ✓ (matched by `session/[a-z_]+\.ex`)
- `lib/grappa/irc/client.ex` ✓
- `lib/grappa/irc/auth_fsm.ex` ✓ (NOT matched by `session/[a-z_]+\.ex` because it's under `irc/`; explicitly listed — fine)
- `lib/grappa/ws_presence.ex` ✓
- `lib/grappa/admission/network_circuit.ex` ✓
- **`lib/grappa/visitors/reaper.ex` ✗ MISSING** — sweeper supervised under Application, lives across the deploy
- **`Phoenix.PubSub` / `Registry` / `Bandit.PhoenixAdapter` GenServers** — these are vendored, no defstruct edits possible by us, fine.

Reaper currently has no `defstruct` (state is bare map) but the comment in CLAUDE.md says "any defstruct line modified in a long-lived GenServer module" — Reaper qualifies. If a future change adds `defstruct [...]` to it, the preflight slips through and a hot-deploy stages a shape mismatch.

CLAUDE.md "Hot vs cold deploy" section explicitly enumerates `Session.Server, IRC.Client, AuthFSM, WSPresence, Admission.NetworkCircuit` — Reaper is missing from BOTH the regex AND the doc. Pick one source-of-truth and reflect both sides.

**Fix:** add `lib/grappa/visitors/reaper\.ex` to the regex; update CLAUDE.md "Hot vs cold deploy" enumeration.

Also note: the regex `lib/grappa/session/[a-z_]+\.ex` greedily matches **every file directly under session/**, including future modules that aren't long-lived (e.g. a hypothetical `Session.Wire` pure-fn module). False-positive cold deploy is the safer direction here, so leave it — but a comment explaining the broad match would prevent a future "tighten this regex" PR from removing the safety.

## MEDIUM

### M1 — Two committed compose.yaml local-state files leaking personal LAN IPs

Working tree contains `compose.override.yaml` (LAN-bound) AND `compose.prod.override.yaml`. Both gitignored — but `compose.prod.override.yaml` is also TRACKED (per `git ls-files` — see H1). The `compose.override.yaml` is gitignored AND not tracked, which is correct; flagging here only because a fresh contributor cloning the repo will see the `.example` and inherit no friction (good), while H1's tracked file would imprint vjt's LAN binding on every clone.

### M2 — `Dockerfile` `LABEL grappa.hot_deployable=true` is set + never read

`Dockerfile:60`:

```
LABEL grappa.hot_deployable=true
```

Comment says "CI image-build pipeline flips this to `false` when a tag-to-tag diff touches mix.lock... `scripts/hot-deploy.sh` reads the label." But:
1. `scripts/hot-deploy.sh` does not exist (CP23 S4 collapsed it into `deploy.sh`).
2. Neither `deploy.sh` nor any CI workflow inspects the label (`grep -r grappa.hot_deployable` returns only Dockerfile + a CP23 checkpoint reference).
3. CI doesn't compute it either — there's no `docker build --label grappa.hot_deployable=...` step.

So the label is decorative. Either wire it up (CI computes via the same preflight logic) or delete it + the obsolete comment. Simplification leans delete — `deploy.sh` git-diff preflight already covers the same intent at deploy time without coupling image-build to commit-classification.

### M3 — `compose.yaml`'s healthcheck `start_period: 180s` masks a 3-min cold-boot regression

`compose.yaml:91`: `start_period: 180s` for grappa. Comment says "first-deploy boot can take 2-3 min." If a future deploy regresses cold boot to 4 min, `start_period` doesn't catch it (containers stay "starting" indefinitely from operator POV; `deploy.sh`'s 240s wait loop would catch the real symptom, but only because of its own timeout). The 180s value also exceeds the 240s loop's effective "still-not-healthy" window by a thin margin (60s). Consider tightening `start_period` to 60s and letting actual boot failures surface as unhealthy faster — the bind-mount cold-recompile is a known one-time cost, not a steady-state concern.

Lower priority: this is observability, not functionality.

### M4 — `infra/nginx.conf` allowlist will silently miss new server routes

`infra/nginx.conf:83`:

```
location ~ ^/(auth|me|networks|healthz)(/|$) {
```

Allowlist of REST routes. Per CLAUDE.md "one feature, one code path, every door" — adding a new controller WILL silently 404 through nginx until the allowlist is updated. That's intentional (allowlist over denylist for security) but there's no automated check that `lib/grappa_web/router.ex` and this regex stay in sync. Quick `grep router.ex`:

- `/admin/*` (cic-bundle-changed, reload, healthz exists at /healthz separately) — intentionally NOT exposed via nginx (loopback only via `docker exec` in deploy.sh). Good.
- Any new pre-prod controller (e.g. visitors flow if exposed publicly later) needs both router AND nginx update. Hard to enforce in code; flag in checklist or add an integration test that walks `Phoenix.Router.routes/0` and asserts each public-prefix route is in the nginx regex.

Defer to a future hardening cluster; documenting here so the regex isn't viewed as drift-free.

### M5 — `compose.yaml` `cicchetto-build` service has UID-trap fix in comment but no mkdir guard

`compose.yaml:107-114` comment correctly identifies the named-volume root-owned-init trap and explains why it bind-mounts. But `deploy.sh:183` does `mkdir -p runtime/cicchetto-dist` to bootstrap the directory; `deploy-cic.sh:34` does the same. Anyone running `docker compose --profile prod up cicchetto-build` directly (not via deploy.sh) on a fresh clone bombs because `runtime/cicchetto-dist` doesn't exist yet — bind-mounting a nonexistent host path creates it as ROOT (Docker daemon owns), then UID-1000 container can't write.

**Fix:** add the directory to repo via `runtime/cicchetto-dist/.gitkeep` (consistent with the existing `runtime/.gitkeep`) so a fresh clone has the right ownership without operator intervention.

Same applies to `runtime/bun-cache` (created on-demand by `deploy.sh`).

### M6 — `_lib.sh` shellcheck shebang annotation is good, but Dockerfile + bin/start.sh use `#!/bin/sh` not `#!/usr/bin/env bash`

`bin/start.sh:1` uses `#!/bin/sh` and avoids bashisms (`:` for default + `$((...))` arithmetic + `exec` — all POSIX). Fine for production. Just calling out: the script comment says "same shell idioms work in dev + prod because MIX_ENV is the only env-distinguishing variable" — the actual reason the file works is it's POSIX-only, not because of MIX_ENV. Comment is misleading; tighten or delete.

### M7 — `register-dns.sh` is operator-only, non-POSIX (`set -euo pipefail`), and not invoked by any other script — not actually a problem, but it carries `--data-urlencode "token=..."` through `curl`, which leaks the token into `ps aux` on the host

`scripts/register-dns.sh:63-66`. On Linux, `curl --data-urlencode "token=..."` exposes the value in process listing for the duration of the call (~ms). Operator-only, ephemeral, low risk — but `--data-urlencode @-` with stdin-fed body would close the gap. Defer to a "harden operator scripts" pass; documenting only.

### M8 — `compose.yaml` `cicchetto-build` `working_dir: /app` + `oven/bun:1` image (not pinned to a digest)

`compose.yaml:117` — `image: oven/bun:1`. Floating tag. Same with `nginx:alpine` and the ELIXIR base in Dockerfile (`elixir:1.19-otp-28-alpine`). All three drift between rebuilds. CI doesn't pin either. The Elixir tag at least has Elixir + OTP version anchored; bun and nginx are completely floating.

For reproducibility, pin to digests via `image: oven/bun:1@sha256:<hash>`. Renovate/Dependabot has rules for this. Defer; flagging because it bites silently when you really need a deterministic build (e.g. bisecting a Vite-output hash drift).

## LOW

### L1 — `scripts/dialyzer.sh:9` comment refers to "named volume grappa_build" — gone post-CP23

The PLT cache lives in the bind-mounted `priv/plts/` directory now. Update or delete the comment.

### L2 — `compose.yaml` defines `networks: grappa_internal` but `cicchetto-build` doesn't join it (correct — it's a oneshot with no network needs); just calling out that the config could omit `networks:` from grappa + nginx if there's only one bridge

Cosmetic. The explicit network is fine for clarity. No action.

### L3 — `bin/start.sh` `set -e` (no `-u`, no `-o pipefail`)

Less paranoid than `_lib.sh`'s `set -euo pipefail`. The script is short enough that the difference is negligible, but for consistency with the rest of the repo, tighten.

### L4 — `compose.oneshot.yaml:23` comment says "boot Phoenix on port 4002 bound to localhost inside the container for tests" — verify still true

Tests `mix test` boot Phoenix on port 4002 (per `config/test.exs`). Comment is accurate; flagging because if test config drifts, the comment becomes wrong silently.

### L5 — `.dockerignore` lists `dist/` — there is no `dist/` at the repo root post-CP23

Cic dist now lives at `runtime/cicchetto-dist/` (already excluded via `runtime/`). The bare `dist/` line is dead but harmless. Delete for hygiene.

### L6 — `scripts/observer.sh` invokes `iex -S mix run -e ':observer_cli.start()'` — `mix run -e` inside `iex -S mix` is redundant

`iex -S mix` already loads the project. Then `-e ':observer_cli.start()'` is parsed as a `mix run` arg, not an iex arg. Works because `mix run -e CODE` is a thing, but the mental model is "run code at boot then drop to iex shell" — clearer as `iex -S mix -e ':observer_cli.start()'`. Cosmetic.

### L7 — `compose.yaml:66` comment about `:?` — actually wrong

Comment says: "Compose evaluates the `:?` only when the variable is consumed; with MIX_ENV=dev these stay unset and config/dev.exs fixed values cover them." But the actual env block uses `${SECRET_KEY_BASE:-}` (empty default), NOT `${SECRET_KEY_BASE:?}` (required-or-fail). The `:?` form is never used in this file. The behavior described is correct in spirit (env stays empty in dev), but the syntax referenced isn't there. Tighten the comment.

### L8 — `scripts/iex.sh` doesn't accept passthrough args

`iex -S mix` is hardcoded. If someone wants `iex --remsh grappa@127.0.0.1` or `iex --name foo@host -S mix`, they have to bypass the script. Add `"$@"` for forward compat.

### L9 — `.env.example:79` references `0x4AAAAAADIVjqhMXybemB6v` as the Turnstile site key for grappa.bad.ass

Site keys are public (designed to be embedded in HTML), so this is not a secret. But the example file says "Example site_key below is the registered prod Turnstile widget for grappa.bad.ass — replace with your own for local/other deployments." Combining "registered prod widget" + "grappa.bad.ass" in a public file is borderline corporate/personal context — vjt's deployment-specific data baked into the example. Replace with `0xAAAAAAAA-fake-site-key-for-example` and add a comment "register your own at https://www.cloudflare.com/products/turnstile/".

### L10 — `infra/snippets/security-headers.conf:13` says "Mounted into the nginx container at /etc/nginx/snippets/ via the nginx service `volumes:` block in compose.prod.yaml"

`compose.prod.yaml` doesn't exist anymore (CP23 collapse). Fix to `compose.yaml`.

## Simplification opportunities

| # | Opportunity | Effort | Payoff |
|---|---|---|---|
| **S1** | Delete `compose.prod.override.yaml` from git (H1). | trivial | removes drift + secret-ish LAN IP from public repo |
| **S2** | Delete `LABEL grappa.hot_deployable=true` + the dead-code comment in Dockerfile (M2). Already replaced by deploy.sh preflight; the label is decorative. | trivial | one fewer concept to explain |
| **S3** | Collapse `compose.oneshot.yaml` into `_lib.sh`'s `in_oneshot()` via inline `--service-name` flag overrides. The whole file is 4 service overrides; could be expressed as `compose run --rm --no-deps --service-ports=false grappa` plus a per-call `--name` override. Cuts a top-level YAML file. | medium | one fewer compose file in the repo root; easier mental model |
| **S4** | Move `bin/start.sh`'s entire content into the Dockerfile `CMD` as a JSON-array exec. The script is 8 effective lines (env defaults + ELIXIR_ERL_OPTIONS export + `exec mix phx.server`). Inline CMD reads as: `CMD ["sh", "-c", "GRAPPA_MAX_USERS=${GRAPPA_MAX_USERS:-100} ... exec mix phx.server"]`. Removes one `bin/` file, one filesystem hop, and the bin/ directory entirely (no other scripts live there). | low | -1 file, less indirection; downside is shell-quoting hell in the Dockerfile, so probably keep `bin/start.sh` and accept the trade |
| **S5** | Merge `scripts/credo.sh` + `dialyzer.sh` + `format.sh` + `test.sh` + `check.sh` into a single `scripts/mix.sh <task>` dispatch. They're all `mix <task>` wrappers with 1-2 lines of arg massaging. Each is 5-15 lines. | low | -4 files; downside is loss of tab-completion convenience and the "discoverability" of `ls scripts/` |
| **S6** | Drop `.dockerignore` entry `dist/` (L5). | trivial | tidier file |
| **S7** | Bake `runtime/cicchetto-dist/.gitkeep` + `runtime/bun-cache/.gitkeep` into the repo so `compose --profile prod up` works on fresh clone without operator running `mkdir -p` first (M5). | trivial | "git clone && docker compose --profile prod up" works without reading deploy.sh first |
| **S8** | Replace `scripts/healthcheck.sh`'s nginx-vs-direct branch with an unconditional `compose exec` against grappa (works in both profiles). The nginx hop is for "is nginx ALSO healthy" — that's `docker compose ps`'s job, not healthcheck.sh's. | low | one fewer branch |
| **S9** | Fold `scripts/observer.sh` into `scripts/iex.sh` as `iex.sh observer` subcommand. They both attach to the running container; observer is just a pre-run command. | low | -1 file |
| **S10** | The `e2e_export_uid` Linux-only special-casing in `_lib.sh` exists because Docker Desktop on macOS does ID translation but Linux doesn't. **All** scripts that bind-mount + UID-drop (`bun.sh`, the e2e flow) should call it; currently only integration.sh + testnet.sh do. Make `_lib.sh` call it unconditionally on source. Side effect (CONTAINER_UID exported in every script's shell) is harmless because compose.yaml already defaults it to 1000 when unset. | low | one less footgun for "next thing that needs the UID drop" |
| **S11** | `compose.override.yaml.example` ships TWO example shapes commented out + one uncommented `nginx:` block. Should be a single coherent shape (either dev or prod) commented out, with the alternate documented in the file header. Currently confusing — the uncommented `nginx:` block + grappa env override is the prod shape but readers see "dev shape" listed first commented out. | low | clearer onboarding |
| **S12** | Pin floating image tags (`oven/bun:1`, `nginx:alpine`, `elixir:1.19-otp-28-alpine`) to `@sha256:` digests + use Dependabot to bump (M8). | medium | bisectable builds; defense against base-image supply chain |

## Summary

- **0 CRITICAL, 2 HIGH, 8 MEDIUM, 10 LOW, 12 simplification opportunities.**

**Top 3 themes:**
1. CP23-collapse drift — comments and one tracked file (`compose.prod.override.yaml`) reference the pre-collapse world. Sweep for `compose.prod.yaml` mentions and `hot-deploy.sh` references; one tracked file needs to be deleted.
2. `deploy.sh` preflight regex needs `visitors/reaper.ex` and CLAUDE.md needs to match the regex (single source of truth for "long-lived GenServer" enumeration).
3. The substrate is genuinely simpler post-CP23 — most findings are nibbles, not structural. The remaining "could be simpler" wins are merging single-purpose scripts into `mix.sh`-dispatched subcommands and inlining `compose.oneshot.yaml`.

**Top 3 simplification opportunities:**
1. Delete `compose.prod.override.yaml` (S1) + LABEL dead-code (S2) + `dist/` from .dockerignore (S6) + stale comments — just rip the dead wood.
2. Bake `.gitkeep` files for `runtime/cicchetto-dist` and `runtime/bun-cache` (S7) so a fresh clone works without operator running pre-deploy mkdir.
3. Consolidate the `credo.sh` / `dialyzer.sh` / `format.sh` / `test.sh` / `check.sh` quartet into `mix.sh <subcmd>` dispatching (S5) — 4 fewer files in `scripts/`. Counter-argument: tab-completion + discoverability via `ls scripts/`. Gospel says "scripts are the only way to run things"; one-script-per-task IS the discoverability pattern. Probably leave as-is, mention only.
