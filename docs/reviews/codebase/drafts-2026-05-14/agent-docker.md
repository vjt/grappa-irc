# Codebase Review Draft — Docker / Scripts / Deploy infrastructure
**Agent:** docker
**Cluster:** no-silent-drops (B5 codebase review)
**Branch:** `cluster/no-silent-drops`
**Date:** 2026-05-14
**Scope:** `Dockerfile`, `compose.yaml` + override.example + oneshot, `bin/start.sh`, `scripts/*.sh` (20 files), `scripts/_lib.sh`, `infra/nginx.conf` + `infra/snippets/*`, `lib/grappa/hot_reload/long_lived_modules.ex`, `.dockerignore`, `mix.exs` release-relevant config, `.github/workflows/{ci,integration}.yml`, `.env.example`.

The substrate has tightened materially since 2026-05-12. The previously-tracked `compose.prod.override.yaml` is gone, `runtime/{cicchetto-dist,bun-cache}/.gitkeep` are baked in, the `.env.example` Turnstile key is genuinely placeholder. What remains are silent-drop hazards that align almost perfectly with this cluster's name: the deploy classifier has three categories of change that pass HOT preflight but cannot actually be hot-reloaded — and one of them is a known cluster-killer.

## Severity counts

| Severity | Count |
|---|---|
| CRIT | 0 |
| HIGH | 4 |
| MED | 6 |
| LOW | 7 |
| NIT | 3 |

**Top themes:**

1. **Hot-deploy preflight is the only line of defense (per CLAUDE.md), and it has 3 documented holes.** The known field-addition gap (H1) is the worst — Session.Server's `@type t :: %{...}` is a 70-line bare-map shape and field-additions inside that block silently classify HOT. Adding to that, new migrations (H2) and nginx config edits (H3) are silently dropped on hot deploy.
2. **CP23-collapse drift in comments/docs.** `infra/nginx.conf:5` still references `compose.prod.yaml` and `compose.prod.override.yaml` (both gone post-CP23 S4).
3. **Trajectory gaps for PUBLIC OPEN.** No nginx rate-limits, no `client_max_body_size`, no `gzip`, no SSL termination block. Image upload + push notifications + public-open will hit these one at a time.

---

## HIGH

### [HIGH] H1 — `deploy.sh` preflight regex misses field-additions inside multi-line `@type t :: %{...}` and `defstruct [...]` blocks
**File(s):** `scripts/deploy.sh:142`, `lib/grappa/session/server.ex:254-` (the multi-line `@type t :: %{` opens at line 254 and runs ~70 lines)

**Description:** The preflight greps with `^[+-]\s*(defstruct|@type t ::\s*%\{|def init\()`. This only matches the OPENING line of those constructs. `Grappa.Session.Server`'s state is a bare-map type stretching across ~70 lines. Adding a new field inside that block (the most common hot-reload-unsafe edit by far) produces diff lines like `+  new_field: integer(),` — none of which match the regex. Hot-deploy is permitted; the next callback pattern-matches the new shape against the old in-memory state; silent crash deferred to whenever the next field-touching message arrives, hours/days later.

