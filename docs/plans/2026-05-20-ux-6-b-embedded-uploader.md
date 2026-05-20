# UX-6 bucket B — embedded image uploader

**Status**: brainstorm v1 (2026-05-20, pre-vjt-sign-off). NO code
written yet. Sign-off → start B1.

| Sub-bucket | Status | Deploy | Notes |
|------------|--------|--------|-------|
| B1 — server stack (schema + Uploads + ServerSettings + REST + Reaper + nginx) | brainstorm | **COLD** (migration + supervision tree + nginx) | Lands alone |
| B2 — cic adapter + admin settings UI + dynamic activeHost | brainstorm | cic-bundle + reload? | catbox stays selectable |
| B3 — close (e2e + reviewer-loop + deploy + memory) | brainstorm | n/a | Per-cluster cadence |

**Branch / worktree**: `/tmp/grappa-ux6b` on `ux-6-b-embedded-uploader`
(branched from local main `eeb551d`).
**Position**: UX-6 cluster bucket B, post-A-v6 (`eeb551d`).
**Origin**: vjt 2026-05-20 — postimages.org/imgbb both have showstoppers
(postimages: bot-blocks anon browser uploads; imgbb: needs per-deploy
shared API key in server-side admin store). Pivoted to "self-host the
file storage; trade IP-exposure for reliability."

## Goal

**Same upload UX as the I-cluster shipped, swap the host.** Operator
clicks 📷 in ComposeBox → file goes to grappa-served `runtime/uploads/`
→ PRIVMSG body is `📸 https://<phx_host>/uploads/<slug>` → recipients
click → grappa serves the bytes. Files self-delete after operator's TTL.

**Catbox stays an option** (admin-pickable from a dropdown) but the
embedded path is the new default.

**What we are NOT building.**
- NO inline thumbnails / lightbox / preview (carry from I-cluster:
  IRC stays text only).
- NO per-user uploads quota (operator-monitored via global cap).
- NO image transformation (resize / strip-EXIF / format-convert).
- NO authentication for VIEW (`GET /uploads/:slug`). Anyone with the
  URL gets the bytes. Matches the existing litterbox model exactly.
- NO chunked upload (single POST; 10MB default cap is well below any
  reasonable HTTP body limit).
- NO server-side virus scan / content moderation.
- NO server-side image-format validation beyond MIME-from-Content-Type
  (the cic-side pre-check is the only gate).

**Subject parity.** Visitors and registered users get the SAME upload
surface. Subject FK is XOR (`user_id` XOR `visitor_id`), mirrors
`Grappa.Scrollback.Message` / `Grappa.UserSettings` / `Grappa.ReadCursor`.

## Architecture decisions

### A1. Server-served files, slug URLs, FS-backed

- **Storage**: `runtime/uploads/<slug>` on disk. `runtime/` is the
  existing host-bind-mounted sqlite directory. New `runtime/uploads/`
  subdirectory created at supervisor boot (single mkdir_p, idempotent).
- **Slug**: 16-byte `crypto.strong_rand_bytes/1` base32-encoded (26
  chars, no padding), URL-safe. 128 bits of entropy = unguessable in
  practice. Slug is the on-disk filename AND the URL path component.
  (No directory bucketing — at expected scale (≤ 10GB cap, ≤ 10MB
  avg → ≤ 1000 files concurrent) sqlite + ext4/apfs handle a single
  flat dir without performance pathologies.)
- **No directory traversal**: slug is base32-validated at every read
  boundary; an arbitrary URL path can't escape into `..`.
- **MIME**: stored verbatim from `Content-Type` of the upload POST.
  Served on download via `put_resp_header("content-type", mime)`.
  Defensive `Content-Disposition: inline` so browsers render
  in-tab instead of forcing download.

### A2. New schema — `uploads` + `server_settings`

#### `uploads`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `binary_id` PK | UUID v4 |
| `slug` | `:string`, unique | base32 16-byte; URL path component AND on-disk filename |
| `user_id` | FK `users.id` ON DELETE CASCADE, nullable | XOR with `visitor_id` |
| `visitor_id` | FK `visitors.id` ON DELETE CASCADE, nullable | XOR with `user_id` |
| `mime` | `:string` | e.g. `image/png` |
| `bytes` | `:integer` | size of stored file (for global-cap sum) |
| `original_filename` | `:string`, nullable | best-effort, only used for download `Content-Disposition` if present |
| `expires_at` | `:utc_datetime_usec`, nullable | NULL = never expires (admin-pinned uploads, future) |
| `deleted_at` | `:utc_datetime_usec`, nullable | soft-delete after reaper unlinks the file; row stays for telemetry |
| `inserted_at` / `updated_at` | timestamps | |

