# Admin panel — full users / networks / servers / credentials CRUD

**Status**: plan v1 (2026-05-31, pre-vjt-sign-off). NO code written yet.
**Branch / worktree**: `/Users/mbarnaba/code/grappa/.claude/worktrees/feat-admin-panel` on `feat/admin-panel` (branched from local `main` @ `b130a63`).
**Position**: extends M-cluster (M-5 / M-6) — completes CRUD where today only GET + narrow PATCH exist.

| Bucket | Status | Deploy | Migration |
|--------|--------|--------|-----------|
| 1. Network CRUD (POST/DELETE `/admin/networks`) + Servers CRUD (POST/PUT/DELETE) — contexts + REST | pending | **HOT** | no |
| 2. User CRUD (POST/DELETE) + last-admin guard + dedicated password rotation endpoint | pending | **HOT** | no |
| 3. Credentials full CRUD via REST (POST/DELETE) + extended PUT (password / auth_method) with session-lifecycle wrapper | pending | **HOT** | no |
| 4. AdminEvents Wire extensions + PubSub broadcasts for all new mutations | pending | HOT | no |
| 5. cic — AdminUsersTab + AdminCredentialsTab + extend AdminNetworksTab with server CRUD | pending | HOT (cic bundle) | no |
| 6. Playwright e2e + reviewer-loop + nginx snippet pass + docs | pending | HOT | no |

**No migrations**: every schema already exists (`users`, `networks`, `network_servers`, `network_credentials`, `server_settings`, `uploads`). New REST surfaces consume existing tables. Hot-deploy across the board.

---

## 1. Goal + scope

**Goal.** Operators run the entire bouncer from a browser. Today: `mix grappa.create_user`, `mix grappa.bind_network`, `mix grappa.add_server`, `mix grappa.update_network_credential`, `mix grappa.remove_server`, `mix grappa.unbind_network` are the only way to mutate users + networks + servers + credentials. The current `/admin/*` surface is read-only-plus-narrow-PATCH (caps + is_admin + a 5-field credential whitelist). This cluster lifts every mix-task verb into the admin REST + UI surface.

**Out of scope.**
- Mix task removal — the CLI verbs stay for operator scripting, but their *core logic* MUST live in the contexts (it already does; this cluster guarantees the new REST endpoints call the same context functions, no logic duplication).
- Server `enabled` / `priority` editing UI — schema supports it; UI ships read-only display first. Editing is a follow-up (no spec demand).
- Network `slug` rename — schema-immutable by design (FK + topic + scrollback). Operator deletes + recreates if needed; UI surfaces the rule.
- Password rotation on `PUT /users/:id` — split into a separate dedicated action (see A-3).
- User rename — `name` is baked into PubSub topics (`grappa:user:{name}`) and bind keys; same rule as network slug. Schema-immutable.
- Admin self-demotion of last admin — server-side blocked (A-4).

---

## 2. Architecture decisions

### A-1. PubSub broadcast strategy for admin mutations

Two existing channels carry admin-relevant fan-out:

- **`Topic.admin_events()` = `"grappa:admin:events"`** — the operator-console ring buffer, consumed by `AdminPane` via `AdminChannel`. New mutation types add `Grappa.AdminEvents.Wire` constructors and call `AdminEvents.record/1` from the controller (where actor attribution is in scope, mirroring `network_caps_updated`).
- **`Topic.user(user_name)`** — the per-user fan-out consumed by every authenticated cic socket. Credential mutations that change the user's `home_data` shape (bind, unbind, password rotate that affects connection_state) ALSO broadcast here so the affected user's other browser tabs / sessions re-render without a poll.

**New `AdminEvents.Wire` event kinds** (one constructor each, exhaustive `from_telemetry/3` discipline preserved):

| Kind | Trigger | Actor |
|------|---------|-------|
| `:user_created` | `POST /admin/users` | admin |
| `:user_password_changed` | `PUT /admin/users/:id/password` | admin |
| `:user_deleted` | `DELETE /admin/users/:id` | admin |
| `:network_created` | `POST /admin/networks` | admin |
| `:network_deleted` | `DELETE /admin/networks/:id` | admin |
| `:server_added` | `POST /admin/networks/:id/servers` | admin |
| `:server_updated` | `PUT /admin/networks/:network_id/servers/:id` | admin |
| `:server_removed` | `DELETE /admin/networks/:network_id/servers/:id` | admin |
| `:credential_bound` | `POST /admin/credentials` | admin |
| `:credential_unbound` | `DELETE /admin/credentials/:user_id/:network_id` | admin |

Plus an existing reuse: credential password changes via PUT trigger `:session_terminated` (when we kill-respawn — see A-2) so the Events tab tells the operator the side effect happened.

