# Docker substrate scope — 19 findings (1 CRIT, 7 HIGH, 8 MED, 3 LOW)

Scope: `Dockerfile`, `compose.yaml`, `compose.override.yaml.example`,
`compose.oneshot.yaml`, `.dockerignore`, `.env.example`, all
`scripts/*.sh`, `bin/grappa`, `bin/start.sh`, `infra/nginx.conf`,
`infra/snippets/security-headers.conf`, `cicchetto/e2e/nginx-test.conf`.

Primary lens: simplification. Lots of duplication (admin-allowlist
regex three places, healthcheck two probes, four `docker exec grappa`
escape hatches around `_lib.sh`, two compose-merge strategies, two
healthcheck shells) and a few real preflight gaps in `deploy.sh`. The
substrate is in much better shape than the rest of the codebase — but
it still leaks complexity through duplication.

---

### S1. `deploy.sh` preflight regex is structurally fragile — silently widens to ALL `Grappa.*` references in the SoT file
**File:** `scripts/deploy.sh:128`, `lib/grappa/hot_reload/long_lived_modules.ex:112-130`
**Category:** preflight-gap / fragility
**Severity:** CRITICAL

`scripts/deploy.sh` parses the SoT module list with:

```
grep -E '^\s+Grappa\.[A-Za-z_.0-9]+,?$' "$sot_file"
```

This regex matches **any** line that's "indented + `Grappa.X.Y[,]` +
EOL". In the current SoT file it matches 14 lines, but only 12 of them
are `@modules` / `@state_helpers` entries — the other 2 are typespec
lines (`Grappa.Session.Backoff` at L113, `Grappa.Session.AwayState` at
L128 — the leading union members of the `@type long_lived` /
`@type state_helper` declarations). They happen to be duplicates of
real entries, so today the bug is benign.

But the regex has **zero structural coupling** to the `@modules` or
`@state_helpers` attribute names — anything matching the surface shape
will be picked up. The SoT module's own moduledoc warns:

> ⚠️  This list is parsed by `scripts/deploy.sh` via a stable
> `grep` pattern. KEEP one module per line, fully-qualified, no
> trailing comments on the same line. […] Anything that breaks
> that shape will silently drop modules from the preflight check.

— but the failure mode is the inverse too: anything that **matches the
shape but isn't a real entry** silently gets added. Two examples of
how this breaks in normal future edits:

1. **Removing a module from `@modules` while it stays in the
   `@type long_lived` union** (a perfectly likely refactor mistake):
   the typespec line keeps it in the deploy-preflight list → false-COLD
   on every change to a module that's no longer actually tracked.
   Cost: confusing, eventually ignored.

2. **Adding a module to the `@type long_lived` union but forgetting
   `@modules`** (the OPPOSITE mistake, much more dangerous): the
   typespec line covers it, deploy-preflight appears to track it. The
   `Dialyzer` warning the moduledoc promises (`underspecs` →
   `contract_supertype`) catches this for `modules/0` return type
   divergence — but only if `modules/0` is actually called somewhere
   that exercises the constraint. If a future contributor follows the
   moduledoc step-list and adds the typespec entry but skips
   `@modules`, the deploy passes, hot-deploy doesn't refuse, and the
   incident is a re-run of CP28.

3. **A new attribute** (e.g. `@experimental_modules` introduced later
   with the same one-per-line shape) silently inflates the preflight
   list with modules that aren't supposed to be there.

The fix is structural: parse the actual `@modules` / `@state_helpers`
attribute blocks, not "anything Grappa-shaped in the file".

**Fix:** Either:
- Move the parsing to `awk` and require the line to come BETWEEN the
  `@modules [` opener and the matching `]` closer (and same for
  `@state_helpers`). Reject anything outside those blocks.
- OR, much simpler — emit the list from Elixir at deploy time:
  `mix run -e 'Grappa.HotReload.LongLivedModules.all() |> Enum.each(&IO.puts/1)'`.
  The script becomes a thin wrapper, the SoT is the only definition,
  no regex at all. Costs a ~2s mix boot but the preflight is already
  doing a docker-compose container start for `cicchetto-build` later
  so the absolute wall-clock impact is invisible. Bonus: handles
  module renames / typespec evolution / etc. for free.

The second approach also kills the awk helper at
`scripts/_extract_state_block.awk` if the SoT module exposes a
"shape-fingerprint" function — `defstruct(SomeMod) |> hash` is one
line of Elixir per tracked module. Massive simplification surface,
not just a bug fix.

---