**Indices**:
- `unique(slug)` — lookup key + URL parsing.
- `(expires_at) where deleted_at IS NULL and expires_at IS NOT NULL` —
  Reaper sweep query.
- Per CLAUDE.md "DB and live state separate sources": the file on
  disk IS the source of truth for "is this resolvable to bytes."
  The row is the source of truth for "did we ever know about this
  upload + when does it expire." Reaper synchronizes both; the
  GET-by-slug handler must check both (row exists + not soft-deleted
  + file exists on disk → serve; else 404 with no oracle).

**XOR CHECK constraint** — exactly one of `user_id` / `visitor_id`
non-null, mirrors `Grappa.QueryWindows` / `Grappa.UserSettings` /
`Grappa.ReadCursor` (CP25 visitor-parity).

#### `server_settings`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `binary_id` PK | UUID v4 |
| `key` | `:string`, unique | e.g. `"upload.active_host"`, `"upload.per_file_cap_bytes"`, `"upload.global_cap_bytes"` |
| `value` | `:text` | JSON-encoded value (atom-keyed Elixir maps round-trip via Jason) |
| `inserted_at` / `updated_at` | timestamps | |

**Why a single k/v table instead of typed columns**: matches
`Grappa.UserSettings.data` pattern — admin settings are small,
orthogonal, additive. Adding a new admin setting is "write an accessor
in `Grappa.ServerSettings`," NOT a migration. Per CLAUDE.md "implement
once, reuse everywhere" — same shape as UserSettings, exposed via
typed-accessor module.

**Typed accessors live in `Grappa.ServerSettings`**:
- `get_upload_active_host/0 :: :embedded | :litterbox` (default `:embedded`)
- `put_upload_active_host/1`
- `get_upload_per_file_cap_bytes/0 :: pos_integer()` (default 10 MiB)
- `put_upload_per_file_cap_bytes/1`
- `get_upload_global_cap_bytes/0 :: pos_integer()` (default 10 GiB)
- `put_upload_global_cap_bytes/1`

### A3. Public REST surface

#### `POST /api/uploads` (authenticated)

- Pipeline: `:api + :authn` (visitor OR user subject required).
- Multipart body: `file=<binary>` + `expire=<seconds>` (1h..72h ladder
  per vjt; client picks from existing TTL-seconds preference).
- Per-file cap enforced (returns 413 with `{"error":"file_too_large",
  "max_bytes":N}` if `byte_size > per_file_cap`).
- Global cap enforced (sum of `bytes WHERE deleted_at IS NULL` +
  this upload's size > global_cap → 507 with
  `{"error":"insufficient_storage"}`). Race-tolerant: we accept that
  the cap can be slightly exceeded under burst; the reaper restores
  the invariant on next sweep.
- Allowed MIME: `image/png | image/jpeg | image/gif | image/webp |
  image/apng` (mirrors litterbox impl + matches cic pre-check).
- Slug minted server-side, file written via
  `File.write!(:write, file_path, bytes)` (atomic on POSIX for
  single-write of small files).
- Returns 201 `{"slug": "<slug>", "url": "https://<phx_host>/uploads/<slug>",
  "expires_at": "..."}`.
- Server resolves the public URL using `Endpoint.url() <> "/uploads/" <>
  slug` so deploys with different `PHX_HOST` work without per-deploy
  config.

#### `GET /uploads/:slug` (public, NO auth)

- Pipeline: `[]` (no pipeline; scope-level).
- Validates slug is base32. Else 404 (no oracle).
- Loads row by slug. If `deleted_at IS NOT NULL` or `expires_at IS
  NOT NULL AND expires_at <= now()` or file missing on disk → 404.