**Cic-side enforcement of closed union**: `cicchetto/src/lib/adminEvents.ts` `WireAdminEvent` discriminated union + `assertNever` in the dispatch. Adding a kind without the cic arm is a TS compile error.

### A-2. Running-session lifecycle on credential update/delete

The hard question: an admin edits a running session's credential — what happens to the live `Session.Server`?

**Decision matrix** (table IS the spec — controller MUST implement exactly):

| Mutation | Session.Server action | Rationale |
|----------|----------------------|-----------|
| PUT credential, no `password` / `auth_method` / `nick` change | leave alone | Cosmetic (realname, autojoin) — next reconnect picks up the new values; live nothing breaks. |
| PUT credential, `nick` changed | leave alone, surface warning in response (`session_restart_required: true` wire field) | Server-side rename is `/nick`-routed not credential-routed; admin should `/nick` from the operator side or kick the session. Hands-off keeps the live state predictable. |
| PUT credential, `password` or `auth_method` changed | **kill + respawn** via `Session.stop_session/2` then `SpawnOrchestrator.spawn/4` | New auth shape — old session is authed under stale creds; reconnect to apply. |
| DELETE credential | `Credentials.unbind_credential/2` already kills the session (it calls `Session.stop_session/2` before the txn commits) | Existing invariant, no change. |
| Network DELETE with bound credentials | refuse with `{:error, :credentials_present}` → 409 Conflict | See A-5. |
| Server DELETE while session uses it | leave session alone | Picker only consulted on reconnect (`Servers.pick_server!/1`). Live connection stays on its current socket. |

**No operator confirmation prompt in REST** — admin already confirmed in the UI. REST is the authoritative boundary; double-prompting would split the truth.

**Implementation site**: a new context helper `Grappa.Networks.Credentials.update_credential_with_session_lifecycle/3` wrapping the existing `update_credential/3` + decision-table dispatch. Controller stays thin. The wrapper returns `{:ok, %{credential: cred, session_action: :left_alone | :restarted | :no_session}}` so the controller can render the side-effect in the response and emit the right `AdminEvents`.

### A-3. Password update semantics

**Users**: split. `PUT /admin/users/:id` updates `is_admin` ONLY (preserves the existing M-6 whitelist contract — operators rely on it for two-window edits). Password rotation is a NEW dedicated endpoint:

- `PUT /admin/users/:id/password` — body `{password: string}`. Returns updated user JSON. Emits `:user_password_changed`. Bcrypt/Argon2 cost gates the response time (~100ms); operator-facing, fine.

**Credentials**: extended PUT. `PUT /admin/credentials/:user_id/:network_id` adds `password` and `auth_method` to the existing whitelist (today M-6 explicitly excludes them). The existing `Credential.changeset/2` validation rule ("password required when auth_method changes") fires verbatim — no new validation logic.

**Why split for users, unify for credentials**: users have ONE plaintext field (the login password). Credentials have a tight coupling between `password` + `auth_method` (the changeset enforces it). Forcing operators through two endpoints for a method+password swap would be ergonomic noise.

### A-4. is_admin self-demotion guard — last admin invariant

**Hard rule**: admin MUST NOT be able to demote the last admin (locks the deployment out of its own admin panel). Two-layer enforcement:

- **Context-side guard** in `Grappa.Accounts.update_admin_flags/2`: when `attrs[:is_admin] == false`, query `count(id) where is_admin == true and id != ^target_id`. If zero → return `{:error, :last_admin}`. New FallbackController clause: `:last_admin → 422 {"error": "last_admin"}`. Wire-string convention preserved.
- **Context-side guard** in `Grappa.Accounts.delete_user/1`: same check (deleting the last admin is the same lockout).

**Self-demotion is allowed** when another admin exists. Spec is "last admin," not "self." This matches AdminSessionsController's `:cannot_disconnect_self` precedent (operator self-locks are the bug class, not self-actions in general).

**Race**: two concurrent demotes of the last two admins both see `count == 1` and both succeed. Mitigation: wrap in `Repo.transaction`. SQLite is single-writer so the second tx waits + observes the first's commit — naturally serialized. Cheap to implement; defensive-but-free. See R-2 for Postgres-future caveat.

### A-5. Network DELETE — what happens to bound credentials?

**Refuse, don't cascade.** Today `Credentials.unbind_credential/2` cascades the network row only when the LAST credential is removed (cascade-on-empty). The inverse — deleting the network while credentials exist — is not a verb the codebase supports today.

