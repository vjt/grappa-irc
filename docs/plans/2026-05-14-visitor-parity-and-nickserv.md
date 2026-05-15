# Visitor parity + NickServ-as-identity (cluster)

**Status**: **CLOSED 2026-05-15** — all production buckets landed on
`origin/main`. Cluster CLOSE checkpoint at
`docs/checkpoints/2026-05-15-cp32.md`.

| Bucket | Status | Commit |
|--------|--------|--------|
| V1 — XOR FK migrations + `Grappa.Subject` helper | LANDED 2026-05-15 | `f51618a` (+ `61491fb` follow-up) |
| V2 — query_windows visitor lift | LANDED 2026-05-15 | `d69a42d` |
| F1 — typed window-state events to user-topic (flake fix) | LANDED 2026-05-15 | `d6b5d2e` |
| V3 — push_subscriptions + Sender subject-shape lift | LANDED 2026-05-15 | `d773bed` |
| V4 — user_settings + watchlist + read_cursor visitor lift | LANDED 2026-05-15 | `46fc720` |
| V5 — Reaper cross-check + 5-table cascade test | LANDED 2026-05-15 | `6ef59a0` |
| V6 — cic visitor-branch sweep | LANDED 2026-05-15 | `bf9c552` |
| V7 — NickServ TTL semantics (anon 48h, identified ∞) | LANDED 2026-05-15 | `7f0f756` (+ `ec8a18f` Repo.checkout pin) |
| V8 — visitor → registered-user promote | **DROPPED** at brainstorm | n/a |
| V9 — visitor `/nick` rename — lift Q2(a) gate | LANDED 2026-05-15 | `2668fba` |

**Branch**: `cluster/visitor-parity-and-nickserv` (worktree removed
post-CLOSE).
**Position**: post-`push-notifications` (CP32 cluster). Spec
blessed by vjt 2026-05-14, refined 2026-05-15 (no V8 promote, no
double-password — NickServ IS the identity backbone for IRC-bound
accounts).
**Origin evidence**: vjt 2026-05-14 verbal spec — "visitors,
NickServ-authed visitors and registered users all get the EXACT
same feature surface; only session lifetime differs." Refined
2026-05-15: NickServ-identified visitors get **infinite** TTL
(NickServ +r mode IS the cryptographic identity proof), not 7
days; the only TTL-bearing tier is anonymous visitor (48h sliding,
data co-terminus with session).

## Goal

**Subject parity invariant.** Every server-side feature surface
that today branches on `{:user, _}` vs `{:visitor, _}` to refuse
the visitor branch must accept BOTH branches and dispatch through
a `Grappa.Subject.t()` helper. Any per-subject behaviour
difference that REMAINS post-cluster must be explicitly justified
in this doc (and in CLAUDE.md if it's a recurring pattern).

**Two-tier subject model.**

| Subject                          | Auth proof                                            | Data lifetime |
|----------------------------------|-------------------------------------------------------|---------------|
| Anonymous visitor                | none (visitor row + bearer)                            | 48h sliding TTL — Reaper sweep + FK CASCADE wipes everything |
| NickServ-identified visitor      | NickServ password (Cloak-encrypted in `visitor.password_encrypted`, verified vs upstream `+r` MODE observation) | **infinite** — `expires_at = NULL` |
| Registered user (admin/operator) | local Argon2 password (`users.password_hash`)         | infinite (operator-only path via `mix grappa.create_user`) |

The "registered user" tier exists ORTHOGONALLY to the visitor
flow — it's the admin/operator account path for accounts that
don't need an IRC nick (the bouncer admin, future read-only
dashboard accounts, etc.). It is NOT something a visitor
"promotes into" — NickServ identification IS the IRC user's
identity proof; once identified, their visitor row IS the
permanent account.

This explicitly DROPS the prior plan's V8 ("promote visitor →
registered user with reparenting transaction"): no value-add
over identified-visitor with infinite TTL; eliminates the
double-password UX problem.

## Architecture decisions

### A1. XOR FK pattern across the four subject-scoped tables

Today three tables (`query_windows`, `push_subscriptions`,
`user_settings`) are user-only by `user_id NOT NULL`. The
`read_cursors` table (CP29 cluster) already uses the XOR FK
pattern correctly — it's the proven template. Apply the same to
the other three:

- `user_id` becomes nullable.
- Add `visitor_id TEXT REFERENCES visitors(id) ON DELETE CASCADE`.
- Add CHECK constraint `subject_xor_<table>` enforcing
  `(user_id IS NULL) <> (visitor_id IS NULL)`.