### S2. nginx admin allowlist hardcoded in THREE files — schema drift waiting to happen
**File:** `infra/nginx.conf:136`, `cicchetto/e2e/nginx-test.conf:86,153`, `lib/grappa_web/router.ex:102-131`
**Category:** duplication / drift-risk
**Severity:** HIGH

The list of admin REST resources lives in three places that must stay
in lockstep:

```
# infra/nginx.conf:136
location ~ ^/admin/(visitors|sessions|credentials|networks|reaper|circuit|users|me|settings|uploads)(/|$)

# cicchetto/e2e/nginx-test.conf:86  (:80 block)
location ~ ^/admin/(visitors|sessions|credentials|networks|reaper|circuit|users|me|settings|uploads)(/|$)

# cicchetto/e2e/nginx-test.conf:153 (:443 block)
location ~ ^/admin/(visitors|sessions|credentials|networks|reaper|circuit|users|me|settings|uploads)(/|$)

# lib/grappa_web/router.ex:102 — `scope "/admin", GrappaWeb.Admin`
```

That's the regex repeated three times across two files. The router
scope is the actual source of truth (M-9b convention in CLAUDE.md:
*"every admin resource MUST add resource name to BOTH infra/nginx.conf
+ cicchetto/e2e/nginx-test.conf — both :80 + :443"*). The nginx-test
file even has a comment "Keep in lockstep with infra/nginx.conf when
adding routes" — acknowledging the drift risk and parking it.

A new admin resource added to the router (this happens every other
cluster — M-3 added 4, M-9b added 2, UX-6-B1 added 2) requires THREE
identical regex edits. The CLAUDE.md M-9b incident memo
(`feedback_nginx_admin_allowlist_required`) is exactly this class of
bug fired in anger.

The :80 and :443 blocks in `nginx-test.conf` are a near-copy of each
other anyway (whole locations duplicated). The same locations
duplicate from the prod nginx.conf "because nginx can't include a
file inside two server blocks cleanly." That's true for `server { }`
blocks but **not** for `location` blocks — nginx `include` is happy
to drop locations into a server block.

**Fix:** Extract the repeated locations into
`infra/snippets/locations.conf` (or split per concern:
`locations-rest.conf`, `locations-admin.conf`, `locations-spa.conf`)
and `include` them inside each `server { }`. Same mechanism already
exists for `security-headers.conf` and the comment on that snippet
explains exactly why this is the lesson. The admin-resource list
appears once. Bonus: nginx-test's :80 and :443 blocks become two
trivial wrappers around the same includes.

Even better, push further: replace the regex enumeration with a
generic `location ^~ /admin/ {}` proxy block, and let the `:admin`
loopback gate + `:admin_authn` plug do their job at the BEAM. The
nginx allowlist provides nearly zero security value — it merely
404s admin routes that haven't been listed, which is "fail-closed
against operator forgetfulness" rather than a real threat surface.
The bouncer already returns 403 from `:admin_authn` for the same
inputs. If nginx is acting as a "stops admin paths leaking", that's
defense in depth that's costing one drift incident per cluster.

---

### S3. `deploy.sh` preflight regex misses Class 1's other failure mode: `mix.exs`/`mix.lock` in subdirectories
**File:** `scripts/deploy.sh:95,103,180,191,202`
**Category:** preflight-gap
**Severity:** HIGH

Class 1-6 regexes are all anchored:

```
'^(mix\.lock|mix\.exs)$'
'^lib/grappa/application\.ex$'
'^(Dockerfile|compose\.yaml|bin/start\.sh)$'
'^priv/repo/migrations/'
'^infra/(nginx\.conf|snippets/)'
```

Gaps:
- **`compose.override.yaml`** isn't covered — if the override changes
  in a way that affects boot (PHX_HOST, env injection, port binding),
  hot-deploy doesn't recreate the container so the change is silently
  ignored. The override file is gitignored, so realistically a
  `compose.override.yaml` edit doesn't show up in `git diff` anyway —
  but its companion `compose.override.yaml.example` could be edited
  and the operator may sync it manually, with no preflight signal.
- **`compose.oneshot.yaml`** isn't covered — same risk profile as
  `compose.yaml`, no anchor.
- **`bin/grappa`** isn't covered. Changes here don't require a deploy
  (it's a host-side dispatcher), but `bin/start.sh` IS covered while
  `bin/grappa` and the `_lib.sh` plumbing aren't. Anchor list is
  arbitrary.
- **`.dockerignore`** isn't covered — a `.dockerignore` edit changes
  the build context which changes the next image; hot-deploy bypasses
  the image entirely, the change is dormant until the next cold deploy.
  Surprise.
- **`infra/snippets/`** — the regex is `'^infra/(nginx\.conf|snippets/)'`
  which only matches files directly under `snippets/`, not deeper
  paths. Today there's only one file, so fine — but a future
  `snippets/admin/cors.conf` would silently HOT.
- **`config/*.exs`** — runtime.exs / config.exs changes are NOT
  caught. SECRET_SIGNING_SALT is read at COMPILE time in config.exs
  (see `config/config.exs:102`) — a salt rotation that goes through
  config.exs without a Dockerfile/mix.exs touch will silently HOT,
  but the new value never makes it into the running BEAM. Confusing
  to debug.

**Fix:** Two concrete simplifications:

1. **Anchor INSIDE the matched alternation, not just at the start
   of the path:** `'^(mix\.lock|mix\.exs|Dockerfile|compose\..*\.yaml|\.dockerignore|bin/.*\.sh|config/.*\.exs|infra/)'`
   covers everything in a single regex. Move the Class enumeration
   from regex-per-class to one regex per *commit message* line so the
   operator still sees "what triggered cold" without losing coverage.
2. **For `config/*.exs`** specifically, classify as COLD whenever a
   compile-time-read env var or `config :grappa, …` block changes —
   that's almost always a recompile (config touched at compile time
   forces all of `lib/grappa` to recompile per Mix's stale-tracking).
   The simple version: any `config/*.exs` change → COLD. False-positive
   cost is small; false-negative cost is `SECRET_SIGNING_SALT` rotation
   that doesn't take effect.

---

### S4. `SECRET_SIGNING_SALT` is read at compile time in `config/config.exs:102` — Cold-deploy is the only way to apply, but it isn't enforced
**File:** `config/config.exs:102`, `.env.example:38`, `scripts/deploy.sh`
**Category:** preflight-gap / config-substrate
**Severity:** HIGH

```
# config/config.exs:102
session_signing_salt: System.get_env("SECRET_SIGNING_SALT") || "build-time-placeholder-not-prod-safe"
```

This is `System.get_env/1` at COMPILE time inside `config.exs`. The
result is baked into the compiled `_build/<env>/lib/grappa/ebin/...`
beams. Changing `SECRET_SIGNING_SALT` in `.env` and redeploying
**hot** does not change the salt the live BEAM signs sessions with —
the value is frozen in code. Even a cold deploy that hits the bind-
mount cache won't recompile unless the source files' mtime forces it.

`.env.example:36-38` documents this as a prod-required value but
makes no statement about its compile-time nature. The deploy
preflight doesn't catch `config/config.exs` changes at all (see S3).

A salt rotation that goes through `.env` → `--force-cold` →
`docker compose build` will work because the image rebuild forces a
fresh `mix compile`. But a salt rotation that does `.env` edit +
auto-deploy is silently broken.

**Fix:**
1. Move `SECRET_SIGNING_SALT` to `config/runtime.exs` alongside
   `SECRET_KEY_BASE`. There's no obvious reason this one signing key
   is compile-time when the cousin key isn't. Eliminates the issue.
2. If keeping it compile-time for some structural reason, add an
   explicit comment in `config.exs` ("⚠️  Compile-time — requires
   image rebuild to take effect") and have `deploy.sh` preflight
   classify any `config/config.exs` change as COLD (see S3).

---

### S5. Healthcheck does not exercise the DB or any cross-component dependency
**File:** `compose.yaml:103,174`, `infra/nginx.conf` (no `/healthz` block — falls through to default)
**Category:** healthcheck-adequacy
**Severity:** HIGH

The grappa healthcheck:
```
curl -fsS http://localhost:4000/healthz
```

The route at `lib/grappa_web/router.ex:87` is `HealthController :show`.
Without reading the controller, the conventional shape is "return 200
if the BEAM is up." That's true for "the process is alive" but says
nothing about:

- Is the Repo connection pool warm?
- Is Bootstrap finished (or stuck in a credential-spawn crash loop)?
- Are the long-lived ETS tables (Backoff, NetworkCircuit, WSPresence)
  reachable?
- Is the migration version current?

When the long-lived state stack is wedged but Phoenix.Endpoint still
answers (a real failure mode after a botched hot-deploy — see CLAUDE.md
note on `Phoenix.CodeReloader` accepting reloads then crashing on
shape-mismatch later), `/healthz` returns 200 and Docker keeps the
container marked HEALTHY. The deploy script's healthcheck-poll loop
will think the deploy succeeded.

The nginx healthcheck:
```
wget -qO- http://127.0.0.1/healthz
```
is even weaker — `nginx.conf` has no explicit `/healthz` location, so
it falls through to `location /` → `try_files $uri /index.html`.
nginx returns the SPA's index.html with a 200 status. The healthcheck
passes regardless of whether the upstream grappa container is alive.

**Fix:**
- Make `/healthz` actually exercise the substrate. Suggested shape:
  - `Repo.query("SELECT 1")` (cheap; catches the wedged-pool case)
  - `Process.alive?(GenServer.whereis(Grappa.Bootstrap))` style
    process probe — or, more architecturally, expose a
    `Grappa.Health.ready?/0` function that the supervision tree's
    boot completion sets to true.
- In `nginx.conf`, route `/healthz` explicitly via `proxy_pass` to
  the bouncer rather than falling through to SPA. Either add it to
  the existing REST allowlist on L107 (already does!) — wait, it
  IS in the allowlist (`(auth|me|networks|push|api|uploads|healthz)`).
  Confirmed: the nginx-healthcheck-falls-through-to-SPA risk above
  is wrong about the regex — `/healthz` does get proxied. Withdraw
  that half. The grappa-side healthcheck depth is still the lesson.

---

### S6. `deploy.sh` comment promises `HEAD@{1}..HEAD` diff but code uses captured-prev-HEAD — comment is now stale
**File:** `scripts/deploy.sh:30,68,213`
**Category:** doc-drift / comment-correctness
**Severity:** MEDIUM

```
# Phoenix.CodeReloader cannot detect any of these — only compile
# errors. So the preflight has to be in this script: diff
# `HEAD@{1}..HEAD` for the unsafe markers […]
```

Then:
```
prev_sha="$(git rev-parse HEAD)"
echo "Pulling latest main..."
git pull --ff-only
[…]
if preflight "$prev_sha" "HEAD"; then
```

`HEAD@{1}` is the reflog's previous-HEAD pointer, which would be
correct *after* a `git pull` (it's where HEAD was before the pull).
But the code uses `git rev-parse HEAD` captured BEFORE the pull, which
is equivalent in normal flow but materially different when, e.g., the
reflog is empty (fresh clone), or someone does manual `git reset`
between deploys. The captured-prev-HEAD form is the correct one;
update the comment to match.

The bigger problem is the comment lies about what happens. If an
operator reads the comment and replaces `prev_sha` with `HEAD@{1}` to
"clean up," the script breaks on fresh clones.

**Fix:** Replace the `HEAD@{1}..HEAD` reference in the comment with
the actual mechanic (capture HEAD pre-pull, diff post-pull). Two
words to change.

---

### S7. `bin/grappa` uses `docker compose exec`, `deploy.sh` + `deploy-cic.sh` use bare `docker exec grappa` — escape hatch from `_lib.sh`
**File:** `scripts/deploy.sh:235`, `scripts/deploy-cic.sh:48`
**Category:** duplication / pattern-divergence
**Severity:** MEDIUM

The whole rest of the substrate uses `docker compose
"${COMPOSE_ARGS[@]}" exec grappa …` (via `_lib.sh`'s
`in_container()` or `in_container_or_oneshot()`), which:

- respects per-host `compose.override.yaml`
- correctly resolves the project name when run from a worktree
- adheres to the "never raw docker compose / never raw docker"
  CLAUDE.md rule

`deploy.sh:235` and `deploy-cic.sh:48` are exceptions:
```
docker exec grappa curl -fsS -X POST http://localhost:4000/admin/reload
docker exec grappa curl -fsS -X POST http://localhost:4000/admin/cic-bundle-changed
```

These assume:
1. The container's name is exactly `grappa` (matches the
   `container_name: grappa` in `compose.yaml:34`). True today, brittle
   when the e2e harness or any future personal override touches
   `container_name`.
2. The host's `docker` binary resolves to the same docker context as
   `docker compose`. Almost always true but not guaranteed (rootless
   docker, remote contexts).
3. There's no multi-host deploy concern (today there isn't, but the
   moment there is, `docker exec` runs locally while `docker compose`
   could route to a remote daemon).

**Fix:** Replace with `in_container curl …` (or inline equivalent).
Two two-line changes. The bare `docker exec` form was probably the
fastest thing to write; the cost is real divergence from "scripts use
`_lib.sh`."

---

### S8. `_lib.sh` `WORKTREE_VOLUMES` list duplicates the conceptual contract that worktree source = read-write everything
**File:** `scripts/_lib.sh:94-105`
**Category:** simplification / boundary-coupling
**Severity:** MEDIUM

The hardcoded list of `-v $SRC_ROOT/<path>:/app/<path>` mounts:
```
-v "$SRC_ROOT/lib:/app/lib"
-v "$SRC_ROOT/test:/app/test"
-v "$SRC_ROOT/config:/app/config"
-v "$SRC_ROOT/priv/repo:/app/priv/repo"
-v "$SRC_ROOT/infra:/app/infra:ro"
-v "$SRC_ROOT/mix.exs:/app/mix.exs:ro"
-v "$SRC_ROOT/mix.lock:/app/mix.lock:$lock_mode"
-v "$SRC_ROOT/.formatter.exs:/app/.formatter.exs:ro"
-v "$SRC_ROOT/.credo.exs:/app/.credo.exs:ro"
-v "$SRC_ROOT/.sobelow-conf:/app/.sobelow-conf:ro"
```

This list will drift the moment someone adds a new top-level config
file. Concrete examples that would silently fail to mount today:
- A new `.doctor.exs` (per CI gate doctor)
- A `priv/<other-subdir>/` (e.g. push assets, plt seed files)
- A `cicchetto/` source bind in case mix tests ever touch cicchetto's
  bundle hash (B2 LANDED 2026-05-21, e2e seam at
  `cic-bundle-changed`)

The contract being enforced is "worktree wins for source files; main
wins for caches." That contract could be expressed as a single
exclude-list pattern instead of an include-list of paths.

**Fix:** Mount `$SRC_ROOT` over `/app` directly (it's already a bind
mount in `compose.yaml`), and use `tmpfs` or named-volume `:nocopy`
overlays for the cache-only paths (`_build`, `deps`, `priv/plts`,
`runtime`, `.mix`, `.hex`, `.cache`, `.local`). The current
`compose.yaml` already has `./:/app` so this is a no-op from main; the
worktree case just needs `-v "$SRC_ROOT:/app"` (one line replacing
ten) plus the cache-overlay set, which is already required for the
main-vs-worktree shared-cache property.

Same simplification applies to the e2e seeder + grappa-test compose
files in `cicchetto/e2e/compose.yaml` which use the simpler shape
already (`../..:/app`) without the per-file enumeration. That's the
proof the simpler shape is sufficient.

---

### S9. `cicchetto/e2e/nginx-test.conf` :80 + :443 blocks are 80% byte-for-byte duplicate
**File:** `cicchetto/e2e/nginx-test.conf:44-105,107-172`
**Category:** duplication
**Severity:** MEDIUM

The `:80` and `:443` server blocks differ only in:
- `listen 80` vs `listen 443 ssl; http2 on; ssl_certificate …`
- Everything else is identical (`client_max_body_size`, `root`,
  `index`, `include`, `location /socket`, `location ~ ^/(auth|me|…)`,
  `location ~ ^/admin/(…)`, `location = /sw.js`, `location /`)

The file even acknowledges this:
> Why duplicate the prod nginx.conf instead of including it: nginx
> `include` of a file containing a `server { }` block at the http{}
> level is permitted, but the location rules inside need to live
> inside both server blocks — and snippet-mounting a file inside a
> read-only directory mount fails at runtime (overlay can't create a
> nested mount-point). Inlining the locations once per server block
> is the cheapest readable path.

The "include of a file inside a server block" objection is incorrect
— that's a normal nginx pattern. The objection is "snippet-mounting
a file inside a read-only directory mount fails at runtime" which
appears to be about the existing `infra/snippets` mount being
read-only and not having room for additional files. That's a
compose-mount-shape problem, not an nginx-include problem.

**Fix:** Two options:
- **Cheap:** add a second include directory (`./locations:/etc/nginx/locations`)
  and `include /etc/nginx/locations/api.conf` from both `server { }`
  blocks. Each location appears once across the whole nginx-test +
  prod surface.
- **Cheaper:** put `infra/snippets/locations-api.conf` and include
  it from both server blocks. The snippets directory is already
  mounted; adding a file to it is free.

Mechanically related to S2 — the admin-allowlist regex is the most
acute symptom, but the broader duplication is the underlying disease.

---

### S10. `bin/grappa help` table drifts independently from `dispatch_help()` and `dispatch()` switch arms
**File:** `bin/grappa:275-313, 317-345, 347-376`
**Category:** duplication / drift-risk
**Severity:** MEDIUM

The verbs are enumerated **four** times in `bin/grappa`:

1. `verb_<name>()` function definitions (L65-104)
2. `verb_help_<name>()` function definitions (L166-271)
3. `dispatch_help()` switch (L317-345)
4. `dispatch()` switch (L347-376)
5. `help_top()` heredoc table (L275-313)

Adding a new verb requires touching all five. The bats suite catches
some of this (it asserts each verb's existence), but the
discoverability table (`help_top()`) can silently desync without any
test catching it.

The kebab-case ↔ snake_case mapping is also hardcoded per-verb
(`mix_task grappa.create_user`), even though the rule is purely
mechanical (kebab → snake by `tr '-' '_'`).

**Fix:** Move the verb table to a single associative array (bash 4+
which is already required, per CLAUDE.md):

```bash
declare -Ag VERBS=(
  [create-user]="boot|grappa.create_user|create a Grappa user account"
  [bind-network]="boot|grappa.bind_network|bind a (user, network) credential"
  …
  [delete-visitor]="rpc|Grappa.Operator.delete_visitor!|terminate + delete a visitor (sync)"
)
```

`dispatch()`, `dispatch_help()`, and `help_top()` become one-liners
that read from the array. Per-verb help heredocs still live in
`verb_help_<name>()` but the dispatch table no longer drifts. About
~30 LOC deleted net.

---

### S11. `compose.yaml` and `compose.override.yaml.example` disagree on which compose-merge keyword to use
**File:** `compose.yaml:39-40`, `compose.override.yaml.example:23,30`, `compose.oneshot.yaml:24,25`
**Category:** consistency / cognitive-load
**Severity:** MEDIUM

Three different "drop the parent's value" semantics in three adjacent
files:

- `compose.yaml`: no override — just declares `ports: ["${GRAPPA_PUBLISH:-127.0.0.1:4000}:4000"]`
- `compose.override.yaml.example:23,30`: `ports: !override` (no list, list comes next line) — meaning "REPLACE"
- `compose.oneshot.yaml:24,25`: `container_name: !reset null` and `ports: !reset []` — meaning "DROP"

The override file's L17-18 comment even teaches: "Without !override,
compose merges port lists by appending […]. `!reset` would drop ports
entirely without re-adding ours." But then `compose.oneshot.yaml`
uses `!reset` — which is correct for its goal (drop, don't re-add),
but the operator who learns from the override-example may try
`!override` in the oneshot context and break things, or vice versa.

**Fix:** Standardize on one of:
- Always use `!override` and explicitly list the replacement value
  (even an empty list `[]`) — semantically equivalent to `!reset []`
  but consistent with the personal-override pattern.
- Or document the rule explicitly in `_lib.sh` near the
  `COMPOSE_ARGS` declaration: "`!override` for replace, `!reset` for
  drop, never mix."

The example file already does the documentation work; the issue is
that `compose.oneshot.yaml` is using a third pattern. Pick one.

---

### S12. `start_period: 180s` is a workaround for first-deploy slow path that should not exist
**File:** `compose.yaml:111`, `scripts/deploy.sh:300-306`
**Category:** simplification / band-aid
**Severity:** MEDIUM

`compose.yaml:106-111`:
```
# Probe early + often. `mix phx.server` cold boot recompiles when
# bind-mounted source has no `_build/${MIX_ENV}/` cached on host
# disk yet — first-deploy boot can take 2-3 min. start_period
# suppresses failure-counts-toward-unhealthy during that window;
# actual healthy-flip happens on the first /healthz 200 regardless.
start_period: 180s
```

`scripts/deploy.sh:298-306`:
```
# Cold-boot loop is long because `mix phx.server` recompiles when
# bind-mounted source has no `_build/${MIX_ENV}/` cached on host
# disk yet — first deploy can take 2-3 minutes, subsequent deploys
# finish in 10-15s.
for i in $(seq 1 120); do …
```

The 2-3 min first-deploy boot is documented as inevitable, but the
Dockerfile already does `RUN mix compile` (L54). The container image
ships with `_build/dev/lib/…` baked in. The "first deploy is slow"
problem only fires because the bind-mount `./:/app` (L57) **shadows**
the image-baked `_build`. The cached compile is thrown away on every
cold boot.

CLAUDE.md memory `feedback_bind_mount_shadows_image` codifies this
lesson but the fix it documents is "accept first-boot recompile"
rather than "stop shadowing." The cleanly architectural fix is to
NOT mount `_build` from the host — only mount the source dirs (per
S8's exclude-list pattern) and let the image-baked `_build` survive,
with the recompile only firing on actual source changes (which Mix's
stale-tracking handles).

Today this slow path is mostly hidden because the named-volume era
predates the current bind-mount era and the cache is persisted on the
host's `runtime/.../`-ish locations. But the 180s start_period and
the 240s deploy wait loop are both compensating for a fragility the
substrate creates.

**Fix:** Add `_build`, `deps`, `.mix`, `.hex`, `.cache`, `.local` as
anonymous volumes in `compose.yaml`'s grappa service so they're
overlaid on the bind-mount and the image-baked compiled artifacts are
preserved. Then `start_period` can drop to 30s and the deploy poll
can drop to 60s. Mechanically the same fix as S8.

---

### S13. `start.sh`'s `+SDio = +SDcpu = nproc` defaults silently override BEAM's `+SDio 10` floor
**File:** `bin/start.sh:17-22, 52`
**Category:** correctness / silent-config
**Severity:** MEDIUM

```
#   - GRAPPA_DIRTY_SCHEDULERS (default: $(nproc))
#       Sets BOTH `+SDcpu` (dirty CPU schedulers) and `+SDio` (dirty
#       IO schedulers). BEAM's `+SDio` default is a fixed 10 regardless
#       of CPU count, which is wasteful on a 4-core host (10 idle
#       threads with their own allocator carriers). Defaulting to nproc
#       gives 1 dirty scheduler per CPU for each pool.
```

On a single-core deployment (which a Pi 5 isn't, but a future
container limit could be), `nproc=1` → `+SDcpu 1 +SDio 1`. The Repo
checkout pool (sqlite) shares dirty IO schedulers with file watchers
and any other dirty-IO BEAM workload. With one slot, the pool
serializes. The comment claims "1 per CPU for each pool gives
comfortable headroom" but for a workload that's IO-bound on dirty
schedulers (which sqlite + WAL absolutely is) this can starve.

The bigger issue: there's no floor. The BEAM's own default of 10 is a
reasonable lower bound; capping at nproc when nproc < 10 throws away
the BEAM team's tuning advice. Worse, the env var override means an
operator who EXPECTS the 10-IO-scheduler default doesn't get it.

**Fix:** `: "${GRAPPA_DIRTY_SCHEDULERS:=$(nproc)}"` → floor it at 10:
```
default=$(nproc)
if [ "$default" -lt 10 ]; then default=10; fi
: "${GRAPPA_DIRTY_SCHEDULERS:=$default}"
```
Or split the two knobs so `+SDcpu` and `+SDio` can be tuned
separately (the comment's premise that they should always be equal is
not load-bearing). The cleanest: drop the env-var fiddling entirely
and trust the BEAM defaults; the per-scheduler allocator carrier
overhead documented in the moduledoc is on the order of 30-50 MB,
which is a rounding error on any modern deployment (Pi 5 included).

---

### S14. `compose.yaml` `cicchetto-build` and `cicchetto/e2e/compose.yaml` `cicchetto-build-test` are 90% duplicate
**File:** `compose.yaml:135-149`, `cicchetto/e2e/compose.yaml:241-269`
**Category:** duplication
**Severity:** LOW

The two services differ in:
- Container name (none vs not declared)
- Bind-mount path (`./cicchetto` vs `../../cicchetto`)
- Cache path (`./runtime/bun-cache` vs `../../runtime/bun-cache`)
- Dist output (`./runtime/cicchetto-dist` vs `../../runtime/e2e/cicchetto-dist`)
- Profile (`prod` vs none)

Everything else is identical: image, user, working_dir, tmpfs, env
vars, command. The compose `extends:` directive exists for this; or
the e2e compose can `include:` the base service definition and
override only the mount paths.

**Fix:** Use `extends:` or move the common shape to a YAML anchor
(YAML allows `&base` / `<<: *base`). Saves ~20 lines of duplicate
config that has to stay in lockstep.

---

### S15. `register-dns.sh` is a single-deployment helper masquerading as a project script
**File:** `scripts/register-dns.sh`
**Category:** scope / project-fit
**Severity:** LOW

The script's moduledoc states:
> Personal/operator helper — not invoked by the standard dev or deploy
> flow. Pre-supposes a Technitium DNS server with API access […]

The script is well-written and lints clean, but it's hardcoded to a
specific DNS implementation (Technitium) and depends on a specific
deployment shape (env file at `/srv/dns/.env`). It's in `scripts/`
alongside the universal devloop scripts — anyone cloning the repo
sees it and wonders if it's relevant.

**Fix:** Move to `scripts/operator/` (a sibling subdirectory for
deployment-specific operator helpers), or to a separate
private repo / dotfiles entirely. If keeping it here, prefix the file
with a banner that's discoverable from `ls`: rename to
`scripts/operator-register-dns.sh` or similar. Bonus: the Bastille
deploy workstream (per MEMORY) will likely have its own DNS
registration mechanic — a new home for this content can defer until
then.

---

### S16. `observer.sh` quietly assumes `:observer_cli` dep is present in the live container's env
**File:** `scripts/observer.sh:15`
**Category:** error-surface / honesty
**Severity:** LOW

```
in_container iex -S mix run -e ':observer_cli.start()'
```

If `:observer_cli` is `only: :dev` in `mix.exs` and the live container
is `MIX_ENV=prod`, this crashes with
`UndefinedFunctionError`. No fast-fail check, no helpful message.

**Fix:** Either:
- Add a one-liner check: `mix run -e 'Application.spec(:observer_cli) || (IO.puts(:stderr, "observer_cli not loaded — likely MIX_ENV=prod build"); System.halt(1))'`
- Move `:observer_cli` to `mix.exs` deps unconditionally (it's
  ~150KB, the production-size cost is trivial). The CLAUDE.md
  principle "use infrastructure, don't bypass it" applies — the
  introspection tool should always be available on the running
  container.

The latter is the simplification. The former is the band-aid.

---

### S17. `prev_sha` and `git pull --ff-only` can race a concurrent operator push
**File:** `scripts/deploy.sh:68-70`
**Category:** correctness / concurrent-deploy
**Severity:** LOW

```
prev_sha="$(git rev-parse HEAD)"
echo "Pulling latest main..."
git pull --ff-only
```

If two operators run `scripts/deploy.sh` simultaneously, the second
one's `prev_sha` captures the first's pulled HEAD, and the second
`git pull --ff-only` does nothing → preflight says "no commits since
last HEAD" → second deploy goes hot regardless of what the first
introduced. Today there's only one operator, so this is theoretical
— but Bastille deploy workstream is in MEMORY and may introduce
multi-host concerns.

**Fix:** Use a file lock (`flock`) around the entire deploy.sh body:
```
exec 9>/var/lock/grappa-deploy
flock 9 || die "another deploy in progress"
```
Three lines, zero downside.

---

### S18. `deploy.sh` `git pull --ff-only` doesn't fetch origin first; relies on previous fetch
**File:** `scripts/deploy.sh:70`
**Category:** correctness
**Severity:** LOW

`git pull --ff-only` does fetch + ff-merge, but only from the
configured remote-tracking branch's upstream. If the local `main`
branch is configured to track a remote that's not where the latest
push went (rare), or if a forced fetch is needed (also rare), the
deploy silently uses stale data.

Per CLAUDE.md memory `feedback_deploy_preflight_empty_diff_after_merge`
(V9 incident): `git merge --ff-only` followed by `scripts/deploy.sh`
caused empty-diff preflight false-HOT. The pattern is the same — a
no-op pull means the preflight diffs against itself.

**Fix:** Explicitly `git fetch origin main` then `git merge --ff-only
origin/main` — or simpler, just `git fetch && git pull --ff-only`.
Adds zero meaningful latency and makes the data source explicit.

---

### S19. Two healthcheck shells in `compose.yaml` (curl, wget) for no semantic reason
**File:** `compose.yaml:103, 174`, `scripts/healthcheck.sh:18-21`
**Category:** duplication / cognitive-load
**Severity:** LOW

The grappa container's healthcheck uses `curl`:
```
test: ["CMD-SHELL", "curl -fsS http://localhost:4000/healthz || exit 1"]
```

The nginx container's healthcheck uses `wget`:
```
test: ["CMD-SHELL", "wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1"]
```

`scripts/healthcheck.sh` mirrors this — `curl` against grappa
upstream, `wget` against nginx. The comment on nginx mentions "alpine
resolves localhost to ::1 first" — fine, that's the `127.0.0.1`
choice. But why `wget` for nginx and `curl` for grappa? Both
containers are alpine; both have curl available.

The cost: the operator reading `healthcheck.sh` has two slightly
different invocation forms to keep in their head, neither of which is
preferred. The probe shape, the failure-exit logic, the URL format —
all subtly different.

**Fix:** Pick one (`curl -fsS` is more standard) and use it in both
healthchecks + both healthcheck.sh branches. Five characters of diff,
saves a "why is this different" question per future read.

---

## Cross-cutting summary

The substrate is in good shape — CP23's collapse to single-stage +
unified compose was the right call, and Dockerfile / oneshot /
worktree-awareness are tighter than most projects ever achieve. The
remaining complexity is **duplication** (admin allowlist in 3 places,
worktree volumes in N entries, nginx :80/:443 byte-copies, bun-build
service twice) and a handful of preflight gaps in `deploy.sh` where
the regex enumeration is fragile.

The single biggest simplification leverage point is **collapsing
nginx config duplication via `include` snippets** — S2 + S9 are the
same disease, and the existing `security-headers.conf` snippet is the
proof-of-pattern. Fix once, kill three drift surfaces.

The single most dangerous bug is **S1** (preflight regex parses any
`Grappa.*` line, not just `@modules` / `@state_helpers` members) —
benign today, primed to mask the next CP28-class incident. The Elixir
fingerprint fix kills the regex and the awk helper in one stroke.