**Decision**: `DELETE /admin/networks/:id` returns `{:error, {:credentials_present, count}}` → 409 Conflict with body `{"error": "credentials_present", "credential_count": N}`. Operator must unbind every credential first. Mirrors the existing `{:error, {:network_circuit_open, retry_after}}` tuple shape.

**Why not force-cascade**: cascading would silently kill running sessions for OTHER users than the admin. Multi-tenant deployments (operator hosts grappa for friends) — the friend wakes up to a missing network with no warning. The 409 forces the admin to explicitly unbind each user, which surfaces the side effects per-user before the destructive verb.

Alternative considered: `DELETE /admin/networks/:id?force=true` to opt into cascade. Rejected — adds a footgun query param for a low-value verb. Operator can script "unbind all + delete" in 5 lines if they want it.

**Scrollback orphaning**: deleting the network when credentials are gone still needs the same `:scrollback_present` check from `unbind_credential/2`. Lift the check into `Grappa.Networks.delete_network/1` (new context function) so both code paths share it.

### A-6. Server DELETE — what about a session currently connected to that server?

**Leave the session alone.** `Servers.pick_server!/1` is only consulted on (re)connect. The live socket stays open against its current host:port regardless of the DB row. On next reconnect, the picker walks the new list. If the operator deleted the LAST enabled server, the next reconnect raises `NoServerError` — operator misconfiguration is loud, never silent.

**Wire signal**: response includes `affected_session_count: N` (count of `Session.Server`s currently connected to the deleted endpoint, via `Session.list_active_for_network/1` + a runtime-state probe). Operator sees "you deleted the server N sessions are currently using; next reconnect will pick a different one or fail." No automatic restart.

### A-7. Wire modules per resource

Existing `*.AdminWire` modules stay; extend them with full-CRUD-shape support.

| Resource | Wire module | New fields / functions |
|----------|-------------|------------------------|
| User | `Grappa.Accounts.AdminWire` | Existing `user_to_admin_json/2` covers all REST shapes (create / update / delete return the same row shape). No change. |
| Network | `Grappa.Networks.AdminWire` | Add `network_to_admin_json/1` overload OR a sibling `network_with_servers_to_admin_json/1` for `GET /admin/networks` enriched-by-`:servers` shape (the controller already preloads via composition; lift the assembly into the Wire module for symmetry). |
| Server | NEW `Grappa.Networks.Servers.AdminWire` | `server_to_admin_json/1` → `%{id, network_id, host, port, tls, priority, enabled, inserted_at, updated_at}`. Standalone module so future fail-over fields land here. |
| Credential | `Grappa.Networks.Credentials.AdminWire` | Existing `credential_to_admin_json/2` covers list + update. Extend `t()` typespec with optional `session_action: :left_alone \| :restarted \| :no_session` for the PUT response variant. |

**Excluded fields invariant** stays the same (no password / password_encrypted leakage). Adding a field = one explicit edit per Wire module.

### A-8. Auth method enum

`Grappa.Networks.Credential.auth_methods/0` = `[:auto, :sasl, :server_pass, :nickserv_identify, :none]` (verify exact set at bucket-3 implementation — do NOT add a new method). The existing `CredentialsController.maybe_atomize_auth_method/2` pattern is reused verbatim for `POST /admin/credentials`.

### A-9. Credential id — composite vs surrogate

`network_credentials` has a composite primary key `(user_id, network_id)` — no surrogate `id`. (Verified: `lib/grappa/networks/credential.ex` declares `@primary_key false` + `belongs_to :user, ..., primary_key: true` + `belongs_to :network, ..., primary_key: true`.) Existing `PATCH /admin/credentials/:user_id/:network_id` URL shape uses the composite.

**Decision**: keep the composite URL shape for ALL credential endpoints — `:user_id/:network_id` everywhere. The spec's `:id` is reframed at the controller as the composite. Wire model carries both `user_id` + `network_id` (already does). One URL shape, one routing rule. Rejected adding a surrogate `id` migration just to satisfy a spec's URL shape — schema is fine, spec adapts.

So in practice:
- `GET /admin/credentials` (with `?user_id` / `?network_id` filters)
- `POST /admin/credentials` — body has `user_id` + `network_id` + auth attrs
- `PUT /admin/credentials/:user_id/:network_id`
- `DELETE /admin/credentials/:user_id/:network_id`

---

## 3. API contract table