This exact failure mode is documented in user memory `feedback_deploy_sh_preflight_field_addition_gap` and was the CP28 incident root cause. The fix has not landed. CLAUDE.md "Hot vs cold deploy" promises *"`deploy.sh` parses [`long_lived_modules.ex`] at preflight time so the doc + script + Dialyzer cannot drift"* — true at the file-list level, false at the field level. Same hole applies to `defstruct [\n  :a,\n  :b\n]` with field added inside the bracket block (Session.Server uses inline `defstruct` so it's not the worst offender there, but the SoT is `lib/grappa/visitors/reaper.ex:45` style — single-line — which IS caught; only the multi-line shapes in Server.ex + the bare-map types lose).

**Recommended fix:** Don't rely on diff-line regex for field detection. Use a "did the AST shape change" oracle:

```bash
# For each touched long-lived file, extract the @type t :: %{...} block
# and the defstruct keyword list at HEAD AND at the previous SHA, normalize
# whitespace, compare. Any non-whitespace difference → COLD.
```

Concretely: `git show "$from:$f"` + `git show "$to:$f"`, pipe each through a one-liner that captures everything between `@type t :: %{` and the matching `}` (or `defstruct [` and the matching `]`), trim whitespace + commas, diff. Differences → COLD. False positives (reordering keys) are acceptable — false negatives are the documented bug.

Even simpler stop-gap: any non-whitespace edit to a touched long-lived file that DOESN'T also pass `git diff --shortstat | grep "0 files changed"` → COLD. Conservative bias, and the existing comment in deploy.sh already endorses the philosophy.

### [HIGH] H2 — New migration files silently classified HOT, but hot path skips `mix ecto.migrate`
**File(s):** `scripts/deploy.sh:73-159` (preflight), `scripts/deploy.sh:177-188` (hot path), `scripts/deploy.sh:231-232` (cold-only `mix ecto.migrate`)

**Description:** A commit that adds `priv/repo/migrations/<ts>_<name>.exs` and nothing else passes preflight as HOT (no class matches). The hot path does `POST /admin/reload` — modules reloaded, no migrations executed. The new schema row never runs. The first query to a new column or table 500s; if Bootstrap reads it at the next supervision-tree restart, the BEAM crash-loops.

CLAUDE.md "Runtime Data → Migrations" already documents this danger: *"adding a column that Bootstrap reads races the supervision tree boot — when in doubt, `--force-cold`"*. User memory `feedback_cluster_with_migration_must_cold` records the CP29 R-Z lesson: *"Cluster with new migration MUST cold-deploy. deploy.sh hot path skips mix ecto.migrate; new tables → 500 on first query post-reload."* The fix has not landed in deploy.sh.

Relying on operator memory ("when in doubt, --force-cold") is incompatible with the CLAUDE.md gospel that *"Hot deploy preflight is the only line of defense"*.

**Recommended fix:** Add a Class 5 to preflight:

```bash
# Class 5: schema changes — hot path doesn't run migrations.
if echo "$changed" | grep -qE '^priv/repo/migrations/'; then
    echo "  → new/edited migration → COLD"
    return 1
fi
```

Same for `priv/repo/seeds.exs` if you ever wire one in.

### [HIGH] H3 — nginx config + security-headers snippet edits silently dropped on hot deploy
**File(s):** `scripts/deploy.sh:73-159` (preflight), `scripts/deploy.sh:237` (cold-only nginx force-recreate)

**Description:** A commit that edits `infra/nginx.conf` or `infra/snippets/security-headers.conf` (e.g. tightening CSP, adding a new REST route to the allowlist, fixing a `proxy_*` directive) passes preflight as HOT. The hot path only POSTs `/admin/reload` to grappa — nginx is never reloaded. The new config sits on disk, the running nginx serves the old config until the next cold deploy or container restart.

This is a classic silent-drop. The CSP allowlist drift is particularly bad: a new captcha provider added to the allowlist won't actually take effect, and the operator can't see why captcha widgets 404 under CSP — exactly the hCaptcha class of bug already recorded in `infra/snippets/security-headers.conf:30` ("codebase review 2026-05-12 cic H2 root cause").

**Recommended fix:** Add Class 6:

```bash
# Class 6: nginx config — hot path doesn't reload nginx.
# (Could shell out to `docker exec nginx nginx -s reload` instead, but
# that complicates the hot path; cold-deploy is conservatively safer.)
if echo "$changed" | grep -qE '^infra/(nginx\.conf|snippets/)'; then
    echo "  → nginx config changed → COLD"
    return 1
fi
```

If you want to stay HOT for nginx-only edits, add a third path: `scripts/deploy-nginx.sh` that does `docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload`. But classifying these as COLD is the simpler safety-first answer.

### [HIGH] H4 — `infra/nginx.conf` doc comment references `compose.prod.yaml` + `compose.prod.override.yaml` (both gone post-CP23 S4)
**File(s):** `infra/nginx.conf:5-9`

```nginx
# Single user-facing surface for the bouncer + cicchetto PWA. Listens on
# :80 inside the container; the host port-publish lives in
# compose.prod.yaml (default `3000:80`) or compose.prod.override.yaml
# (typical: bind to a LAN/VLAN IP on :80). Serves the static SPA dist
# (built by the cicchetto-build compose service into the
# cicchetto_dist named volume) and reverse-proxies the bouncer's REST +
```

**Description:** Both `compose.prod.yaml` and `compose.prod.override.yaml` were collapsed away in CP23. Current state: single `compose.yaml` with `--profile prod` for nginx + cicchetto-build, port-publish from `${NGINX_PUBLISH:-3000:80}` (no longer "named volume cicchetto_dist" — it's a host bind-mount at `runtime/cicchetto-dist/`). Two errors in five lines:
1. file references that don't exist
2. "cicchetto_dist named volume" claim — it's a host bind-mount

Doc-comment drift looks harmless but it's the kind of thing the next operator (or Claude session) reads literally and tries to act on. The 2026-05-12 review's L10 already flagged the snippets file; this is the parallel finding for the main nginx.conf which the prior pass missed.

**Recommended fix:** Rewrite to:

```nginx
# Single user-facing surface for the bouncer + cicchetto PWA. Listens on
# :80 inside the container; the host port-publish lives in compose.yaml
# under `--profile prod` (default `${NGINX_PUBLISH:-3000:80}`) or in the
# gitignored compose.override.yaml (typical: bind to a LAN/VLAN IP on :80).
# Serves the static SPA dist (built by the cicchetto-build compose oneshot
# into ./runtime/cicchetto-dist host bind-mount) and reverse-proxies the
# bouncer's REST + WS surface to grappa:4000 ...
```

---

## MED

### [MED] M1 — `.env.example` defaults `PHX_HOST=grappa.bad.ass`, baking the canonical-deployment hostname into a public template
**File(s):** `.env.example:63`

```
# Public hostname the bouncer is reached at via nginx. Defaults to
# grappa.bad.ass (the home-LAN deployment). Override here if your
# deployment lives elsewhere — Phoenix's `check_origin` rejects
# WebSocket handshakes whose Origin header doesn't match this.
PHX_HOST=grappa.bad.ass
```

**Description:** A new contributor cloning the repo, copying `.env.example` to `.env`, will inherit `PHX_HOST=grappa.bad.ass`. Either they notice and edit (annoying but fine) or they don't and Phoenix rejects every WS handshake with no clear "your PHX_HOST is wrong" hint. Per CLAUDE.md *"Personal bindings (LAN/VLAN IP for inbound, `PHX_HOST`) live in gitignored `compose.override.yaml`"* — `PHX_HOST` is explicitly named as personal, but here it ships as committed default with the home-LAN value.

This also borderline-violates user memory `feedback_no_corporate_context_public` ("never name vjt's employer or corporate-installed software in commits/PRs/docs") — `grappa.bad.ass` is a personal domain not corporate, but the principle (no deployment-specific identifiers in public artifacts) extends.

**Recommended fix:** Comment out the default:

```
# PHX_HOST=your-grappa-host.example.com
```

Same treatment as `GRAPPA_CAPTCHA_PROVIDER` etc. further down — those use the comment-out pattern correctly.

### [MED] M2 — `bin/start.sh` is `#!/bin/sh` but uses `$((...))` arithmetic + `:=` defaults — POSIX-borderline + lacks `-u -o pipefail`
**File(s):** `bin/start.sh:1`, `bin/start.sh:35`

**Description:** Shebang `#!/bin/sh`, only `set -e` (no `-u`, no `-o pipefail`). The arithmetic + parameter expansion forms in use (`$((GRAPPA_MAX_USERS * 400))`, `: "${GRAPPA_DIRTY_SCHEDULERS:=$(nproc)}"`) ARE POSIX, so the script works. But the rest of the repo standardises on `#!/usr/bin/env bash` + `set -euo pipefail` (per CLAUDE.md "Bash 4+ required"). Mixing POSIX-sh + bash strict mode across the surface area is a footgun: a future edit that adds a bash-only construct (`[[ ... ]]`, arrays, `local`) silently breaks under `/bin/sh` → `dash` on Debian-based runtime images.

Also — alpine's busybox provides `nproc` since ~3.13 so `$(nproc)` works. But if a future deploy moves off alpine to a slimmer base lacking nproc, the default goes empty → `+SDcpu  +SDio` → BEAM rejects empty integer args → boot crash. Defensive default would be `$(nproc 2>/dev/null || echo 4)`.

**Recommended fix:** Either:
1. Convert to `#!/usr/bin/env bash` + `set -euo pipefail` for consistency with the rest of the repo (CLAUDE.md gospel), OR
2. Keep POSIX but add `set -eu` (no `-o pipefail`, that's bash-only) and the `nproc` fallback.

Option 1 is simpler and matches the standing rule.

### [MED] M3 — No nginx rate limits, `client_max_body_size`, or `limit_conn` — PUBLIC OPEN trajectory blocker
**File(s):** `infra/nginx.conf` (entire file)

**Description:** Per the project trajectory in CLAUDE.md / memory `project_post_p4_1_arc` (post-CP30 cluster arc), the path forward is push notifications → image upload → voice → mobile polish → PUBLIC OPEN. Once the bouncer is reachable from the open internet:

- No `limit_req_zone` / `limit_req` → trivial to flood `/auth/login` with credential-stuffing attempts.
- No `limit_conn` → single client can exhaust upstream pool by opening N concurrent WS upgrades.
- No `client_max_body_size` (nginx default 1 MB) → image upload (memory `project_image_upload`) will hit "413 Request Entity Too Large" the moment cic POSTs anything beyond 1 MB; operator will debug-spiral on the cic side before noticing nginx.
- No `gzip on` for the static SPA — every cic page load wastes bytes for no reason.
- No SSL termination block at all (commented or otherwise) — the deployment-time TLS posture is "another reverse proxy in front" which is fine but undocumented.

This isn't a bug TODAY (the bouncer is loopback-only / LAN-only). It IS a deploy-blocker for PUBLIC OPEN. Better to land scaffolding now (commented-out `limit_req_zone` directive in the `http {` block + a `# enable for public open` comment) than discover during the public-open scramble.

**Recommended fix:** Add to `http { ... }` (commented or actively):

```nginx
# Rate limits — enable before PUBLIC OPEN.
# limit_req_zone $binary_remote_addr zone=auth:10m rate=10r/m;
# limit_conn_zone $binary_remote_addr zone=conn:10m;
client_max_body_size 16m;   # image upload (memory project_image_upload)
gzip on;
gzip_types text/css application/javascript application/json image/svg+xml;
gzip_min_length 1024;
```

And in `location /auth { ... }` once it lands: `limit_req zone=auth burst=5 nodelay;` plus `limit_conn conn 32;` on `/socket`.

### [MED] M4 — `compose.yaml` healthcheck `start_period: 180s` exceeds deploy.sh's 240s wait by a thin margin; also the wait loop's 120 × 2s sleep gives 240s, not the 240s claimed in the comment
**File(s):** `compose.yaml:88-93`, `scripts/deploy.sh:243-251`

```yaml
start_period: 180s
retries: 5
```

```bash
for i in $(seq 1 120); do
    if docker compose ... ; then ... ; fi
    sleep 2
done
die "grappa did not become healthy within 240s. ..."
```

**Description:** Two related issues:
1. `start_period` is the window during which failed probes don't count toward `retries`; the actual healthy-flip happens at first 200. So the 180s start_period is mostly informational. But `retries: 5` × `interval: 5s` = 25s of failure window AFTER start_period ends — total tolerance window is 180+25 = 205s before compose marks the container "unhealthy". deploy.sh's loop runs 240s. So if cold boot takes 200-240s, deploy.sh's loop succeeds (probe direct) but compose sees the container unhealthy → `compose up` would have errored out earlier with `--wait` (deploy.sh doesn't use `--wait` so this only matters if a future caller adds it).
2. The `die` message says "240s" but the loop runs `for i in $(seq 1 120)` × `sleep 2` which is 240s of sleeps PLUS ~120 × ~50ms of `docker compose exec` overhead = ~246s. Off-by-a-bit, harmless.

The healthcheck values predate CP23's bind-mount-cold-recompile reality. Worth tightening `start_period` to 60s + raising `retries` to 36 (3 minutes total tolerance, but failure-state visible in `compose ps` after the first 60s instead of 180s of "starting").

**Recommended fix:** Tighten:

```yaml
healthcheck:
  test: [...]
  interval: 5s
  timeout: 5s
  start_period: 60s   # cold recompile is one-time after deps.get; subsequent boots <30s
  retries: 36         # 3 min total tolerance (36 × 5s = 180s)
```

And update the deploy.sh `die` message to match the actual budget: 120 × 2s = 240s.

### [MED] M5 — `scripts/deploy.sh` checks `branch != main` but worktree-based development means deploys SHOULD land from main only — yet `ALLOW_DEPLOY_FROM_BRANCH=1` escape hatch exists with no audit trail
**File(s):** `scripts/deploy.sh:60-63`

```bash
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ] && [ "${ALLOW_DEPLOY_FROM_BRANCH:-}" != "1" ]; then
    die "deploy.sh refuses to run on branch '$branch'. Set ALLOW_DEPLOY_FROM_BRANCH=1 to override."
fi
```

**Description:** The escape hatch is fine — sometimes you need to deploy from a feature branch for live debugging. But it leaves no audit trail (no `git log` annotation, no operator log line distinguishing "this deploy was from a branch"). If a wrong-branch deploy lands in prod and stays there for hours, the only way to notice is by `docker exec grappa cat HEAD-DEPLOYED-FROM` (which doesn't exist).

Lower priority because the gospel is "merge to main first, then deploy" and operators follow it. But for a public-open service the audit gap matters.

**Recommended fix:** When `ALLOW_DEPLOY_FROM_BRANCH=1` is exercised, prepend a stderr-loud warning AND write the deploying SHA + branch to `runtime/last-deploy.txt` (or just log it via `Logger.warning` via a `mix grappa.log_deploy` task). Smallest change:

```bash
if [ "$branch" != "main" ]; then
    if [ "${ALLOW_DEPLOY_FROM_BRANCH:-}" = "1" ]; then
        echo "⚠️  WARNING: deploying from branch '$branch' (not main) — sha=$(git rev-parse --short HEAD)" >&2
    else
        die "..."
    fi
fi
```

### [MED] M6 — `long_lived_modules.ex` parser regex matches `@typedoc` union members AND silently drops ungrep-matchable casings
**File(s):** `scripts/deploy.sh:128`, `lib/grappa/hot_reload/long_lived_modules.ex:110-126`

**Description:** The deploy.sh parse line is `grep -E '^\s+Grappa\.[A-Za-z_.0-9]+,?$'` against `long_lived_modules.ex`. This matches `@modules`, `@state_helpers` AND the `@type long_lived ::` and `@type state_helper ::` union members further down — Backoff and AwayState appear DUPLICATED in the parsed list (verified by reproducing the parse). This is harmless because `grep -Fxf` deduplication on the file paths makes dupes idempotent.

But it does mean the SoT-comment claim *"`scripts/deploy.sh` parses [these] at preflight time so the doc + script + Dialyzer cannot drift"* is half-true: the typedoc unions are an UNTRACKED parallel list. If someone updates `@modules` but forgets the `@type long_lived ::` union, Dialyzer DOES catch it (per the moduledoc), but the deploy.sh regex silently picks up both — the bug surface is that the typedoc duplication is acting as a load-bearing parser-input despite the comment saying it's just doc + Dialyzer. Brittle.

The deeper issue: the regex is text-based, not AST. If someone wraps a module name in a longer expression (`Grappa.Foo.Bar |> some_macro()` on one line), the regex misses; if someone adds a comment after the atom (`Grappa.Foo, # explain`), the file-comment WARNING in the SoT explicitly says no — but a future edit in good faith could break it without the deploy.sh erroring (the `if [ -z "$module_atoms" ]` guard only catches "completely empty" — not "missed half").

**Recommended fix:** Move from text-grep to AST. Either:
1. Have a tiny `mix grappa.print_long_lived_files` task that prints the file paths line-by-line (using `Code.eval_file/1` + `apply/3`); deploy.sh shells out to it. Boundary-clean, hot-reload-aware, no parser drift.
2. Tighten the comment + add a sanity assertion: parsed count must equal `length(@modules) + length(@state_helpers) + length-of-typedoc-unions`, otherwise die.

Option 1 is the right answer — it crosses a one-shot mix invocation but the deploy.sh already does `compose run --rm --no-deps grappa mix deps.get`/`mix ecto.migrate`, so the cost is negligible.

---

## LOW

### [LOW] L1 — `compose.oneshot.yaml:1` comment references `compose.prod.yaml` (CP23 collapse drift)
**File(s):** `compose.oneshot.yaml:1`

```yaml
# grappa — oneshot override (layered AFTER compose.yaml or compose.prod.yaml).
```

**Description:** `compose.prod.yaml` doesn't exist. Last drip of the same drift class as H4.

**Recommended fix:** `# grappa — oneshot override (layered AFTER compose.yaml + optional compose.override.yaml).`

### [LOW] L2 — `compose.oneshot.yaml:18` comment claims oneshots "boot Phoenix on port 4002" — verify still true
**File(s):** `compose.oneshot.yaml:18`

**Description:** Carried over from prior review's L4. The comment says oneshots boot Phoenix on 4002 for tests. Worth verifying against `config/test.exs` periodically — if test config drifts to a different port, this comment becomes silently wrong.

**Recommended fix:** Either drop the port-specific claim ("...inside the container for tests, and exit") or assert `config :grappa, GrappaWeb.Endpoint, http: [port: 4002]` is still in `config/test.exs` in the same commit that touches this comment.

### [LOW] L3 — `Dockerfile` floating image tags (`elixir:1.19-otp-28-alpine`); `compose.yaml` uses `oven/bun:1` + `nginx:alpine`
**File(s):** `Dockerfile:16`, `compose.yaml:118`, `compose.yaml:134`

**Description:** Carried from prior review M8. None of these are pinned to digests. CI doesn't pin either. Bisecting a Vite-output hash drift or an alpine-libc bump becomes detective work. Defer to a hardening pass; flag because it bites silently.

**Recommended fix:** Pin to `@sha256:...` digests once + Dependabot/Renovate to bump. Lowest cost first: pin `nginx:alpine` (rarely changes) + `elixir:1.19-otp-28-alpine` (anchored already by the version tag — pin removes alpine version drift).

### [LOW] L4 — `bin/start.sh:1` shebang + `set -e` only (no `-u` no `-o pipefail`)
**File(s):** `bin/start.sh:1,35`

**Description:** Repeats prior review L3. `bin/start.sh` is the container entrypoint. A typo in env var name → bash 3.x silently substitutes empty → `+P 0` → BEAM aborts with cryptic message. `set -u` would catch this at shell time. See M2 for the bigger version of this finding.

**Recommended fix:** See M2 — converge with M2's recommendation.

### [LOW] L5 — `scripts/iex.sh` doesn't accept passthrough args (no `"$@"`)
**File(s):** `scripts/iex.sh:15`

**Description:** Carried from prior review L8. `iex -S mix` is hardcoded. Prevents `iex.sh --remsh ...` or `iex.sh --name foo@host -S mix`. Trivial fix.

**Recommended fix:**

```bash
docker compose "${COMPOSE_ARGS[@]}" exec grappa iex "$@" -S mix
```

(Note: `"$@"` BEFORE `-S mix` so `--name` etc. attach to iex, not mix.)

### [LOW] L6 — `scripts/observer.sh:15` invokes `iex -S mix run -e ':observer_cli.start()'` — `mix run -e` inside `iex -S mix` is mental-model-noise
**File(s):** `scripts/observer.sh:15`

**Description:** Carried from prior review L6. `iex -S mix` already loads the project; `-S mix run -e ':observer_cli.start()'` parses as iex passing the rest to `mix run -e` (which works) but reads as "run code at boot then drop to iex shell". Cleaner: `iex -S mix -e ':observer_cli.start()'` or `iex -e ':observer_cli.start()' -S mix`.

**Recommended fix:** `iex -e ':observer_cli.start()' -S mix`.

### [LOW] L7 — `.dockerignore` lists `dist/` — there's no top-level `dist/` post-CP23
**File(s):** `.dockerignore:11`

**Description:** Wait — checking again: actual `.dockerignore` is short (29 lines). It does NOT have a bare `dist/` line; cic dist lives at `runtime/cicchetto-dist/` and is excluded by `runtime/`. Prior review L5 was already fixed. Withdraw this finding; flagging here as "verified, no action".

**Recommended fix:** None. Marker for the noisy-finding category.

---

## NIT

### [NIT] N1 — `compose.yaml:107-115` long comment about cicchetto-build's UID trap repeats info already in `feedback_named_volume_uid_trap` memory; consider a `# see ...` reference instead of full re-explanation
**File(s):** `compose.yaml:107-115`

**Description:** The 9-line comment is correct + useful, but the same lesson is already explained 4 places in the codebase (this comment, `compose.yaml:51-56`, `cicchetto/e2e/compose.yaml:171-179`, `feedback_named_volume_uid_trap`). Consolidate to one canonical location + cross-reference.

**Recommended fix:** Inline pattern: `# Why bind-mount: see CLAUDE.md "Bind-mount shadows..." or memory feedback_named_volume_uid_trap.`

### [NIT] N2 — `scripts/_lib.sh:84-87` mentions `WRITABLE_LOCK=1` escape hatch — undocumented in CLAUDE.md
**File(s):** `scripts/_lib.sh:84-87`

**Description:** The escape hatch exists for a reason but isn't surfaced in CLAUDE.md "How to run scripts" — operator wouldn't know to reach for it. Either add a sentence to CLAUDE.md, or drop the escape hatch (deps additions probably warrant a `scripts/deps-add.sh` shell anyway).

**Recommended fix:** One-line add to CLAUDE.md "How to run scripts": `WRITABLE_LOCK=1 scripts/mix.sh deps.get  # writable mix.lock from a worktree (needed for adding deps)`.

### [NIT] N3 — `scripts/healthcheck.sh:21` falls back to `in_container curl ...` if nginx isn't running, but `in_container` dies with "container is not running" if grappa is also down — error message is confusing for an operator just trying to confirm "is anything up?"
**File(s):** `scripts/healthcheck.sh:16-23`

**Description:** When neither grappa nor nginx is running, the error reads "grappa container is not running" — true but unhelpful. Better signal: "nothing's up — try `scripts/deploy.sh` or `docker compose up`".

**Recommended fix:** Cosmetic. Replace the bare `die` in `_lib.sh:139` with a more helpful message, or wrap healthcheck.sh's branch with its own die.

---

## Trajectory risks

The cluster is named "no-silent-drops" — and the deploy classifier has THREE silent-drop categories (H1, H2, H3) all in the most-blast-radius surface in the repo. Land all three before any of the trajectory items below.

### Push notifications (next cluster)
- Web Push needs a service worker route that nginx serves uncached (already exists at `location = /sw.js`).
- VAPID keys go in env (`GRAPPA_VAPID_PUBLIC_KEY` + `GRAPPA_VAPID_PRIVATE_KEY`). Add to `.env.example` + `compose.yaml` env block + `runtime.exs`.
- Background dispatcher: GenServer per user OR a single Oban-like queue? Either way, add to `lib/grappa/hot_reload/long_lived_modules.ex` AND ensure deploy.sh preflight catches a `defstruct` change in the new GenServer (the regex already covers single-line `defstruct`; multi-line catches the H1 bug).
- VAPID private key is sensitive — Cloak.Vault encryption at rest like SASL passwords, not bare env (per CLAUDE.md "Security").

### Image upload (next cluster's next)
- M3 above: add `client_max_body_size 16m;` to nginx — without it, cic POST 413s silently as far as cic logs.
- Per memory `project_image_upload`: cic uploads via litterbox.catbox.moe (third-party), so nginx doesn't actually proxy the upload. But if that decision flips to self-hosted, M3 becomes a CRIT not a MED.
- CSP `connect-src` will need `https://litterbox.catbox.moe` — `infra/snippets/security-headers.conf` allowlist update. Per H3, that change WILL silently drop on hot deploy. Land H3 first.

### Voice (later)
- WebRTC needs `connect-src` allowlist for STUN/TURN endpoints. Same H3 risk.
- TURN credentials → Cloak.Vault.
- Probably needs WebSocket payload-size cap raised; Bandit defaults are conservative.

### Mobile polish + PUBLIC OPEN
- M3 rate limits become CRIT.
- nginx needs an HTTPS server block (currently absent — assumes external proxy terminates TLS). Document the assumption in `infra/nginx.conf` head comment OR add the SSL block.
- `PHX_HOST` and `EXTRA_CHECK_ORIGINS` in `.env.example` should make the "this is per-deployment, not a default" point loud (M1).
- `register-dns.sh` is operator-only / Technitium-specific; document that it's NOT part of the deploy flow + the cloud-DNS alternative (Route53 / Cloudflare API).
- Sobelow currently ignores `Config.HTTPS` (`mix.exs:60`) — re-enable as part of public-open hardening.
- T31 admission is wired but currently `disabled` provider by default. Public open requires Turnstile/hCaptcha set; the `compose.yaml:80` defaults are correct (disabled) but `.env.example` should make the switch loud.
- The deploy `--force-cold` escape hatch (M5) needs its audit-trail story figured out before public open.

### Overall verdict
Substrate is healthy. The 4 HIGH findings are all in `scripts/deploy.sh`'s preflight — fixing them is a single PR. The trajectory risks are all "land scaffolding now while it's cheap" rather than active bugs. Fix the silent drops.