- Replace existing `unique_index([:user_id, ...])` with two
  partial unique indexes (one per subject branch, mirroring
  `read_cursors_user_network_channel_index` /
  `read_cursors_visitor_network_channel_index`).
- Rebuild FK-lookup plain indexes per subject.

Note: a NickServ-identified visitor STAYS a `visitor_id` row
forever (no schema migration to `users`). The `visitors` table
gains a single permanent identity meaning when
`password_encrypted IS NOT NULL` AND `expires_at IS NULL`. That
shape is the new "permanent visitor" — co-equal with `users`
in capability, distinct only in auth substrate.

### A2. `Grappa.Subject` context-boundary helper module

`GrappaWeb.Subject` (already exists at `lib/grappa_web/subject.ex`)
covers the web-layer rich-struct shape. NEW non-web helper
`Grappa.Subject` exposes:

```elixir
defmodule Grappa.Subject do
  @type t :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

  @spec put_subject_id(map(), t()) :: map()
  # Promote from Grappa.Session.put_subject_id/2 — minimize churn
  # by re-exporting; new contexts call Grappa.Subject directly.

  @spec subject_where(Ecto.Query.t(), t(), atom()) :: Ecto.Query.t()
  # Mirror Grappa.Scrollback.subject_where/2 — single source for
  # WHERE user_id = ? AND visitor_id IS NULL clauses.

  @spec from_assigns(Plug.Conn.assigns()) :: t() | nil
end
```

Invariant: every persistence-write codepath builds its changeset
via `Grappa.Subject.put_subject_id/2` — never inlines
`%{user_id: ...}` or `%{visitor_id: ...}` literally.

### A3. Reaper cascade behaviour stays (verify)