| Method + Path | Request body | Response (Wire shape) | Errors | PubSub |
|---------------|--------------|----------------------|--------|--------|
| `GET /admin/users` | — | `%{users: [Accounts.AdminWire.t()]}` | — | n/a (read) |
| `POST /admin/users` | `%{name: string, password: string, is_admin?: bool}` | `Accounts.AdminWire.t()` | 422 validation_failed | `:user_created` on `admin_events` |
| `PUT /admin/users/:id` | `%{is_admin?: bool}` | `Accounts.AdminWire.t()` | 404 not_found, 422 last_admin / validation_failed, 400 bad_request | `:user_updated` on `admin_events` if `is_admin` changed |
| `PUT /admin/users/:id/password` | `%{password: string}` | `Accounts.AdminWire.t()` | 404, 422 validation_failed | `:user_password_changed` |
| `DELETE /admin/users/:id` | — | `204 No Content` | 404, 422 last_admin | `:user_deleted` |
| `GET /admin/networks` | — | `%{networks: [admin wire row + servers + circuit + live_counts]}` | — | n/a |
| `POST /admin/networks` | `%{slug: string, max_concurrent_visitor_sessions?: int\|nil, max_concurrent_user_sessions?: int\|nil, max_per_client?: int\|nil}` | network admin wire row | 422 validation_failed (unique slug, format) | `:network_created` |
| `PUT /admin/networks/:slug` | caps whitelist (existing M-5) | network admin wire row | 404, 422, 400 bad_request | `:network_caps_updated` (existing) |
| `DELETE /admin/networks/:id` | — | `204 No Content` | 404, 409 credentials_present (`%{error, credential_count}`), 409 scrollback_present | `:network_deleted` |
| `POST /admin/networks/:id/servers` | `%{host: string, port: int, tls?: bool, priority?: int, enabled?: bool}` | server admin wire row | 404 (network), 422, 409 already_exists | `:server_added` |
| `PUT /admin/networks/:network_id/servers/:id` | `%{host?: string, port?: int, tls?: bool, priority?: int, enabled?: bool}` | server admin wire row | 404, 422, 409 already_exists | `:server_updated` |
| `DELETE /admin/networks/:network_id/servers/:id` | — | `%{affected_session_count: int}` (200) | 404 | `:server_removed` |
| `GET /admin/credentials` | optional `?user_id=UUID` / `?network_id=int` filters | `%{credentials: [Credentials.AdminWire.t()]}` | 400 bad_request (malformed filter) | n/a |
| `POST /admin/credentials` | `%{user_id: UUID, network_id: int, nick: string, auth_method: atom-string, password?: string, sasl_user?: string, realname?: string, auth_command_template?: string, autojoin_channels?: [string]}` | credential admin wire row | 404 (user/network), 422, 409 already_exists | `:credential_bound` |
| `PUT /admin/credentials/:user_id/:network_id` | extended whitelist (autojoin, nick, sasl_user, realname, auth_method, auth_command_template, password) | credential admin wire row + `session_action` field | 404, 422, 400 | `:credential_updated` + (per A-2) `:session_terminated` when password/auth_method changes kill+respawn |
| `DELETE /admin/credentials/:user_id/:network_id` | — | `204 No Content` | 404, 409 scrollback_present (cascade-on-empty path — existing semantics) | `:credential_unbound` |

**New FallbackController clauses** (extend the `@spec` and the dispatch):
- `:last_admin → 422 {"error": "last_admin"}`
- `{:credentials_present, N} → 409 {"error": "credentials_present", "credential_count": N}` (tuple shape mirrors `{:network_circuit_open, retry_after}`)
- `:already_exists → 409 {"error": "already_exists"}`

---

## 4. Bucket split

### Bucket 1 — Network CRUD + Server CRUD (context + REST)

**Scope**: new context functions + new admin controller endpoints for networks (create/delete) + servers (create/update/delete via REST). Extend the existing controllers, don't add new ones.

**Files touched**:
- `lib/grappa/networks.ex` — add `create_network/1`, `delete_network/1` (with credentials_present + scrollback_present checks).
- `lib/grappa/networks/servers.ex` — add `update_server/2`, `get_server/2`, `delete_server/1` (extend the existing `add_server/2`).
- `lib/grappa/networks/servers/admin_wire.ex` — NEW. `server_to_admin_json/1`.
- `lib/grappa/networks/admin_wire.ex` — extend with `network_with_servers_to_admin_json/1` (move composition out of the controller).
- `lib/grappa_web/controllers/admin/networks_controller.ex` — add `create/2`, `delete/2`.
- `lib/grappa_web/controllers/admin/servers_controller.ex` — NEW. `create/2`, `update/2`, `delete/2`.
- `lib/grappa_web/router.ex` — add 5 routes under existing `scope "/admin", GrappaWeb.Admin`.
- `lib/grappa_web/controllers/fallback_controller.ex` — add `{:credentials_present, N}` (tuple) + `:already_exists` clauses, extend `@spec`.
- `infra/snippets/locations-api.conf` — admin allowlist regex grouping `(visitors|sessions|credentials|networks|...)` needs `servers` added. One-line edit. (`infra/nginx.conf` + `cicchetto/e2e/nginx-test.conf` include the snippet by reference — single source.)