- Serves file with `Content-Type: <mime>`, `Content-Disposition:
  inline`, `Cache-Control: public, max-age=3600` (short cache; URLs
  are one-shot in practice but cic image-render in scrollback would
  benefit from short caching if vjt ever flips that flag — for now
  it's just clickable links).
- `Plug.Conn.send_file/3` — kernel sendfile path, zero copy.

### A4. Admin REST surface

#### `GET /admin/settings` (admin)

- Returns ALL current settings via `ServerSettings.list_all/0` →
  `{"settings": {"upload": {"active_host": "embedded", "per_file_cap_bytes":
  10485760, "global_cap_bytes": 10737418240}}}`.

#### `PUT /admin/settings` (admin)

- Body: full or partial nested settings map; validate at boundary
  (`ServerSettings.validate/1`); upsert per-key on success.
- Returns 200 with the full new state.
- Server broadcasts `grappa:admin:settings_changed` over PubSub on
  successful update; cic reactive layer updates `activeHost()`
  reactively (B2 wire).

#### `GET /admin/uploads`

- Returns the upload registry: slug, owner, mime, bytes, expires_at,
  deleted_at. For operator visibility into disk usage.

#### `DELETE /admin/uploads/:slug`

- Soft-delete the row + unlink the file synchronously. Returns 204.

### A5. Reaper — `Grappa.Uploads.Reaper`

- Same shape as `Grappa.Visitors.Reaper`: `:permanent` GenServer,
  60s default tick, configurable via `:interval_ms` start opt.
- Sweep: `Uploads.list_expired/0` → for each, `File.rm/1` (logs +
  continues on error), then `Uploads.soft_delete/1`. Per-row failures
  log + continue.
- Adds `:upload_reaped` AdminEvents entry per row (mirrors visitor
  reap event).
- Boot order: AFTER `GrappaWeb.Endpoint` (same "REST sees it before
  reaper does" invariant the visitor reaper documents), BEFORE
  Bootstrap.

### A6. Supervision tree + boot wiring (COLD-deploy reason 1)

Adds two children to `Grappa.Application.start/2`:
- `Grappa.Uploads.Reaper` (permanent, after Endpoint, before Bootstrap)
- `Grappa.ServerSettings` startup: pre-boot cache hydration.
  Implementation: NOT a GenServer (per CLAUDE.md "Agent: almost
  never the right call; prefer GenServer for explicit contracts" —
  but ServerSettings is a stateless query helper; it just READS from
  the DB on every call. Cache hot path via `:persistent_term` if we
  want it later, but v1 = no cache, direct Repo query per call.
  Settings reads are <1ms, infrequent.

`mkdir_p(runtime/uploads)` happens in `Grappa.Uploads` module-level
init via `@on_load`-equivalent: a `child_spec` or a one-shot Task
spawned by Application — actually simpler to do in Reaper's `init/1`
since Reaper is the only writer to that dir at scheduled cadence.
**Re-decision**: do mkdir_p in Reaper.init/1 — single owner of the
fs path makes ordering trivial.

### A7. nginx + CSP (COLD-deploy reason 2)

- `infra/nginx.conf`: add `/uploads/` to the public allowlist (NOT
  the `/admin/*` admin allowlist); add `/api/uploads` to the REST
  POST allowlist.
- `client_max_body_size`: set to **100MB hard ceiling** in
  `infra/nginx.conf` (vjt's call — admin-configurable per-file cap
  lives in grappa, nginx is just the edge gate). Existing per-route
  body-size limits don't apply because `/api/uploads` doesn't go
  through `GrappaWeb.BodyLimit` plug stack (it's a multipart-FILE
  endpoint, not a JSON body). NEW plug `GrappaWeb.MultipartLimit`
  reads `Grappa.ServerSettings.get_upload_per_file_cap_bytes/0` at
  request time + rejects with 413. nginx hard ceiling is the
  belt-and-braces gate so a misconfigured server setting can't
  enable a 10GB-per-upload DoS.
- `infra/snippets/security-headers.conf` CSP `img-src`: NO CHANGE
  needed — same-origin images already covered by default-src 'self'.
  The litterbox `connect-src` entry stays (catbox-as-fallback still
  reachable).
- `cicchetto/e2e/nginx-test.conf`: mirror the upload route additions.

### A8. cic adapter (B2 scope, designed here for sanity-check)

- New `embeddedHost: ImageHost` in `cicchetto/src/lib/image-upload.ts`.
- Shape:
  - `id: "embedded"`
  - `displayName: "this server"`
  - `retentionStatement: "this grappa server. The URL is public — anyone with it can view the file."`
  - `ttlOptions`: same 1h/12h/24h/72h ladder
  - `defaultTtl: "24h"` (mirrors litterbox)
  - `acceptedMimeTypes`: 5 image MIMEs (same as litterbox)
  - `maxFileSizeBytes`: dynamic — read from `serverSettings()` reactive
    signal. Default 10MB before settings fetched.
  - `supportsProgress: true` (same-origin = no CORS preflight gotcha,
    real progress works)
  - `upload`: POST to `/api/uploads` with auth header from `token()`,
    multipart `file=` + `expire=<seconds>`. Parse JSON response,
    return `data.url`.
- `availableHosts: [embeddedHost, litterboxHost]` (embedded FIRST so
  it's the default when admin hasn't picked).
- `activeHost()` rewritten to read `serverSettings().uploadActiveHost`
  signal. Reactive — settings change broadcasts via WS channel
  push update the signal, re-rendering ComposeBox + SettingsDrawer +
  PrivacyModal.
- New cic module `cicchetto/src/lib/serverSettings.ts`:
  - `loadServerSettings(token)` — GET `/admin/settings` is admin-only;
    but the upload sub-tree (`upload.active_host` + caps) is needed
    by EVERY operator. Split: NEW public `GET /api/server-settings`
    endpoint returns ONLY the operator-visible subset (active_host,
    per_file_cap, global_cap). Admin endpoint stays at `/admin/settings`
    for everything else.
  - Reactive signal mirrors server state. WS channel pushes
    `server_settings_changed` payload on admin update.

### A9. Admin UI (B2 scope)

- New `AdminPane` tab: **"Settings"**. AdminPane gets 5 tabs now
  (Visitors / Sessions / Networks / Events / Settings).
- `AdminSettingsTab.tsx`:
  - Image upload section:
    - Active host: `<select>` (embedded | litterbox).
    - Per-file cap: number input, MB units.
    - Global cap: number input, GB units.
  - "Save" button → PUT `/admin/settings` with the form values.
- New `AdminUploadsTab.tsx`? — vjt didn't ask. **DESCOPED**:
  per-upload visibility via admin REST exists but no UI v1; operator
  can `bin/grappa list-uploads` (new operator verb) for triage.

### A10. PubSub broadcast for settings change

- On `PUT /admin/settings` success: `Phoenix.PubSub.broadcast(Grappa.PubSub,
  "grappa:admin:settings_changed", {:settings_changed, new_settings})`.
- `AdminChannel` subscribes + pushes to admin operators (visible in
  AdminPane → "settings updated by ${other_admin}").
- ALSO broadcast on a public topic `grappa:server_settings` for every
  operator (visitors + users) — cic subscribes, updates the reactive
  `serverSettings()` signal, ComposeBox/SettingsDrawer/PrivacyModal
  reflect immediately.

### A11. Bootstrap timing — server_settings BEFORE Bootstrap

Bootstrap runs at boot and spawns sessions. Doesn't depend on
server_settings. But Reaper does (needs to know "is global cap
config readable" — actually no, reaper reads `expires_at` only).
So no ordering coupling beyond what's already documented.

### A12. Test isolation

- All Uploads + ServerSettings tests `use Grappa.DataCase, async:
  true` (sandbox-per-test). No singleton state.
- File-write in tests uses a per-test `runtime/uploads_test_<pid>`
  dir, cleaned in `on_exit/1`. Path injected via start_link opt.
- Reaper tests use `interval_ms: 1` + sync `sweep/0`, same as
  Visitors.Reaper.

## Open questions (PRE-CODE)

### Q-AUTH-PUBLIC-SETTINGS

Should the public `/api/server-settings` endpoint (the operator-visible
subset) be unauthenticated, or `:authn`-gated? Voting `:authn` since
the cic operator is always logged in by the time they touch upload UI
(login wall). Lighter blast radius (don't leak admin choice to anon
GETs).

### Q-CATBOX-DEFAULT

cic ships with `availableHosts: [embeddedHost, litterboxHost]` and
`activeHost()` reads server config. If server hasn't been seeded
(fresh deploy), default is `:embedded`. Means: pre-existing operator
who had litterbox baked into bundle-N gets switched to embedded the
first time they reach the server. Acceptable (default is sane).

### Q-IRSSI-DRIFT

Existing PRIVMSGs in scrollback contain `📸 https://litter.catbox.moe/...`
URLs. They keep working (catbox is still serving). The pre-bucket-B
shape doesn't break. New uploads after B lands go to
`https://<phx_host>/uploads/...`. Mixed-shape scrollback is fine —
they're all clickable links.

### Q-AUTH-VIEW

vjt picked "Authenticated upload, public-by-URL view" — matches the
litterbox model. **Decision**: `GET /uploads/:slug` is fully public.
The 128-bit-entropy slug IS the access token.

### Q-VISITOR-OWNERSHIP-PERSISTENCE

Visitors are reaped on TTL expiry → their uploads CASCADE delete by
FK. Means a visitor who uploads an image, shares it, then logs out
will see the image disappear when their visitor row gets reaped.
**Decision**: keep the FK CASCADE — visitor reaping CASCADEs ALL
their owned data (messages, query_windows, push_subscriptions,
user_settings, read_cursors). Uploads join the family. Operators
who want long-lived shares can `bin/grappa create-user`.

## Sub-bucket implementation order

### B1 — server stack

Self-contained. Migration + contexts + REST + Reaper + supervision +
nginx. Lands behind cic untouched (existing litterbox path keeps
working). Tests are server-only ExUnit (Grappa.DataCase pattern).
**COLD deploy** (migration + supervision tree change + nginx).

Commits within B1:
1. Migration: `uploads` + `server_settings` tables.
2. `Grappa.Uploads` context (schema + CRUD + reaper-list query +
   global-cap-sum query) + Reaper GenServer.
3. `Grappa.ServerSettings` context (k/v accessors + validate).
4. REST: `POST /api/uploads` + `GET /uploads/:slug`, new
   `GrappaWeb.UploadsController` + `MultipartLimit` plug.
5. REST: `GET/PUT /admin/settings` + `GET/DELETE /admin/uploads`,
   `GrappaWeb.Admin.SettingsController` + `Admin.UploadsController`.
6. `/api/server-settings` public-subset endpoint.
7. PubSub broadcast on settings change.
8. Application.start/2 wires Reaper + (optionally) settings cache.
9. nginx allowlist + client_max_body_size update.
10. Operator verb `bin/grappa list-uploads` (parity with
    `list-visitors`).

### B2 — cic adapter + admin UI

1. New `embeddedHost` impl in `cicchetto/src/lib/image-upload.ts` +
   tests.
2. `cicchetto/src/lib/serverSettings.ts` reactive signal + WS
   subscription.
3. `activeHost()` rewrite to read serverSettings.
4. `AdminPane.tsx` adds 5th tab "Settings".
5. New `AdminSettingsTab.tsx` (host pick + cap inputs + save).
6. cic vitest coverage for the embedded host adapter wire shape +
   the reactive activeHost flip.

### B3 — close

1. Playwright e2e: `ux-6-b-embedded-upload.spec.ts` — visitor opens
   ComposeBox, drag-drops a PNG, asserts (a) URL POSTed back, (b)
   resulting PRIVMSG body matches `📸 https://...`, (c) GET on the
   URL returns the same bytes.
2. Playwright e2e: `ux-6-b-admin-settings.spec.ts` — admin opens
   AdminPane → Settings → flips host to litterbox → save → assert
   cic ComposeBox now targets litterbox endpoint.
3. Reviewer-loop agent (literal gate-tail paste per
   `feedback_reviewer_gate_evidence`).
4. Address findings.
5. Commit + push + COLD deploy + cic-bundle deploy + healthcheck +
   CDP smoke (UPLOAD a real PNG via the live tab).
6. Memory entry + MEMORY.md pointer + project-story episode.

## Risk register

- **Bind-mount perm trap** (`feedback_named_volume_uid_trap` +
  `feedback_bind_mount_shadows_image`): `runtime/uploads/` must be
  writable by the container user. Existing `runtime/grappa_*.db`
  already proves the path works → same pattern, same owner, same
  dir-level setup at boot.
- **First-boot global-cap query**: cold-boot timing — Bootstrap
  + Reaper both query DB at boot. New `uploads` table is empty,
  no slow query. Fine.
- **Reaper unlink race**: GET `/uploads/:slug` between row-soft-delete
  + file-unlink is a window for partial 404s. Mitigation: Reaper
  unlinks file BEFORE soft-delete (file gone → next GET sees row
  alive + ENOENT, return 404 + soft-delete on the side).
- **Disk fill**: global cap is the only gate. Operator MUST set it
  to a value < free disk. Document in README + admin UI helptext.
- **CSP**: same-origin image fetches are covered by default-src 'self'
  — no CSP change needed for VIEWING uploads. POST to same-origin
  same way.
- **Carry-debt — HomePane WS rerender bug**: orthogonal; settings
  change broadcast uses a different mechanism (admin topic) so the
  bug shouldn't surface here. Will retest in B3.

## Cluster mandates carry

- Per-bucket e2e mandatory (B3 covers full feature flow).
- Reviewer-loop per bucket (B1 commits get reviewer-loop too — server
  changes deserve same rigor as cic).
- KISS — single migration, single REST surface, single Reaper.
- No localized strings server-side — all UI copy lives in cic.
- vjt is permanent admin (settings reachable for him).
- Cluster with migration MUST cold-deploy.
- `feedback_nginx_admin_allowlist_required` — `/admin/settings` +
  `/admin/uploads` MUST be added to nginx admin allowlist.
- `feedback_e2e_visitor_members_list` doesn't apply (no IRC JOIN
  involved).