`Grappa.Visitors.Reaper` already calls `Visitors.delete/1` per
expired row. After this cluster the CASCADE list extends to
`query_windows`, `push_subscriptions`, `user_settings`,
`read_cursors` (already present). Reaper code itself doesn't
change — DB does the work. NickServ-identified visitors with
`expires_at = NULL` are skipped by Reaper's `WHERE expires_at <
now() AND expires_at IS NOT NULL` guard (verify exact shape).

Verification: a TDD test that creates an anon visitor + all four
owned rows, expires it, reaps, asserts all four tables have zero
rows. Plus a test that creates an identified visitor + same four
owned rows + a far-past `expires_at` (simulated), reaps, asserts
the identified visitor is NOT swept (gate by `expires_at IS NOT
NULL`).

### A4. Identified-visitor TTL = infinite

Today `lib/grappa/visitors.ex:151-162` has `maybe_bump/1`
branching on `password_encrypted` to pick `@anon_ttl_seconds`
(48h) vs `@registered_ttl_seconds` (7d). Refactor:

- Anon (`password_encrypted IS NULL`): `expires_at = now + 48h`
  on every touch (existing behavior).
- Identified (`password_encrypted IS NOT NULL`): `expires_at =
  NULL` (NEW — sets the column to NULL on identification, leaves
  it NULL on subsequent touches).

The `password_encrypted` column transitions from NULL → blob via
`Visitors.commit_password/2` (called from
`Session.Server.apply_effects([{:visitor_r_observed, password} | _], _)`).
At THAT transition, also write `expires_at = NULL`. Subsequent
`Visitors.touch/1` calls become no-ops for identified visitors
(no reason to bump a NULL timestamp).

Drop the constant `@registered_ttl_seconds` entirely (the 7-day
value goes away — no intermediate tier exists). Anon stays at 48h
as `@anon_ttl_seconds`.

### A5. Returning identified visitor — re-auth flow

When an identified visitor reconnects from a new device:

1. `POST /auth/login` with `identifier=<nick>` AND `password=<NickServ>`.
2. Server checks `visitors WHERE nick=? AND network_slug=?` — if
   present AND `password_encrypted IS NOT NULL`, Cloak-decrypt
   compare against supplied password.
3. On match: REUSE the existing visitor row (no new `id`), bind
   a fresh `accounts_sessions` row to it, return bearer.
4. On mismatch: `:invalid_credentials` (same as user wrong-
   password — uniform error surface, no enumeration).
5. On absent visitor row: visitor row is created (anon path; if
   they later identify via NickServ, they auto-promote to
   identified per existing flow). Same as today's first-contact
   visitor flow.

This is a small extension to `Grappa.Visitors.Login.login/2`
which today handles only the anon-create branch + the
already-existing-visitor reuse with NO password gate. The
password-gate branch is what's new.

### A6. Documentation sweep — "visitor is second-class" wording removal

Multiple moduledocs encode the now-obsolete "visitors are
ephemeral and don't persist X" rationale. Sweep:

- `lib/grappa/visitors.ex` — moduledoc + per-fn docs for
  `purge_if_anon/1` (W11): the W11 anon-purge IS still right
  for ANON visitors (their data is co-terminus with session).
  Identified-visitor branch (no-op) already does the right
  thing. Just clarify wording: "anon-only co-terminus delete"
  not "visitors second-class."
- `lib/grappa/query_windows.ex` § "Visitor sessions" — DELETE
  the spec-line-46 caveat; visitors get persistence now.
- `lib/grappa/push.ex` + `lib/grappa/push/subscription.ex` +
  `lib/grappa_web/controllers/push_subscription_controller.ex` —
  remove "User-only" wording; add "subject-scoped".
- `lib/grappa/user_settings.ex` + schema +
  `user_settings_controller.ex` — same.
- `lib/grappa/push/triggers.ex` § "Visitor sessions are skipped"
  — DELETE.
- `lib/grappa/session/server.ex:1995-2031` —
  `maybe_dispatch_push/2` rationale + visitor short-circuit
  (V3).
- `lib/grappa_web/controllers/read_cursor_controller.ex` HIGH-20
  ("visitors are single-device") — LIFTED per Q5 confirmed.
  Visitors get the cross-device broadcast like users; remove
  the visitor short-circuit.
- `lib/grappa_web/controllers/nick_controller.ex` — LIFTED per
  Q2 confirmed. NICK rename allowed for visitors with proper
  uniqueness handling (V9).

### A7. Hot-vs-cold deploy classification

- V1 schema migrations → **COLD** (per
  `feedback_cluster_with_migration_must_cold`).
- V2-V4, V6 (cic), V9 → **HOT** + cic-bundle.
- V5 Reaper cross-check → no code change → no deploy.
- V7 TTL-rename + identified-visitor `expires_at = NULL` + login
  password-gate → **HOT** (logic-only; Visitors module is not in
  `LongLivedModules.@modules`).

## Migration shape — exact ALTER statements

Mirror the table-recreate dance from
`priv/repo/migrations/20260502085339_add_visitor_id_to_messages.exs`
(rename → CREATE → INSERT SELECT → DROP). `ecto_sqlite3` rejects
`modify` and `create constraint` on existing tables.

Existing rows survive because they all carry `user_id NOT NULL`
today; INSERT-SELECT preserves them with `visitor_id = NULL`,
satisfying the new XOR CHECK.

### V1.a query_windows

```sql
ALTER TABLE query_windows RENAME TO query_windows_old;

CREATE TABLE query_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NULL CONSTRAINT query_windows_user_id_fkey REFERENCES users(id) ON DELETE CASCADE,
  visitor_id TEXT NULL CONSTRAINT query_windows_visitor_id_fkey REFERENCES visitors(id) ON DELETE CASCADE,
  network_id INTEGER NOT NULL CONSTRAINT query_windows_network_id_fkey REFERENCES networks(id) ON DELETE CASCADE,
  target_nick TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  inserted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT query_windows_subject_xor CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
);

INSERT INTO query_windows (id, user_id, visitor_id, network_id, target_nick, opened_at, inserted_at, updated_at)
SELECT id, user_id, NULL, network_id, target_nick, opened_at, inserted_at, updated_at
FROM query_windows_old;

DROP TABLE query_windows_old;

CREATE UNIQUE INDEX query_windows_user_network_nick_lower_index
  ON query_windows (user_id, network_id, lower(target_nick))
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX query_windows_visitor_network_nick_lower_index
  ON query_windows (visitor_id, network_id, lower(target_nick))
  WHERE visitor_id IS NOT NULL;