**Migration**: no.

**TDD steps**:
1. `test/grappa/networks_test.exs` — `create_network/1` happy + duplicate-slug + bad-slug paths; `delete_network/1` with credentials → `{:credentials_present, N}`; with scrollback → `:scrollback_present`; clean delete success.
2. `test/grappa/networks/servers_test.exs` — `update_server/2` (host/port/tls/priority/enabled), `delete_server/1`, `get_server/2`.
3. `test/grappa/networks/servers/admin_wire_test.exs` — wire shape pinned; password-leakage style check (no internal fields).
4. `test/grappa_web/controllers/admin/networks_controller_test.exs` — extend with POST/DELETE happy + error matrix.
5. `test/grappa_web/controllers/admin/servers_controller_test.exs` — NEW. Full CRUD coverage.

**Exit criteria**:
- `scripts/check.sh` exits 0 (format + credo + dialyzer + sobelow + doctor + ExUnit + cic vitest + integration e2e + bats).
- New endpoints reachable through nginx allowlist (e2e curl + verify response shape).
- `mix grappa.bind_network` + `mix grappa.add_server` mix tasks still pass (regression — they share the same context functions).

**Reviewer loop dimensions**: security (`/code-review:check` with `--effort high` for the destructive verbs — DELETE network/server), API consistency (wire shapes mirror existing admin endpoints).

**Deploy mode**: HOT — pure lib changes, no migration, no supervision tree change. cic unchanged.

**Browser smoke**: n/a (no cic in this bucket).

---

### Bucket 2 — User CRUD (context + REST)

**Scope**: full user lifecycle + last-admin guard + password rotation endpoint.

**Files touched**:
- `lib/grappa/accounts.ex` — add `delete_user/1`, extend `update_admin_flags/2` with `:last_admin` guard, add `update_password/2`.
- `lib/grappa/accounts/user.ex` — add `password_changeset/2` (mirror of `admin_changeset/2`: narrow, password-only).
- `lib/grappa_web/controllers/admin/users_controller.ex` — add `create/2`, `delete/2`, `update_password/2`.
- `lib/grappa_web/router.ex` — add 3 routes (POST, DELETE, PUT password sub-resource).
- `lib/grappa_web/controllers/fallback_controller.ex` — `:last_admin` clause.

**Migration**: no.

**TDD steps**:
1. `test/grappa/accounts_test.exs` — `create_user` (already exists; sanity); `update_admin_flags/2` last-admin guard (single admin demote → `:last_admin`, two admins demote either → success); `delete_user/1` (last admin → `:last_admin`; non-last → cascades; non-existent → `:not_found`).
2. `test/grappa/accounts/user_test.exs` — `password_changeset/2` (valid + length + missing).
3. `test/grappa_web/controllers/admin/users_controller_test.exs` — extend with POST/DELETE/PUT-password + last-admin invariant + 403/401 gate.

**Cascade question**: `DELETE /admin/users/:id` — what about the user's credentials + sessions?

**Decision**: `delete_user/1` MUST first iterate the user's credentials and call `Credentials.unbind_credential/2` on each (which already kills the session). Then delete the user row. Atomic via `Repo.transaction`. Returns `{:error, :scrollback_present}` if any credential has scrollback (operator deletes scrollback explicitly first). Documented in the function moduledoc.

**Auth sessions**: `Accounts.Session` rows have `user_id` FK. R-1 calls out the FK cascade verification — implementer reads the migration first; if `RESTRICT`, add a bulk-revoke helper instead of a new migration (keeps the bucket HOT).

**Exit criteria**: `scripts/check.sh` 0; last-admin guard test in red-first-then-green; password rotation round-trip via curl.

**Reviewer loop dimensions**: security HIGH (password handling + delete cascade), correctness (last-admin race).

**Deploy mode**: HOT.

---

### Bucket 3 — Credentials full REST CRUD

**Scope**: POST (bind) + DELETE (unbind) + extended PUT (password / auth_method).

**Files touched**:
- `lib/grappa/networks/credentials.ex` — add `update_credential_with_session_lifecycle/3` wrapper per A-2; verify `bind_credential/3` is callable with the new admin-wire shape (it already is — the mix task calls it).
- `lib/grappa_web/controllers/admin/credentials_controller.ex` — add `create/2`, `delete/2`; rewrite `update/2` to use the new wrapper + return `session_action` in the response.
- `lib/grappa/networks/credentials/admin_wire.ex` — extend `t()` typespec with optional `session_action: :left_alone | :restarted | :no_session`; add `with_session_action/2` helper.
- `lib/grappa_web/router.ex` — add 2 routes; keep PUT URL shape as `:user_id/:network_id`.
- `lib/grappa_web/controllers/fallback_controller.ex` — `:already_exists` clause (shared with bucket 1).

