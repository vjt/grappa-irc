# Code Reload — KISS Phoenix-mainstream deploy

> Design pin only. Implementation deferred — vjt has another debug
> session first.

**Goal**: deploy server-side code changes WITHOUT killing IRC sessions.
Cic refresh handled separately (cic deploys are independent of grappa
deploys).

**Decision summary**:
- One env, one path: `mix phx.server` everywhere (dev = prod = CI).
- Drop `mix release`. Keep image, single-stage.
- Code reload via Phoenix.CodeReloader request-driven default + manual
  `POST /admin/reload` for non-request-path modules.
- Two scripts: `scripts/hot-deploy.sh` (no restart, sessions live) and
  `scripts/cold-deploy.sh` (compose recreate, nuclear).
- Cic decoupled: server reads its bundle hash from
  `priv/static/index.html`; cic boot stores its own hash; broadcast on
  bundle change → cic mismatch → refresh banner.
- Image-shipping path for ghcr users: image carries source, hot-deploy
  extracts source into a named volume.

---

## Why KISS / Phoenix-mainstream over OTP-tradition release+RPC

vjt: "preferiscod ev e prod identici e mainstream phoenix se è più
semplice. KISS."

`mix phx.server` is the Phoenix community default for single-node
deployments. `Phoenix.CodeReloader` is wired in by default in dev;
flipping it on in prod is one config line. Trade-offs accepted:
- Boot ~10-15s vs ~2s release boot (single-node, deploy rare).
- Image +150-200MB (mix + hex + rebar + source + deps).
- Loses release immutable-boot semantics.

OTP-tradition path (release + `:code.purge/1` + `:code.load_file/1` +
custom `Grappa.Reloader`) was considered and rejected. More plumbing,
no concrete benefit at Grappa's scale.

`:appup` + `:release_handler` (textbook Erlang hot upgrade) was
considered and rejected. Brittle, no one uses it, disasters frequent.

---

## Mechanism

### Server hot reload

1. `mix phx.server` boot config: `code_reloader: true` in
   `config/runtime.exs` for prod (currently dev-only via
   `config/dev.exs`).
2. New admin endpoint: `POST /admin/reload`. Calls
   `Phoenix.CodeReloader.reload!(GrappaWeb.Endpoint)` once. Walks
   `:code.modified_modules/0` (Erlang built-in: returns modules whose
   source on disk is newer than loaded), purges + loads via
   `Mix.compile.elixir` dependency tracking. Returns `{ok, modules}`
   list.
3. Live processes (Session.Server, IRC.Client, EventRouter) keep their
   GenServer state. Next callback uses new code (Erlang's 2-version
   guarantee).

### Module-shape changes that REQUIRE cold deploy

- `mix.lock` change (new dep versions).
- OTP / Elixir version change.
- `mix.exs` config change (e.g. new application started).
- Supervision tree change (new children, restart strategy change).
- Struct shape change in long-lived GenServer state (would crash on
  pattern match against old struct).

Hot-deploy script must refuse these. See "image label" below.

### Cic refresh

Independent of grappa deploys. Server doesn't trigger refresh on every
hot-deploy — only when cic itself ships a new bundle.

1. Cic boot: read bundle hash from
   `<script src="/assets/index-XXX.js">` in `index.html`. Store as
   `bootBundleHash`.
2. User-topic join: server pushes
   `{kind: "bundle_hash", hash: <current>}` (server reads
   `priv/static/index.html` at startup).
3. Cic deploy script (`scripts/deploy-cic.sh`, separate from
   server hot/cold deploys) ships the new Vite bundle to
   `priv/static/`, then POST `/admin/cic-bundle-changed` → server
   broadcasts `{kind: "bundle_hash", hash: <new>}` on
   `grappa:system` topic → fan-out to all user-topics → cic compares
   to `bootBundleHash` → mismatch = banner "new version live, click to
   refresh" → click = `window.location.reload()`.

---

## Scripts

### `scripts/hot-deploy.sh [IMAGE]`

Two modes:

**No arg (git path, vjt-style host)**:
```
git pull
docker exec grappa /usr/local/bin/curl -X POST http://localhost:4000/admin/reload
```

**With image arg (ghcr path)**:
```
docker pull ghcr.io/vjt/grappa:VSN
LABEL=$(docker inspect --format='{{ index .Config.Labels "grappa.hot_deployable"}}' \
  ghcr.io/vjt/grappa:VSN)
[ "$LABEL" = "true" ] || { echo "Cold deploy required"; exit 1; }
docker run --rm -v grappa_source:/target ghcr.io/vjt/grappa:VSN \
  cp -a /app/. /target/
docker exec grappa /usr/local/bin/curl -X POST http://localhost:4000/admin/reload
```

Image extraction overwrites `lib/`, `priv/`, etc. in the named volume
that the running container has bind-mounted at `/app`.

### `scripts/cold-deploy.sh [IMAGE]`

Nuclear. Compose down + up. Sessions die. For mix.lock / OTP / struct
changes:

```
[ -n "$1" ] && docker pull "$1"
docker compose down
docker compose up -d
```

### `scripts/deploy-cic.sh`

Separate path for cic releases. Builds Vite bundle on host (or in CI),
ships to `priv/static/`, POSTs the cic-bundle-changed admin endpoint
to trigger the broadcast.

### Compatibility with current `scripts/deploy.sh`

Current `scripts/deploy.sh` = build prod image + restart. Becomes
deprecated alias for `cold-deploy.sh` during transition; remove after
one cluster.

---

## Image label: `grappa.hot_deployable`

CI build pipeline computes the label at image build time:

- `git diff $PREV_TAG..$CURRENT_TAG -- mix.lock mix.exs lib/grappa/application.ex`
  → if any non-empty, label = `false`.
- Struct change detection: TBD heuristic, possibly `git grep
  "defstruct" lib/grappa/session/server.ex` diff.
- Default: `true`.

`scripts/hot-deploy.sh IMAGE` reads label, refuses with cold-deploy
suggestion if `false`.

---

## Dockerfile rewrite

Single-stage, no release:

```dockerfile
FROM elixir:1.19-otp-28-alpine
WORKDIR /app
RUN apk add --no-cache build-base git curl sqlite-dev
COPY mix.exs mix.lock ./
RUN mix local.hex --force && mix local.rebar --force
RUN mix deps.get --only prod
COPY config config
RUN mix deps.compile
COPY . .
RUN mix compile
ENV MIX_ENV=prod
LABEL grappa.hot_deployable=true
CMD ["mix", "phx.server"]
```

Notes:
- `mix release` build stage gone.
- `bin/grappa` entrypoint gone.
- `runtime/grappa_prod.db` bind-mount unchanged.
- `CLOAK_KEY`, `SECRET_KEY_BASE`, `PHX_HOST`, `EXTRA_CHECK_ORIGINS`
  env vars unchanged.

---

## Cluster shape (when implemented)

Worktree `cluster/code-reload`:

- **B1** Dockerfile rewrite + remove `mix release` config; verify
  `scripts/up.sh` still boots prod-like locally.
- **B2** `config/runtime.exs` enable `code_reloader: true` in prod.
  Add `Phoenix.CodeReloader` to endpoint pipeline if not auto-enabled.
- **B3** `GrappaWeb.AdminController.reload/2` POST endpoint at
  `/admin/reload`. Auth via existing /admin gate.
- **B4** `Grappa.Version` module with compile-time bundle hash read
  from `priv/static/index.html`. User-topic join push
  `{kind: "bundle_hash", ...}`.
- **B5** `GrappaWeb.AdminController.cic_bundle_changed/2` →
  broadcast on `grappa:system` topic. Cic mirror in
  `lib/socket.ts` / `lib/userTopic.ts` → store-level
  `bundleHashFromServer` → mismatch detector → banner component.
- **B6** `scripts/hot-deploy.sh` (git mode + image-extraction mode).
  Image label gate.
- **B7** `scripts/cold-deploy.sh` (compose recreate). Deprecate
  `scripts/deploy.sh`.
- **B8** `scripts/deploy-cic.sh` (Vite build + push bundle-changed
  notification).
- **B9** CI image label computation: `mix.lock` / `mix.exs` /
  application.ex diff → `grappa.hot_deployable` label.
- **B10** e2e: edit a controller → hot-deploy → vitest e2e asserts
  new response WITHOUT WS reconnect (sessionId stable across deploy).
- **B11** docs: CLAUDE.md "How to run scripts" section; new dev
  workflow paragraph; safe vs unsafe change matrix.

Cluster Z (close): full `scripts/check.sh` exit-0 + literal tail per
memory `feedback_landed_claim_evidence`, deploy via the new
hot-deploy.sh against itself (meta), README update.

---

## Risk register

- **Boot-time regression**: prod boot 10-15s instead of 2s. Affects
  cold-deploy downtime + healthcheck timing in compose.yaml. Bump
  `start_period` in healthcheck.
- **Compile errors at deploy time**: `mix phx.server` boot will fail
  if syntax error in committed code. Hot-deploy script should run
  `mix compile --warnings-as-errors` BEFORE issuing reload, refuse if
  compile fails (current code stays loaded). Same gate for
  cold-deploy: don't recreate container if compile fails.
- **Phoenix.CodeReloader in prod**: enabling reloader in prod is
  unusual but supported. Audit: any CSRF / auth implications? The
  reloader does file IO on every reload call, not on every request,
  so attack surface is just the admin endpoint itself.
- **Image label false positives/negatives**: heuristic-based; false
  positive (label=true but actually unsafe) crashes processes at
  reload time. False negative (label=false but actually safe) forces
  unnecessary cold deploy. Conservative bias = err on false.
- **Multi-node future**: this design is single-node. If Phase 5+ adds
  HA (multiple grappa nodes behind a load balancer) the hot-deploy
  story needs rethinking — broadcast reload across nodes, OR rolling
  cold-deploy with session migration. Out of scope, flag for later.

---

## Open questions (to resolve when this cluster opens)

1. Admin auth on `/admin/reload`: same gate as Phoenix.LiveDashboard
   `/admin`? Currently dev-only, Phase 5 will add prod auth.
   Hot-deploy needs prod-callable. Decide auth shape (basic auth env,
   localhost-only via plug, signed-token).
2. `compose.yaml` change: `/app` becomes a named volume bind-mounted
   from host source dir (current `compose.override.yaml` pattern) OR
   a docker named volume populated by image extraction. Two flows.
3. CI label heuristic: how strict on struct-change detection? Static
   parsing or just "any change to `lib/grappa/session/server.ex`
   defstruct line"?
4. `scripts/hot-deploy.sh` curl invocation: container needs `curl` or
   admin endpoint reachable from host. If host can hit
   `localhost:4000` via the published port, host curl works
   (no `docker exec` needed).
5. `Grappa.Version` bundle-hash module: read at compile time
   (`@external_resource priv/static/index.html`) or at boot
   (`Application.start/2`)? Compile-time = bundle hash baked into
   beam at server build, requires server rebuild on cic deploy
   (defeats independence). **Boot-time read is correct.**