CREATE INDEX query_windows_user_id_index ON query_windows (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX query_windows_visitor_id_index ON query_windows (visitor_id) WHERE visitor_id IS NOT NULL;
CREATE INDEX query_windows_network_id_index ON query_windows (network_id);
```

Schema: add `belongs_to :visitor`, add `validate_subject_xor/1`
mirror, attach `check_constraint(:subject, name:
:query_windows_subject_xor)` + both `unique_constraint`.

Context: every public fn shifts from `user_id` arg to `subject ::
Grappa.Subject.t()`. Internal queries use
`Subject.subject_where/3`.

### V1.b push_subscriptions

```sql
ALTER TABLE push_subscriptions RENAME TO push_subscriptions_old;

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NULL CONSTRAINT push_subscriptions_user_id_fkey REFERENCES users(id) ON DELETE CASCADE,
  visitor_id TEXT NULL CONSTRAINT push_subscriptions_visitor_id_fkey REFERENCES visitors(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT NULL,
  last_used_at TEXT NULL,
  inserted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT push_subscriptions_subject_xor CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
);

INSERT INTO push_subscriptions
  (id, user_id, visitor_id, endpoint, p256dh_key, auth_key, user_agent, last_used_at, inserted_at, updated_at)
SELECT id, user_id, NULL, endpoint, p256dh_key, auth_key, user_agent, last_used_at, inserted_at, updated_at
FROM push_subscriptions_old;

DROP TABLE push_subscriptions_old;

CREATE UNIQUE INDEX push_subscriptions_user_endpoint_index
  ON push_subscriptions (user_id, endpoint) WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX push_subscriptions_visitor_endpoint_index
  ON push_subscriptions (visitor_id, endpoint) WHERE visitor_id IS NOT NULL;
```

### V1.c user_settings

```sql
ALTER TABLE user_settings RENAME TO user_settings_old;

CREATE TABLE user_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NULL CONSTRAINT user_settings_user_id_fkey REFERENCES users(id) ON DELETE CASCADE,
  visitor_id TEXT NULL CONSTRAINT user_settings_visitor_id_fkey REFERENCES visitors(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  inserted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT user_settings_subject_xor CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
);

INSERT INTO user_settings (id, user_id, visitor_id, data, inserted_at, updated_at)
SELECT id, user_id, NULL, data, inserted_at, updated_at FROM user_settings_old;

DROP TABLE user_settings_old;

CREATE UNIQUE INDEX user_settings_user_id_index ON user_settings (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX user_settings_visitor_id_index ON user_settings (visitor_id) WHERE visitor_id IS NOT NULL;
```

### V1.d read_cursors verification

Already XOR-correct per CP29. V1 just adds a TDD test asserting
visitor-FK CASCADE wipes cursor rows on visitor delete (likely
already exists — verify in
`test/grappa/read_cursor_test.exs` or the cluster's bucket
tests). If absent, add it as part of V5.

## Buckets

### Bucket V1 — XOR FK migrations (schema + schemas + contexts)

**Failing test first:** `test/grappa/visitors/cascade_test.exs`
— create a visitor, insert a query_window + push_subscription +
user_settings + read_cursor for that visitor's id, call
`Grappa.Visitors.delete(visitor.id)`, assert all four tables
have zero rows for that visitor_id.

**Production change:**

1. Three migrations (V1.a/b/c) per § Migration shape.
2. Three schema modules — add `belongs_to :visitor`, add subject
   XOR validator, add CHECK constraint binding.
3. Three context modules' public APIs shift to subject-tuple
   shape. `Grappa.Subject` helper module created (or
   `Grappa.Session.put_subject_id/2` promoted).
4. Every CALLER updated to pass subject tuples.

**Exit criteria:** all migrations present, cascade test green,
existing tests refactored to subject-shape, Dialyzer green,
`scripts/check.sh` exit 0 + tail.

**Deploy:** **COLD** (three new migrations).

### Bucket V2 — query_windows visitor lift

**Failing test first:** extend `grappa_channel_test.exs`
`open_query_window` / `close_query_window` tests with a visitor
socket — assert success (today asserts `visitor_not_allowed`).

**Production change:**

1. Remove `check_not_visitor(user_name)` from the two `with`
   chains at `grappa_channel.ex:681,709`.
2. Replace `safe_get_user/1 → user.id` with
   `socket.assigns.subject` → pass to `QueryWindows.open/4`.
3. Update `archive_controller.ex:84` —
   `open_query_targets({:visitor, _}, _), do: []` becomes a real
   `Grappa.QueryWindows.list_for_subject/1` call.

**Exit:** visitor socket can open/close DM windows; broadcast
lands on visitor's `Topic.user("visitor:<uuid>")`. Cic visitor
sees query windows persist across reload. Per-bucket integration
test.

**Deploy:** **HOT** + cic-bundle.

### Bucket V3 — push_subscriptions + maybe_dispatch_push lift

**Failing test first:** visitor bearer POSTs `/push/subscriptions`,
assert 201 (today 403). Plus visitor session mention-receive
triggers `Push.Sender` (today no-op).

**Production change:**

1. Remove `require_user/1` from
   `push_subscription_controller.ex` (lines 90, 108, 121); use
   `Subject.from_assigns` → subject-shaped `Push.create/2`.
2. Remove `defp maybe_dispatch_push(_, %{subject: {:visitor, _}}), do: :ok`
   from `session/server.ex:2019`.
3. Update `Push.Triggers.evaluate_and_dispatch/2` — `ctx.user_id`
   → `ctx.subject`. Mentions / prefs lookup via
   `UserSettings.get_notification_prefs/1` now takes subject (V4).

**Exit:** visitor with PWA install + permission-granted registers
subscription via same UX as user. Visitor receives push when peer
mentions them. Sender's 410 Gone path still wipes dead endpoints.
Per-bucket integration: e2e Playwright spec.

**Deploy:** **HOT**.

### Bucket V4 — user_settings + read_cursor visitor lift

**Failing test first:** visitor bearer GETs/PUTs
`/me/settings/notification-prefs`, asserts 200 (today 403). Plus
channel `watchlist add/del/list` test with visitor socket. Plus
visitor POST `/networks/:slug/channels/:ch/read-cursor` triggers
cross-device broadcast on `Topic.user("visitor:<uuid>")`.

**Production change:**

1. Remove `require_user/1` from
   `user_settings_controller.ex:54,73`.
2. Remove `visitor?(user_name)` short-circuits from
   `grappa_channel.ex:735-781` (three watchlist arms); resolve
   subject from socket; call
   `UserSettings.{get,set}_highlight_patterns/{1,2}`.
3. Remove `read_cursor_controller.ex` HIGH-20 visitor short-
   circuit; broadcast `:cross_device_cursor_set` on
   `Topic.user(subject_label)` for visitor too.

**Exit:** visitor can set notification_prefs (V3 trigger reads
in subject-shape). Visitor can `/watch add #foo`; mentions-while-
away aggregation fires. Visitor cursor sync works across devices
(e.g. iPhone + laptop with same identified visitor session).
Per-bucket Playwright spec.

**Deploy:** **HOT** + cic-bundle.

### Bucket V5 — Reaper cross-check + cleanup test sweep

**Failing test first:** V1 cascade test covers
`Visitors.delete/1`. V5 adds:

- `Reaper.sweep/0` end-to-end: stage anon visitor with
  `expires_at < now()` plus all four owned rows, schedule tick,
  assert `Visitors.list_active/0` no longer contains visitor AND
  all four owned tables zero.
- Reaper skip: stage identified visitor with `expires_at = NULL`,
  schedule tick, assert visitor + owned rows untouched.
- Property test (StreamData): for any sequence of (visitor
  create, identify, open windows, register pushes, set settings,
  set cursors, expire, reap) operations, post-reap row counts
  for that visitor_id are zero IFF visitor was anon AND expired,
  AND no other subject's rows are affected.

**Production change:** Verify `Reaper.sweep/0`'s `WHERE
expires_at < now()` query also has `expires_at IS NOT NULL`. If
not, add it (correctness fix — without it, identified visitors
with NULL `expires_at` would be swept on first tick post-V7).

**Exit:** Reaper end-to-end + skip + property tests green.
Reaper moduledoc lists expanded CASCADE target set explicitly.

**Deploy:** **HOT** if Reaper SQL guard added; else none.

### Bucket V6 — cic visitor-branch sweep

**Failing test first:** vitest at
`cicchetto/src/__tests__/SettingsDrawer.test.tsx` — render
SettingsDrawer with visitor `me` shape, assert push toggle +
notification-prefs + watchlist UI all visible.

**Production change:**

Per `grep -rn 'me\.kind === "visitor"\|kind: "visitor"' cicchetto/src/`:

1. `lib/api.ts:160,275` — `ownNickForNetwork` / `tagNetwork` are
   CORRECT (visitor-network shape difference is structural).
   Stays.
2. `lib/auth.ts:128,138` — `socketUserName` returns
   `"visitor:<uuid>"` (CORRECT). Stays.
3. `lib/push.ts:88-90` — `postPushSubscription` moduledoc says
   "visitors get 403, but the master toggle is hidden in cic for
   visitor sessions" — REMOVE second sentence; remove any
   hide-toggle branch elsewhere.
4. `SettingsDrawer.tsx` — confirm no visitor branch gates push
   toggle / prefs section / watchlist.
5. `Login.tsx:211` — "Password (optional for visitors)" stays
   AND becomes the NickServ-identified-visitor login path per
   A5: visitor password input → server tries to verify against
   existing identified-visitor row → fall back to anon-create
   if no match.
6. Sidebar / ComposeBox / socket / clientId / userTopic /
   subscribe / networks visitor refs — already subject-agnostic.
7. `lib/queryWindows.ts` — verify no client-side "visitor: don't
   send" gate (V2 lifts server gate; client must lift in
   lockstep).
8. `lib/readCursor.ts` (or wherever cursor-set is dispatched) —
   verify visitor doesn't have a client-side skip; V4 enables
   server broadcast, cic must apply incoming `read_cursor_set`
   events for visitors too.

**Exit:** visitor signs in → Settings drawer shows full feature
surface. E2e Playwright: visitor opens query window, reloads,
window still there. E2e: visitor enables push, mention from peer
→ notification arrives. E2e: visitor sets read cursor on iPhone,
desktop browser sees cursor sync. vitest exhaustiveness pin per
`feedback_wire_edge_runtime_allowlist_exhaustiveness` for any
new TS discriminated union arms.

**Deploy:** cic-bundle deploy via `scripts/deploy-cic.sh`.

### Bucket V7 — TTL semantics: anon (48h) + identified (∞)

**Failing test first:** `test/grappa/visitors_test.exs`:

- `describe "touch/1 anon TTL"` — anon visitor, touch, assert
  `expires_at = now + 48h` (existing behavior, just rename
  describe block).
- `describe "touch/1 identified TTL"` — identified visitor
  (`password_encrypted` set), touch, assert
  `expires_at IS NULL` (NEW — today asserts `now + 7d`).
- `describe "commit_password/2 sets expires_at = NULL"` — call
  `commit_password`, assert `password_encrypted` set AND
  `expires_at` updated to NULL in same transaction.
- `describe "Login.login/2 with password"` — submit nick +
  NickServ password, server matches against
  `password_encrypted`, returns bearer bound to existing visitor
  row (no new row).

**Production change:**

1. Drop `@registered_ttl_seconds` constant from `visitors.ex`.
   `maybe_bump/1` simplifies to: anon → bump 48h, identified →
   no-op (return changeset with `expires_at` unchanged).
2. `commit_password/2` (in `Visitors`) — extend changeset to
   write `expires_at: nil` alongside `password_encrypted`.
3. `Visitors.Login.login/2` — extend the existing visitor-row
   reuse branch with a password-gate sub-branch:
   - If supplied password is non-nil AND visitor row has
     `password_encrypted IS NOT NULL`: Cloak-decrypt compare,
     match-or-`:invalid_credentials`.
   - If supplied password is nil AND visitor row has
     `password_encrypted IS NOT NULL`: reject with
     `:password_required` (can't claim an identified visitor's
     row without proving identity).
   - If supplied password is non-nil AND visitor row has
     `password_encrypted IS NULL`: reject with
     `:password_mismatch` (the existing visitor isn't password-
     protected; supplying one is a misconfiguration).
   - Existing branches (anon-create, anon-row-reuse) untouched.
4. `Visitors.Reaper` — add `WHERE expires_at IS NOT NULL` to the
   sweep query (per V5 verification — fold into V7 if not
   already present).
5. Moduledoc sweep: `visitors.ex` + `visitor.ex` lifecycle wording
   from "registered visitor" → "NickServ-identified visitor."

**Exit:** identified visitors don't expire. Reaper skips them.
Re-login with NickServ password from new device reuses existing
visitor row + bearer + persisted data (query windows / push subs
/ settings / cursors).

**Deploy:** **HOT** (Visitors module not in
`LongLivedModules.@modules`).

### Bucket V8 — DROPPED (was: visitor → registered-user promote)

Removed per 2026-05-15 spec refinement: NickServ-identified
visitor with infinite TTL IS the permanent identity. The
"registered user" tier (`Grappa.Accounts.User` via
`mix grappa.create_user`) stays as the orthogonal admin-account
path, not a visitor's promotion target. Single-secret UX (one
password — NickServ's), zero data-migration code, zero
double-account-state classes.

The bucket numbering keeps V8 reserved for the optional future
"admin can create non-IRC user accounts" enhancement; today
this is already the `mix grappa.create_user` path, so nothing
new to ship.

### Bucket V9 — visitor NICK rename (lift the gate)

**Failing test first:** `test/grappa_web/controllers/nick_controller_test.exs`
— visitor bearer PUTs `/me/nick { "nick": "<new>" }`:

- Assert 200 + visitor row's `nick` updated in DB.
- Assert upstream IRC NICK frame sent (via `Session.Server`).
- Negative: nick collision with another live visitor on same
  network → 409 `nick_in_use`.
- Negative: malformed nick (per `IRC.Identifier`) → 400
  `malformed_nick`.
- Negative: upstream rejects with 433 (e.g. nick is registered
  by another NickServ account) → server keeps OLD visitor row
  nick, rolls back DB write, returns 422 with reason from the
  numeric.

**Production change:**

1. Remove the visitor short-circuit at `nick_controller.ex:61`
   (current detailed rationale moves into V9's commit body
   explaining WHY it's now safe to lift).
2. The `(nick, network_slug)` UNIQUE INDEX on `visitors` stays —
   it's the right invariant. The race shape:
   - Local DB UPDATE first (optimistic), guarded by the
     UNIQUE index → 409 if collides.
   - Upstream NICK send second.
   - On upstream 432/433/etc. numeric: roll back the DB nick
     (UPDATE back to old) + return 422 to the operator.
3. The `Subject.from_assigns` plumbing already in V1 supplies
   the visitor struct so the controller knows which row to
   update.
4. Cic side: `/nick <new>` already wired in compose for users;
   visitor branch needs no special-case (V6 sweep ensures the
   compose `/nick` path doesn't gate on subject kind).

**Exit:** visitor `/nick foo` works end-to-end; DB consistency
preserved across upstream success / failure.

**Deploy:** **HOT**.

## Cluster CLOSE checklist

After V1-V7 + V9 green:

1. `cd /Users/mbarnaba/code/grappa/.worktrees/visitor-parity-and-nickserv && git fetch origin main && git rebase origin/main`
2. Re-run gates: `scripts/check.sh` + `scripts/bun.sh run check` +
   `scripts/bun.sh run test` + `scripts/integration.sh`.
3. Standalone Dialyzer per
   `feedback_dialyzer_plt_staleness`: `scripts/dialyzer.sh`.
4. Brief vjt with cluster summary (commit shas, what shipped per
   bucket, deviations).
5. Merge: `cd /Users/mbarnaba/code/grappa && git checkout main &&
   git merge --ff-only cluster/visitor-parity-and-nickserv`.
6. **COLD deploy**: `scripts/deploy.sh` (auto-cold from V1
   migrations). Operator runs `scripts/mix.sh ecto.migrate`
   between merge and deploy if not auto-applied.
7. Healthcheck: `scripts/healthcheck.sh`.
8. Browser smoke from anon visitor + identified visitor +
   registered-user session: open query window → reload → verify
   persistence; register push subscription → peer-mention →
   verify notification delivery; set notification_prefs → verify
   save; identified visitor `/nick rename` → verify; identified
   visitor cursor sync between two browser tabs.
9. Push origin/main per `feedback_push_autonomy`.
10. Update `project_post_p4_1_arc` — mark cluster CLOSED, point at
    next.
11. Write CP3X at `docs/checkpoints/2026-05-XX-cp3X.md`.
12. DESIGN_NOTES entry — chronological log, parity invariant +
    W11-rationale-clarification + 2-tier identity decision +
    NICK rename safety analysis.
13. README update — two-tier subject model + identity proof per
    tier + parity statement.
14. Story episode at `docs/project-story.md`.
15. CLAUDE.md update — add parity invariant under "Engineering
    Standards" if recurring rule.
16. Save memory: `project_visitor_parity_closed`.
17. Worktree cleanup:
    `git worktree remove .worktrees/visitor-parity-and-nickserv`.

## Open questions for vjt — RESOLVED

All resolved 2026-05-15:

- **Q1** ✅ — channel ops verbs lifted universally (let upstream
  IRC's `482 ERR_CHANOPRIVSNEEDED` be authoritative).
- **Q2** ✅ — visitor NICK rename lifted (V9 handles
  uniqueness + upstream 433 correctly).
- **Q3** N/A — V8 dropped, no double-password situation.
- **Q4** ✅ — `Grappa.UserSettings` name stays, moduledoc
  updated.
- **Q5** ✅ — ReadCursor cross-device broadcast lifted for
  visitors (V4).
- **Q6** ✅ — V8 dropped from cluster (NickServ identification IS
  the permanent identity; no promote step needed).

## Memories that ARE relevant

- `project_push_notifications_closed` (when CP32 closes) — table
  this cluster reshapes
- `feedback_no_localized_strings_server_side` — wire-shape rule
- `feedback_per_bucket_deploy` — browser smoke at bucket close
- `feedback_landed_claim_evidence` — check.sh exit-0 tail in
  commit
- `feedback_cluster_with_migration_must_cold` — V1 forces cold
- `feedback_dialyzer_plt_staleness` — standalone dialyzer at
  multi-session cluster close
- `feedback_subagent_driven_development` — Plan + code-reviewer
  parallel-agent pattern
- `feedback_recurring_e2e_not_flake` — same triplet failing N
  runs in row = real regression
- `feedback_ux_e2e_mandatory` — every cic UX-touching change
  ships with Playwright e2e
- `feedback_push_autonomy` — push autonomy granted

## Cluster CLOSE retrospective (2026-05-15)

10 commits + 1 docs commit on the worktree branch, ff-merged to
`main`, all V-buckets shipped on the same day. V8 dropped at
brainstorm — NickServ identification IS the permanent identity
proof, no double-password promote needed; eliminated an entire
data-migration code path before it was written. F1 inserted as a
mid-cluster correction (typed window-state events were on per-channel
topics → flake class; lifted to user-topic).

The two-tier identity model lands as planned: anon visitor on a 48h
sliding TTL whose data is co-terminus with the session
(FK CASCADE wipes everything on Reaper sweep); NickServ-identified
visitor (`password_encrypted IS NOT NULL`) on **infinite** TTL with
`expires_at = NULL`; registered user as the orthogonal admin path
via `mix grappa.create_user`. Three subject classes, ONE feature
surface — every server-side branch on `{:user, _}` vs `{:visitor, _}`
that previously refused the visitor branch now dispatches via
`Grappa.Subject.t()`.

V9's NICK-rename safety analysis came in simpler than the
orchestrator's complex sync-wait + 422-on-433-numeric +
`pending_nick_rename` correlation field design. vjt vetoed the
complexity: user nick-rename has been fire-and-forget 202 since
day one; visitor=user per the parity invariant; UNIQUE constraint
+ pre-check (`Visitors.nick_in_use?/3`) covers >99% of races; cic
already listens to `own_nick_changed` broadcast (CP-15). The
432/433 silent-leave-DB-unchanged shape is a pre-existing UX hole
orthogonal to V9. Cleanly avoids a COLD-required defstruct field
+ ref correlation plumbing.

### HOT-vs-COLD preflight gap (V9 incident)

V9's deploy hit a real gap in `scripts/deploy.sh`. `Session.Server`
gained a new `visitor_nick_persister` field — the AST oracle at
`scripts/_extract_state_block.awk` would have caught it, BUT the
deploy operator had already done `git merge --ff-only` locally
before invoking `scripts/deploy.sh`. The deploy's `git pull --ff-only`
returned "Already up to date", so the preflight diff base
(`HEAD@{1}..HEAD`) was empty → the AST oracle saw nothing → false
HOT classification → `Phoenix.CodeReloader` fired against a
state-shape change.

Live container survived the hot reload (no immediate crash) but
`_build/prod` got corrupted per
`feedback_hot_deploy_corrupts_build_prod`; subsequent `--force-cold`
rebuild failed compile_env validation. Recovery:
`rm -rf _build/prod && scripts/deploy.sh --force-cold`. ~30s
downtime; visitors auto-respawned via Bootstrap.

Lesson captured in
`feedback_deploy_preflight_empty_diff_after_merge`. Until
`scripts/deploy.sh` learns to compare against the actual pre-pull
remote state (or persist a last-deployed-SHA marker), the operator
must check `lib/grappa/hot_reload/long_lived_modules.ex` +
migrations + `mix.lock` manually before `scripts/deploy.sh` post-
local-merge and pass `--force-cold` if any changed.

## Authoritative refs

- `docs/DESIGN_NOTES.md` — chronological decision log; CP29
  read-state cluster (XOR FK template), CP32 push-notifications
  cluster
- `CLAUDE.md` — engineering standards
- **Reference patterns to mirror**:
  - `lib/grappa/scrollback/message.ex` + `messages_subject_xor`
    migration — XOR FK + CHECK + partial-index template
  - `lib/grappa/read_cursor/cursor.ex` + CP29 migration — proven
    XOR application to a subject-scoped context
  - `lib/grappa_web/subject.ex` — web-layer subject helper
  - `lib/grappa/session.ex` `put_subject_id/2` — context-side
    subject → FK column mapping (promote to `Grappa.Subject`)