**Migration**: no.

**TDD steps**:
1. `test/grappa/networks/credentials_test.exs` — `update_credential_with_session_lifecycle/3` matrix (cosmetic → `:left_alone`; password change → `:restarted`; nick change → `:left_alone` with warning).
2. `test/grappa_web/controllers/admin/credentials_controller_test.exs` — extend with POST + DELETE + extended PUT; cover the kill-respawn path (assert Session.whereis/2 transitions); cover filtered GET (`?user_id` / `?network_id`).

**Exit criteria**: `scripts/check.sh` 0; live-session kill-respawn observable via test (use the in-process IRC fake server `Grappa.IRCServer`); admin can complete bind → connect → update-password round-trip end-to-end.

**Reviewer loop dimensions**: security HIGH (password vault integration), correctness (session lifecycle decision table — every row of A-2 must have a test).

**Deploy mode**: HOT.

---

### Bucket 4 — AdminEvents broadcasts

**Scope**: thread `AdminEvents.record/1` calls into every mutation point from buckets 1-3.

**Files touched**:
- `lib/grappa/admin_events/wire.ex` — add 10 new constructors per A-1 table; update `event_kind` typespec union.
- `lib/grappa_web/controllers/admin/users_controller.ex` — emit on create/update/delete/password.
- `lib/grappa_web/controllers/admin/networks_controller.ex` — emit on create/delete.
- `lib/grappa_web/controllers/admin/servers_controller.ex` — emit on add/update/remove.
- `lib/grappa_web/controllers/admin/credentials_controller.ex` — emit on bind/update/unbind.
- `cicchetto/src/lib/adminEvents.ts` — extend `WireAdminEvent` discriminated union + render arms in `assertNever` dispatch (compile-error if any new kind is unhandled).

**Migration**: no.

**TDD steps**:
1. `test/grappa/admin_events/wire_test.exs` — each new constructor: shape + closed-union exhaustiveness via `assertNever`-equivalent test (assert the `kind:` field is in the union list).
2. `test/grappa_web/controllers/admin/*_controller_test.exs` — assert each mutation emits the right event (subscribe in test setup, assert receive within 100ms timeout).
3. `cicchetto/src/__tests__/adminEvents.test.ts` (vitest) — dispatch each new event kind, assert ring buffer entry rendered.

**Exit criteria**: `scripts/check.sh` 0; ring buffer in `AdminEventsTab` populates on every mutation in the browser.

**Reviewer loop dimensions**: completeness (every mutation in 1-3 emits at least one event), consistency (`kind:` strings match between server and cic — single source of truth is `AdminEvents.Wire`).

**Deploy mode**: HOT.

---

### Bucket 5 — cic UI (AdminUsersTab + AdminCredentialsTab + extend AdminNetworksTab)

**Scope**: three tabs of new admin UI. Plug into existing `AdminPane.tsx` tab nav.

**Files touched**:
- `cicchetto/src/AdminUsersTab.tsx` — NEW. List + create-modal + per-row edit (is_admin toggle, password rotate) + delete (confirm).
- `cicchetto/src/AdminCredentialsTab.tsx` — NEW. List with filters + create-modal + per-row edit + delete.
- `cicchetto/src/AdminNetworksTab.tsx` — EXTEND. Add per-row "Servers" disclosure (expand → list servers + add-server form + per-server edit/delete); add "Create Network" form above the table; add "Delete Network" inline-confirm per row.
- `cicchetto/src/AdminPane.tsx` — register two new tabs in the TabKey union + tablist + Show blocks (the pattern is already there, mechanical).
- `cicchetto/src/lib/api.ts` (or the existing REST client module — verify path at bucket open) — typed wire shapes + fetch helpers (`adminCreateUser`, `adminDeleteUser`, `adminUpdatePassword`, `adminCreateNetwork`, `adminDeleteNetwork`, `adminAddServer`, `adminUpdateServer`, `adminDeleteServer`, `adminBindCredential`, `adminUnbindCredential`, `adminUpdateCredential` extension).
- `cicchetto/src/lib/adminEvents.ts` — render arms for new event kinds (done in bucket 4, but ensure tab refresh triggers fire here).

**Migration**: no.

**TDD steps**:
1. `cicchetto/src/__tests__/AdminUsersTab.test.tsx` (vitest) — render list, create flow stubbed via `vi.mock`, error renders.
2. `cicchetto/src/__tests__/AdminCredentialsTab.test.tsx` — same.
3. `cicchetto/src/__tests__/AdminNetworksTab.test.tsx` — extend existing to cover Servers disclosure + Create / Delete network.
4. vitest covers shape + DOM, NOT enough per `feedback_ux_e2e_mandatory` — bucket 6 lands the Playwright e2e.

**Exit criteria**: `scripts/bun.sh run test` (vitest) 0; manual browser smoke at end (per `feedback_cicchetto_browser_smoke`) — log in as admin, click through Users → create → delete → Credentials → bind → unbind → Networks → expand → add server → delete server. Each landing in `AdminEventsTab` real-time stream confirms bucket 4 wiring.

**Reviewer loop dimensions**: UX HIGH (confirm dialogs for destructive verbs, error rendering, form validation surfacing), a11y (tablist already correct; new modals need focus management — use existing `InlineConfirmButton` pattern).

**Deploy mode**: HOT (cic bundle change + `POST /admin/cic-bundle-changed` loopback hook for hot reload).

**Browser smoke**: MANDATORY at close (`feedback_cicchetto_browser_smoke`). Login as admin, walk all three tabs.

---

### Bucket 6 — Playwright e2e + reviewer-loop + nginx pass + docs

**Scope**: end-to-end behavioral coverage + final cleanups.

**Files touched**:
- `cicchetto/e2e/tests/admin-users.spec.ts` — NEW.
- `cicchetto/e2e/tests/admin-credentials.spec.ts` — NEW.
- `cicchetto/e2e/tests/admin-network-crud.spec.ts` — NEW.
- `cicchetto/e2e/tests/admin-server-crud.spec.ts` — NEW.
- `infra/snippets/locations-api.conf` — verify regex covers `servers` (added in bucket 1; this bucket re-verifies). Single-file edit per H19.
- `docs/DESIGN_NOTES.md` — append "2026-05-31 — admin panel CRUD cluster" entry covering A-1 through A-9.
- `docs/OPERATIONS.md` — update operator runbook: mix tasks now have REST equivalents; document which to prefer when.
- `CLAUDE.md` — DO NOT extend unless a new invariant lands. The decisions in this plan are cluster-local.

**TDD steps**:
- Playwright specs are red-first via the bucket-5 implementation already shipped (the e2e finds what vitest missed: cross-tab refresh, real WS event propagation, the `assertNever` arms firing in the browser).

**Per-spec scenarios** (each spec ≤ 5 scenarios):

`admin-users.spec.ts`:
1. admin lists users, creates new user, sees ring-buffer event in Events tab.
2. admin promotes a user, target's `is_admin` flips, Events tab shows event.
3. admin attempts to demote last admin → 422 last_admin, UI error banner renders.
4. admin rotates own password → still logged in (auth session not revoked); next login uses new password.
5. admin deletes a user → user's sessions terminated, Events tab shows `:user_deleted` + `:session_terminated`.

`admin-credentials.spec.ts`:
1. admin binds new credential for target user → `:credential_bound` event; user's home_data picks up new network on next refresh.
2. admin edits credential password while session is live → session restarts, `:session_terminated` events fire.
3. admin unbinds credential → cascade-on-empty fires; if last credential → network row also gone.

`admin-network-crud.spec.ts`:
1. admin creates new network → appears in tab + Events.
2. admin attempts delete network with bound credentials → 409 credentials_present, UI shows count.
3. admin unbinds all + deletes → succeeds.

`admin-server-crud.spec.ts`:
1. admin adds server to existing network → `:server_added`.
2. admin edits server port → `:server_updated`; live session unaffected (reconnect would pick the new value).
3. admin deletes server while session is live → response shows `affected_session_count > 0`.

**Exit criteria**:
- `scripts/check.sh` 0 (FULL gate — every Playwright spec passes via `scripts/integration.sh`).
- Reviewer-loop ran twice end-to-end (`/code-review:loop` with effort high), all findings addressed.
- DESIGN_NOTES + OPERATIONS updated.

**Reviewer loop dimensions**: completeness (every spec scenario in section 5 covered), e2e robustness per `docs/plans/2026-05-23-green-ci-3-e2e-hardening.md` lessons (no `waitForTimeout`, no flaky-by-design assertions).

**Deploy mode**: HOT.

**Browser smoke**: full pass on a fresh login.

---

## 5. Test plan

### Playwright e2e (mandatory per `feedback_ux_e2e_mandatory`)

Listed under bucket 6.

### ExUnit unit tests (red-first per bucket)

- `test/grappa/accounts_test.exs` — last-admin guard matrix, password rotation, delete cascade.
- `test/grappa/networks_test.exs` — create_network, delete_network with credentials_present + scrollback_present.
- `test/grappa/networks/servers_test.exs` — update_server, delete_server, get_server.
- `test/grappa/networks/servers/admin_wire_test.exs` — wire shape pinned.
- `test/grappa/networks/credentials_test.exs` — update_credential_with_session_lifecycle matrix.
- `test/grappa/admin_events/wire_test.exs` — new constructors + closed-union.
- `test/grappa_web/controllers/admin/users_controller_test.exs` — extend.
- `test/grappa_web/controllers/admin/networks_controller_test.exs` — extend.
- `test/grappa_web/controllers/admin/servers_controller_test.exs` — NEW.
- `test/grappa_web/controllers/admin/credentials_controller_test.exs` — extend.
- `test/grappa_web/controllers/fallback_controller_test.exs` — new clause coverage (`:last_admin`, `{:credentials_present, N}`, `:already_exists`).

### vitest (cic units)

- `cicchetto/src/__tests__/AdminUsersTab.test.tsx`, `AdminCredentialsTab.test.tsx`, `AdminNetworksTab.test.tsx` (extend), `adminEvents.test.ts` (extend with new kinds).

### User-class parity matrix (`feedback_e2e_user_class_parity_matrix`)

**N/A** — every endpoint in this cluster is admin-gated (`:admin_authn` requires `{:user, %User{is_admin: true}}`). Visitor + non-admin user behavior is uniformly "403 forbidden, no action runs," already covered by existing admin-gate specs. Per-tab specs cover ONLY the admin case (matches AdminPane's exemption note).

---

## 6. Risks + open questions

### R-1. `Grappa.Accounts.Session.user_id` FK cascade
Verify in `priv/repo/migrations/*` that the `sessions` table has `ON DELETE CASCADE` on `user_id`. If not (older schema may have `RESTRICT`), bucket 2 must either add a migration (cold deploy) OR the controller bulk-revokes via `Accounts.revoke_sessions_for_user/1` (new helper, mirrors `revoke_sessions_for_visitor/1`). **Cheaper path: add the helper, avoid the migration.** Action: bucket 2 implementer reads the migration before scoping.

### R-2. SQLite `FOR UPDATE` semantics for last-admin race
SQLite doesn't support `FOR UPDATE` (no row-locking). The transaction wrap relies on SQLite's single-writer model. **Risk**: under future Postgres migration, the guard becomes racy. Mitigation: add a comment in `Accounts.update_admin_flags/2` documenting the dependency; if future Postgres lands, lift to advisory lock.

### R-3. Server delete with active session — UX clarity
The wire field `affected_session_count` tells the operator "you affected N live sessions" but doesn't auto-reconnect. **Open question for vjt**: should the controller offer a `?reconnect_affected=true` query param to trigger Session.Server restart against the updated server list? Default no (keeps single-purpose verb); follow-up cluster if operator demand surfaces.

### R-4. Credential PUT with password change — kill-respawn timing
`SpawnOrchestrator.spawn/4` is async (TCP connect lands in `handle_continue`). The PUT response returns BEFORE the new session is fully connected. Wire field `session_action: :restarted` is honest about "we started one," not "it's running." Cic-side: the next `Topic.user` event delivers the new `connection_state` when the session lands. **Acceptable**: same model as `POST /networks/:slug/connect` today.

### R-5. nginx allowlist regex
The current regex `^/admin/(visitors|sessions|credentials|networks|reaper|circuit|users|me|settings|uploads|test)(/|$)` (verify exact at bucket 1) would route:
- new `/admin/users` create/delete: covered (`users` already in list).
- new `/admin/networks/:id/servers` and `/admin/networks/:network_id/servers/:id`: NEEDS new alt — add `servers` to the regex. **Bucket 1 implementer MUST add it** else the route 404s at the proxy. Single-file edit per `infra/snippets/locations-api.conf`.
- new `/admin/credentials` create/delete: covered.

### R-6. Operator self-service via this surface
Admin can change their OWN password via `PUT /admin/users/:id/password` where `:id == self`. **Decision**: allow it. Self-rotation is a normal operator verb; no need to gate. Auth sessions stay valid (token = session UUID; not derived from password). Documented in the endpoint moduledoc.

### R-7. Bucket ordering — can buckets 1+2 run in parallel?
Yes, technically (different contexts). But the FallbackController edits collide (`{:credentials_present, N}` and `:already_exists` from bucket 1; `:last_admin` from bucket 2). Mitigation: sequential merge, parallel implementation. Reviewer-loop runs per bucket regardless.

---

**End of plan.**
