// REST client for grappa-test, used from the Playwright runner.
//
// Two concerns:
//   1. Login → bearer token (POST /auth/login).
//   2. Polled assertion that grappa persisted a message
//      (GET /networks/:slug/channels/:chan_id/messages).
//
// User + network seeding does NOT live here — it's the
// `grappa-e2e-seeder` sidecar's job (cicchetto/e2e/compose.yaml).
// The sidecar shares the e2e_runtime sqlite volume with grappa-test
// and exits BEFORE grappa-test boots, so by the time the runner's
// globalSetup calls login(), the user already exists. Keeping seeding
// out of the runner image (a) lets the runner stay a pure
// REST/IRC client (no docker.sock, no docker CLI), (b) matches the
// operator's prod ritual byte-for-byte (a regression in the mix tasks
// surfaces in this stack first).

// The ONE import in this module, and it is type-only: `wireTypes.ts` is
// GENERATED from the server (`mix grappa.gen_wire_types`, drift-gated by #767),
// and it declares no imports of its own, so it cannot pull a fixture back in
// and cannot reach the solid-js dependency that keeps `e2e/` from importing
// the rest of `src/`. Nothing here depends on another fixture module: that is
// the property that keeps this file cycle-free, and a type erased at compile
// time does not touch it.
import type { NetworksAdminWireT } from "../../src/lib/wireTypes";

export const GRAPPA_BASE_URL = "http://grappa-test:4000";

export type LoginResult = {
  token: string;
  subject: { kind: "user"; id: string; name: string };
};

export type SeededUser = {
  name: string;
  password: string;
  identifier: string;
  token: string;
  // Wire-shape JSON of `LoginResult.subject` — written verbatim into
  // the `grappa-subject` localStorage key by cicchettoPage.loginAs() so
  // cicchetto's auth.ts sees a complete bootstrapped identity.
  subjectJson: string;
};

export async function login(identifier: string, password: string): Promise<LoginResult> {
  const response = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!response.ok) {
    throw new Error(`grappaApi.login: ${identifier} → ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as LoginResult;
}

// M-cluster M-8 — mint a fresh anon visitor for tests that need a
// throwaway visitor row to operate on (e.g. the admin Visitors tab
// delete-action spec). Same `POST /auth/login` endpoint as user
// login; the identifier shape is the visitor branch when it
// doesn't match an `email@host` shape — see
// `lib/grappa_web/controllers/auth_controller.ex` login/2 +
// visitor_login/4. captcha gate is disabled in the e2e harness
// (compose.yaml `GRAPPA_CAPTCHA_PROVIDER: disabled`) so no
// captcha_token is required.
//
// Returns the visitor's `id` (matches the AdminWire row id used
// by the Visitors tab's per-row testid).
export type MintedVisitor = {
  id: string;
  nick: string;
  network_slug: string;
  token: string;
  // #363 — the full login-response subject (carries `incognito`), so a spec
  // can boot cic with the exact persisted shape rather than hand-building it.
  subject: { kind: "visitor"; id: string; registered?: boolean; incognito?: boolean };
};

// #363 — `incognito` mints an ephemeral session (short linger TTL, deleted on
// browser close). Default false = an ordinary 48h anon visitor.
export async function mintVisitor(nick: string, incognito = false): Promise<MintedVisitor> {
  const loginBody: { identifier: string; incognito?: boolean } = { identifier: nick };
  if (incognito) loginBody.incognito = true;
  const response = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(loginBody),
  });
  if (!response.ok) {
    throw new Error(`grappaApi.mintVisitor: ${nick} → ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as {
    token: string;
    subject: { kind: "visitor"; id: string; registered?: boolean; incognito?: boolean };
  };
  if (body.subject.kind !== "visitor") {
    throw new Error(`grappaApi.mintVisitor: expected visitor subject, got ${body.subject.kind}`);
  }
  // #211 phase 7 — the visitor SUBJECT wire carries only `{id, registered}`
  // now (nick went in phase 7; network_slug in phase 6): a visitor is
  // multi-network, so per-network identity (nick) lives on the list-shaped
  // GET /networks rows. Resolve the anchor network (the one login
  // synchronously connected) for BOTH the slug specs drive channel
  // selection with AND the per-network nick.
  const netsRes = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${body.token}` },
  });
  if (!netsRes.ok) {
    throw new Error(
      `grappaApi.mintVisitor: GET /networks → ${netsRes.status} ${await netsRes.text()}`,
    );
  }
  const nets = (await netsRes.json()) as Array<{ slug: string; nick: string }>;
  const anchor = nets[0];
  if (!anchor) {
    throw new Error(`grappaApi.mintVisitor: ${nick} has no attached network after login`);
  }
  return {
    id: body.subject.id,
    nick: anchor.nick,
    network_slug: anchor.slug,
    token: body.token,
    subject: body.subject,
  };
}

// #581 — visitor login WITH a password (vs `mintVisitor`, which is anon —
// no password). `POST /auth/login {identifier, password, network}` is the
// visitor branch (identifier is a bare nick, not `email@host`); a password
// on a fresh (never-committed) nick threads through
// `Visitors.SessionPlan.with_login_identify/2` → the plan identifies to
// services at 001, and on the resulting `+r` `commit_identity` persists a
// `:nickserv_identify` credential — the RECOVERABLE state the /recover feature
// (and its home button) needs. `network` is explicit (the testnet has several
// visitor_enabled networks → an implicit login is `:network_ambiguous`).
//
// Returns `subjectJson` too, so a spec can boot cic with the exact persisted
// visitor subject via `loginAs(page, {...} as SeededUser)` (loginAs reads only
// `.token` + `.subjectJson`).
export type VisitorLoginResult = {
  id: string;
  nick: string;
  network_slug: string;
  token: string;
  subject: { kind: "visitor"; id: string; registered?: boolean; incognito?: boolean };
  subjectJson: string;
};

export async function loginVisitor(
  nick: string,
  password: string,
  networkSlug: string,
): Promise<VisitorLoginResult> {
  const response = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: nick, password, network: networkSlug }),
  });
  if (!response.ok) {
    throw new Error(
      `grappaApi.loginVisitor: ${nick} → ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    token: string;
    subject: { kind: "visitor"; id: string; registered?: boolean; incognito?: boolean };
  };
  if (body.subject.kind !== "visitor") {
    throw new Error(`grappaApi.loginVisitor: expected visitor subject, got ${body.subject.kind}`);
  }
  return {
    id: body.subject.id,
    nick,
    network_slug: networkSlug,
    token: body.token,
    subject: body.subject,
    subjectJson: JSON.stringify(body.subject),
  };
}

// #299 amendment (author model A) — thin theme REST helpers for the
// author-nick e2e. The runner talks to grappa directly on port 4000
// (bypassing nginx), so these mirror the cic `themesApi` verbs without the
// browser. Only the fields the spec asserts on are typed.
export type ThemeWire = {
  id: number;
  author: string;
  built_in: boolean;
  // The sanitized token map (`Grappa.Themes.TokenModel`). Left as an open
  // record: specs that need a palette COPY one off a built-in rather than
  // spell 27 colour keys, so nothing here is read field-by-field except
  // `background`, which #1051 rewrites.
  payload: Record<string, unknown>;
};

export async function listGalleryThemes(token: string): Promise<ThemeWire[]> {
  const res = await fetch(`${GRAPPA_BASE_URL}/themes`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`grappaApi.listGalleryThemes: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { themes: ThemeWire[] };
  return body.themes;
}

export async function copyTheme(token: string, id: number): Promise<ThemeWire> {
  const res = await fetch(`${GRAPPA_BASE_URL}/themes/${id}/copy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`grappaApi.copyTheme: ${id} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ThemeWire;
}

export async function publishTheme(token: string, id: number): Promise<ThemeWire> {
  const res = await fetch(`${GRAPPA_BASE_URL}/themes/${id}/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`grappaApi.publishTheme: ${id} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ThemeWire;
}

// #1051 — give the running subject a theme that carries a WALLPAPER, and make
// it active, before the browser boots. The wallpaper is what engages
// `:root.theme-has-bg`, and that class is the variable the whole #1051
// stacking-context defect turns on: a spec that never sets it measures the
// half of the userbase that never had the bug.
//
// A `builtin` background (#294) rather than an upload: it resolves to a static
// /backgrounds/<key>.webp the stack already serves, so the spec proves the
// layer against a REAL image with no upload round-trip and no image bytes in
// the repo. The palette is COPIED off a built-in theme's payload — 27 colour
// keys spelled by hand in a fixture would be a second source of truth for the
// token vocabulary, and would rot the day the model gains a key.
//
// Both verbs are subject-scoped writes on a subject `fixtures/test.ts`
// provisions and destroys per test (#1078), so this spends no shared budget:
// the theme-create daily quota is per-(bucket, subject, day) and the subject
// is seconds old.
export type BuiltinBackground = { key: string; name: string; variant: string; path: string };

export async function listBuiltinBackgrounds(token: string): Promise<BuiltinBackground[]> {
  const res = await fetch(`${GRAPPA_BASE_URL}/themes/backgrounds`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`grappaApi.listBuiltinBackgrounds: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { backgrounds: BuiltinBackground[] };
  return body.backgrounds;
}

// `builtinKey: null` is not a degenerate call — it is the CONTROL arm. Both
// arms copy the SAME built-in palette, so a pair of themes differing only in
// `background.builtin` isolates the wallpaper as the single variable between
// two renders. Without that, a "with vs without wallpaper" comparison also
// swaps 27 colours and proves nothing about the layer.
export async function createThemeWithBuiltinBackground(
  token: string,
  name: string,
  builtinKey: string | null,
  opacity: number,
): Promise<ThemeWire> {
  const base = (await listGalleryThemes(token)).find((theme) => theme.built_in);
  if (!base) {
    throw new Error("grappaApi.createThemeWithBuiltinBackground: no built-in theme to copy");
  }

  const payload = {
    ...base.payload,
    background: { image_id: null, builtin: builtinKey, size: "cover", opacity },
  };
  const res = await fetch(`${GRAPPA_BASE_URL}/themes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, payload }),
  });
  if (!res.ok) {
    throw new Error(
      `grappaApi.createThemeWithBuiltinBackground: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as ThemeWire;
}

// The #358 pair, both slots explicit. `dark: null` is the single pick (the
// light theme paints in both modes); a distinct dark id makes the OS
// colour-scheme media query a LIVE toggle between two payloads, with no reload
// and no navigation — the only way to change one visual variable in a running
// page without also changing everything a reload changes.
export async function setActiveTheme(
  token: string,
  light: number,
  dark: number | null,
): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/me/theme`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ light, dark }),
  });
  if (!res.ok) {
    throw new Error(
      `grappaApi.setActiveTheme: ${light}/${dark} → ${res.status} ${await res.text()}`,
    );
  }
}

// Admin deletes any theme (owner|admin authz) — teardown for the re-homed
// system-owned gallery row the author-nick spec leaves behind. Idempotent:
// 404 (already gone) is success.
export async function adminDeleteTheme(adminToken: string, id: number): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/themes/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`grappaApi.adminDeleteTheme: ${id} → ${res.status} ${await res.text()}`);
  }
}

// #1397 — a non-ok STATUS from `getMessagesPage`, as a type, so a caller can
// tell it apart from a transport death. Only `assertMessagePersisted` needs
// the distinction: a 4xx/5xx there means "the row has not landed yet" and is
// worth another poll, while a thrown fetch means the stack is gone and
// retrying would mask the fault instead of measuring it. Everyone else lets
// both propagate and never looks at this class.
class MessagesPageStatusError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`grappaApi.getMessagesPage: GET → ${status} ${body}`);
    this.name = "MessagesPageStatusError";
    this.status = status;
  }
}

// #1397 — the ONE `GET /networks/:slug/channels/:channel/messages` in the
// e2e suite. Thirteen sites spoke this request verbatim (ten spec-local
// `fetchScrollbackPage` copies plus three here); they differed only in
// cosmetics and in the width of the `as` cast they applied afterwards.
//
// `before` is an explicit parameter with no default: the pager and the
// single-page callers differ in exactly that argument, and defaulting it
// would hide which of the two a call site is asking for. The server
// answers DESC (newest first) and `?before=<id>` walks older pages.
async function getMessagesPage(
  token: string,
  networkSlug: string,
  channel: string,
  before: number | undefined,
): Promise<WireMessage[]> {
  const base = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(
    networkSlug,
  )}/channels/${encodeURIComponent(channel)}/messages`;
  const url = before === undefined ? base : `${base}?before=${before}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new MessagesPageStatusError(res.status, await res.text());
  }
  return (await res.json()) as WireMessage[];
}

// #1397 — the newest page of scrollback for `(networkSlug, channel)`, in
// the order the server serves it: DESC by `server_time` per
// `Grappa.Web.MessagesController.index/2`, so `rows[0]` is the newest row
// and `rows[25]` is the 26th-newest. Specs index the page to pick a known
// id — the head id, or a mid-page one that plants an unread divider.
//
// Deliberately NARROW: every caller reads `.length` and `.id` and nothing
// else. The wire carries six more fields, but a return type is a promise,
// and promising fields nobody collects is a promise kept for free — see
// `getMessagesPage` when a caller genuinely needs the full row.
export async function fetchScrollbackPage(
  token: string,
  networkSlug: string,
  channel: string,
): Promise<Array<{ id: number }>> {
  return getMessagesPage(token, networkSlug, channel, undefined);
}

// BUGHUNT-3 cascade fix (2026-05-25) — restore the seeded vjt's read
// cursor on `(networkSlug, channel)` to the current tail row. Used in
// `afterAll` hooks of specs that intentionally advance the cursor to
// a mid-list row as part of their assertions (cp14-b1-scroll-marker,
// the BUGHUNT-2 cursor-* sentinels). Without restore, downstream
// specs that focus the channel inherit a mid-list cursor → in-pane
// unread-marker injects → `scrollIntoView(marker)` lands mid-pane
// instead of at the bottom → cascade. Forward-only `ReadCursor.set/4`
// accepts the tail id as last-write-wins; `restoreReadCursorToTail`
// is idempotent across repeats. No-op if the channel has no rows.
export async function restoreReadCursorToTail(
  token: string,
  networkSlug: string,
  channel: string,
): Promise<void> {
  const rows = await getMessagesPage(token, networkSlug, channel, undefined);
  const tail = rows[0];
  if (!tail) return;
  const cursorUrl = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(
    networkSlug,
  )}/channels/${encodeURIComponent(channel)}/read-cursor`;
  const cursorRes = await fetch(cursorUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message_id: tail.id }),
  });
  if (!cursorRes.ok) {
    throw new Error(
      `restoreReadCursorToTail: POST /read-cursor → ${cursorRes.status} ${await cursorRes.text()}`,
    );
  }
}

// #156 / #233 — FORCE the seeded user's read cursor on `(networkSlug,
// channel)` to a SPECIFIC message id (vs `restoreReadCursorToTail`,
// which always targets the newest row). Used by every cursor / divider
// / scroll spec to plant a mid-page (usually BACKWARD) cursor so an
// unread-divider scenario materialises on focus.
//
// #233 made the production `POST .../read-cursor` advance-only: a lower
// id is clamped to the current cursor and NEVER written backward. That
// broke this helper's original last-write-wins seeding (a prior spec
// leaves the cursor at the tail; a backward seed was silently dropped →
// no divider → red suite). It now hits the TEST-ONLY
// `.../read-cursor/force` endpoint (compile-gated to dev/test,
// `ReadCursor.force_set/4`) which bypasses the monotonic clamp while the
// production endpoint stays correctly advance-only. Broadcasts the
// forced id so a live cic instance adopts the backward move via its
// authoritative `read_cursor_set` WS path. Caller restores via
// `restoreReadCursorToTail` in afterAll (BUGHUNT-3 cascade rule) — the
// tail is a FORWARD move, so the production endpoint still serves it.
//
// Seeding the cursor client-side is NOT an alternative: post-CP29 R-1..R-4
// the cursor is server-owned, cic hydrates it from the `/me` envelope at cold
// load and from the per-channel join reply on subscribe, and the R-4 migration
// nukes the legacy localStorage `rc:` keys on boot.
export async function setReadCursorToId(
  token: string,
  networkSlug: string,
  channel: string,
  messageId: number,
): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(
    networkSlug,
  )}/channels/${encodeURIComponent(channel)}/read-cursor/force`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message_id: messageId }),
  });
  if (!res.ok) {
    throw new Error(
      `setReadCursorToId: POST /read-cursor/force → ${res.status} ${await res.text()}`,
    );
  }
}

// #156 — page the FULL scrollback for `(networkSlug, channel)` oldest-
// first. GET /messages returns the newest ~50 DESC; `?before=<id>` walks
// older pages until empty. Returns rows ASC by id so the caller can index
// from the oldest. Used by the unread-divider-beyond-window spec to learn
// the seeded id range (it must plant a cursor well below the tail window
// without hardcoding seed ids).
export async function fetchAllMessagesAsc(
  token: string,
  networkSlug: string,
  channel: string,
): Promise<WireMessage[]> {
  const byId = new Map<number, WireMessage>();
  let before: number | undefined;
  // Bounded loop: the e2e seed is ~200 rows; 50 pages of ~50 is a safe
  // ceiling that also stops a server bug from spinning forever.
  for (let page = 0; page < 50; page++) {
    const rows = await getMessagesPage(token, networkSlug, channel, before);
    if (rows.length === 0) break;
    for (const r of rows) byId.set(r.id, r);
    // Server returns DESC; the oldest id in this page is the next cursor.
    before = rows.reduce((min, r) => (r.id < min ? r.id : min), rows[0]?.id ?? 0);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

// M-9a — force-stop a live Session.Server pid, leaving every DB row
// untouched (`DELETE /admin/sessions/:id` → `Operator.terminate_session`).
// The m9b spec drives the same verb through the admin UI; this is the
// runner-side twin for specs that need the RESULTING STATE rather than the
// button. That state is the only way to manufacture, over a real stack, the
// divergence #897 is about: a credential row still reading `:connected` with
// no live link behind it.
//
// `sessionId` is the composite `"<kind>:<subject_uuid>:<network_id>"` the
// admin surface keys on. Idempotent (204 even when the pid is already gone).
export async function terminateSession(adminToken: string, sessionId: string): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/admin/sessions/${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`grappaApi.terminateSession: ${sessionId} → ${res.status} ${await res.text()}`);
  }
}

// The admin surface keys users by id, and a spec that provisions its subject
// (#1078) only ever learns the NAME — hence the lookup. The name is a
// PARAMETER and not `specUser()` read from here: this module imports nothing,
// and reaching for the subject would make it import `specSubject`, which
// already imports this one.
export async function findUserIdByName(adminToken: string, userName: string): Promise<string> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`grappaApi.findUserIdByName: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { users: { id: string; name: string }[] };
  const user = body.users.find((u) => u.name === userName);
  if (!user) {
    throw new Error(`grappaApi.findUserIdByName: ${userName} absent from ${JSON.stringify(body)}`);
  }
  return user.id;
}

// The admin-chrome specs drive `is_admin` from BOTH sides — they revoke to
// assert the affordance disappears, then restore it — so the flag is a
// fixture verb, not an assertion. The id is a PARAMETER for the same reason
// `findUserIdByName` takes the name: this module imports nothing.
export async function setAdminFlag(
  adminToken: string,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ is_admin: isAdmin }),
  });
  if (!res.ok) {
    throw new Error(
      `grappaApi.setAdminFlag: is_admin=${isAdmin} on ${userId} → ${res.status} ${await res.text()}`,
    );
  }
}

// The two PER-SUBJECT caps, and only those two. `Grappa.Admission` treats them
// as one axis with two values: `check_network_total/2` has a clause per
// subject_kind and each reads the column matching its own kind, so the kind
// SELECTS the column.
type CapDimension = "max_concurrent_user_sessions" | "max_concurrent_visitor_sessions";

// `max_per_ip` joins them here as a separate term because it is a separate
// axis, not a third value of this one. Admission enforces it in its own
// function, over a different unit (distinct persisted subjects keyed on
// `accounts_sessions.ip`, not live registry sessions), and reads `subject_kind`
// as a FILTER rather than a column selector. The sharpest tell is the sentinel:
// `nil` on a per-subject cap means UNLIMITED, while `nil` on `max_per_ip` means
// fall back to the operator default. The server's own generated wire agrees —
// `AdminEventsWireCapCountsChangedEvent` pairs the two per-subject caps with
// their live counts and omits `max_per_ip`, there being no per-IP count.
//
// Derived from the generated row type rather than spelled by hand, so a rename
// on the server fails this file at `tsc` instead of drifting past it. Being a
// PICK is also what keeps the verb honest: the endpoint casts seven fields, and
// naming three of them is what stops `adminPatchCaps` from moving
// `visitor_enabled`.
type NetworkCaps = Partial<Pick<NetworksAdminWireT, CapDimension | "max_per_ip">>;

export async function adminPatchCaps(
  adminToken: string,
  slug: string,
  caps: NetworkCaps,
): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(caps),
  });
  if (!res.ok) {
    throw new Error(`grappaApi.adminPatchCaps: ${slug} → ${res.status} ${await res.text()}`);
  }
}

// #1158 item 4 — the lifecycle log collapsed to one entry per session.
// A spec uses this as a PRECONDITION barrier, never as the property under
// test: the log is a bounded global ring written from an async cast, so a
// spec that wants to drive the "subject deleted, event survives" surface
// must first establish that the event actually landed.
export async function listSessionLogSessions(
  adminToken: string,
): Promise<Array<{ session_id: string; event: string; nick: string | null }>> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/session_log/sessions`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`grappaApi.listSessionLogSessions: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    session_log_sessions: Array<{ session_id: string; event: string; nick: string | null }>;
  };
  return body.session_log_sessions;
}

// issue 1889 — remove an upload the way an operator removes one, so a spec can
// drive the REAL 404 the viewer has to tell apart from a broken load.
// `Admin.UploadsController.delete` unlinks the file first and then soft-deletes
// the row, which is exactly the state the incident describes; faking it with a
// `page.route` fulfil would prove the branch and not the behaviour.
//
// Two hops because the admin surface keys uploads by `id` while everything a
// spec can see — the URL in the scrollback, the POST response — carries the
// `slug`. The listing INCLUDES soft-deleted rows (it is the operator's audit
// trail), so resolving by slug is unambiguous only before a second upload
// reuses it, which the 26-char base32 slug rules out.
export async function adminDeleteUploadBySlug(adminToken: string, slug: string): Promise<void> {
  const listRes = await fetch(`${GRAPPA_BASE_URL}/admin/uploads`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!listRes.ok) {
    throw new Error(
      `grappaApi.adminDeleteUploadBySlug: GET /admin/uploads → ${listRes.status} ${await listRes.text()}`,
    );
  }
  const body = (await listRes.json()) as { uploads: Array<{ id: string; slug: string }> };
  const row = body.uploads.find((u) => u.slug === slug);
  // Loud rather than idempotent, deliberately: a spec that reaches the click
  // without having deleted anything would assert the GONE text against a live
  // upload and fail somewhere far from the cause.
  if (row === undefined) {
    throw new Error(`grappaApi.adminDeleteUploadBySlug: no upload row for slug ${slug}`);
  }

  const delRes = await fetch(`${GRAPPA_BASE_URL}/admin/uploads/${encodeURIComponent(row.id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!delRes.ok) {
    throw new Error(
      `grappaApi.adminDeleteUploadBySlug: DELETE ${row.id} → ${delRes.status} ${await delRes.text()}`,
    );
  }
}

// issue 1889 — what the PUBLIC upload route answers now, as a precondition a
// spec can assert before it goes looking for the client's reaction to it.
//
// Takes the minted absolute URL and re-roots its path onto `GRAPPA_BASE_URL`
// rather than fetching it as given: the mint carries whatever host
// `Endpoint.url/0` is configured with, and the runner reaches grappa by its
// compose service name. Re-rooting keeps this working wherever the deployment
// thinks it lives, and the path is the whole of what identifies the upload.
//
// `method` is REQUIRED rather than defaulted to GET, because the two verbs
// answer two different questions and a caller has to say which one it is
// asking. GET is "is the route gone"; HEAD is "does the verb the viewer's
// probe actually uses reach that same answer" — `Plug.Head` is supposed to
// rewrite HEAD to GET above the router, and a default would let a spec assert
// the first while believing it had checked the second.
export async function publicUploadStatus(
  uploadUrl: string,
  method: "GET" | "HEAD",
): Promise<number> {
  const res = await fetch(`${GRAPPA_BASE_URL}${new URL(uploadUrl).pathname}`, { method });
  return res.status;
}

// M-cluster M-8 — operator-side delete via admin bearer. Mirrors
// `Grappa.Operator.delete_visitor/1`. Used by e2e tests that mint
// a visitor and need teardown cleanup on early-assertion-failure
// paths (so the e2e harness doesn't accumulate orphan visitor
// rows across failed runs — `Visitors.Reaper` only sweeps on
// expiry, not on test exit).
//
// Idempotent: 404 (visitor already deleted by the test under
// assertion) is treated as success.
export async function adminDeleteVisitor(adminToken: string, visitorId: string): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/admin/visitors/${encodeURIComponent(visitorId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `grappaApi.adminDeleteVisitor: ${visitorId} → ${res.status} ${await res.text()}`,
    );
  }
}

// #1770 — "is this visitor row still there?", read from the admin listing.
//
// The oracle is deliberately the ADMIN index and not the visitor's own bearer
// coming back 401: a revoked-but-present row answers 401 too, so that reading
// could not tell a deleted row from a merely logged-out one — and "the row is
// gone" is the whole claim. `GET /admin/visitors` renders
// `Grappa.Visitors.AdminWire.index_payload/1`, i.e. `{visitors: [...]}`.
export async function visitorExists(adminToken: string, visitorId: string): Promise<boolean> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/visitors`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`grappaApi.visitorExists: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { visitors: Array<{ id: string }> };
  return body.visitors.some((v) => v.id === visitorId);
}

// #574 — reap minted visitors LOUD in test cleanup. The single de-swallowing
// primitive every spec's teardown must go through instead of the old
// `adminDeleteVisitor(...).catch(() => {})`.
//
// WHY it's shared, not inlined 27×: a `.catch(() => {})` around the delete
// silently strands a LIVE visitor when the delete fails (e.g. an aborted spec
// whose cleanup also hits the #506 `database is locked` 500). The stranded
// session then poisons downstream specs that assert an EXACT live-session /
// visitor count on the serial (`workers: 1`) stack — m9b-admin-sessions-actions
// (`toHaveCount(4)` observes 6), #481 accretion, #211 — and the red surfaces
// FAR from its cause, reading as an unrelated flake. This is CLAUDE.md's
// "No silent-swallow at boundaries", inside test cleanup (#517 fixed the one
// instance in issue299; #574 is the class).
//
// COLLECT-then-throw, not drop-`.catch`-per-call: when a finally reaps more
// than one visitor, letting the first delete throw would SKIP the rest
// (masking-by-skip — the #517 lesson), stranding the tail. So every id is
// attempted, failures are collected, and an AggregateError is thrown iff any
// failed. null/undefined ids are skipped, so callers pass `visitor?.id`
// without an `if` guard. adminDeleteVisitor is idempotent (404 == success),
// so on a green run where the spec already deleted the visitor this is a
// no-op — it only throws when a delete ACTUALLY fails.
export async function reapVisitors(
  adminToken: string,
  ...visitorIds: Array<string | null | undefined>
): Promise<void> {
  const errors: unknown[] = [];
  for (const visitorId of visitorIds) {
    if (!visitorId) continue;
    try {
      await adminDeleteVisitor(adminToken, visitorId);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "reapVisitors: visitor cleanup failed (#574)");
  }
}

// Poll GET /networks/:network_slug/channels/:channel/messages for a
// row matching {sender, body}. Channel id in the URL is the channel
// NAME (`#spec-wN`) — grappa's REST surface keys channels by slug-shape,
// not integer FK (see GrappaWeb.Router scope; ResolveNetwork resolves
// the network slug, the channel segment is the name). Response is a
// flat JSON array of `Grappa.Scrollback.Wire.t()` shapes — see
// lib/grappa/scrollback/wire.ex for the contract.
//
// 100ms tick / 5s ceiling matches the per-bucket spec in plan S2;
// longer ceilings are caller-overridable once a single spec needs it
// (don't raise the default).
//
// `body` is optional — presence kinds (:join / :part / :quit) persist
// with body = null in the wire shape, so passing `body: ""` would
// never match. Omit `body` for those kinds and pass `kind: "join"`
// (or "part" etc.) to match by kind alone. For PRIVMSG/NOTICE/ACTION
// pass `body` (and optionally `kind: "privmsg"`) for exact-body match.
export type AssertMessageOpts = {
  token: string;
  networkSlug: string;
  channel: string;
  sender: string;
  body?: string;
  kind?: string;
  timeoutMs?: number;
  intervalMs?: number;
};

type WireMessage = {
  id: number;
  network: string;
  channel: string;
  server_time: number;
  kind: string;
  sender: string;
  body: string | null;
  meta: Record<string, unknown>;
};

export async function assertMessagePersisted(opts: AssertMessageOpts): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  let lastSeen: string[] = [];
  while (Date.now() < deadline) {
    // The one caller for which a non-200 is a RETRY, not a failure: the row
    // may simply not have landed yet, and the deadline below is what turns a
    // persistent absence into a loud error with `lastSeen` attached.
    //
    // The catch is deliberately narrow. A transport death is NOT retried:
    // polling through it would mask the fault instead of measuring it, which
    // is the no-silent-swallow rule at a boundary. Only the status arm is
    // tolerated; anything else propagates on the spot.
    let messages: WireMessage[];
    try {
      messages = await getMessagesPage(opts.token, opts.networkSlug, opts.channel, undefined);
    } catch (err) {
      if (!(err instanceof MessagesPageStatusError)) throw err;
      await sleep(intervalMs);
      continue;
    }
    const matched = messages.find(
      (m) =>
        m.sender === opts.sender &&
        (opts.body === undefined || m.body === opts.body) &&
        (opts.kind === undefined || m.kind === opts.kind),
    );
    if (matched) return;
    lastSeen = messages.map((m) => `${m.kind}/${m.sender}: ${m.body}`);
    await sleep(intervalMs);
  }
  throw new Error(
    `assertMessagePersisted: timeout after ${timeoutMs}ms — channel=${opts.channel} sender=${opts.sender} body=${JSON.stringify(opts.body)} kind=${JSON.stringify(opts.kind)}; last seen: ${JSON.stringify(lastSeen)}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GET /networks/:slug/archive — the server-side archive list (mirrors
// `cicchetto/src/lib/api.ts`'s `listArchive`). Returns the archived
// TARGET names only; callers assert membership.
//
// #402 uses it as the PRECONDITION of a client-side disappearance: cic
// filters this list through `visibleArchiveForNetwork`, so "the row is
// nowhere in the UI" only indicts the client once the server is on
// record as offering it. Without this probe a spec asserting absence
// stays green when the row stops being archive-eligible at all — passing
// for the wrong reason.
export async function listArchiveTargets(token: string, networkSlug: string): Promise<string[]> {
  const url = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(networkSlug)}/archive`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`listArchiveTargets: unexpected status ${res.status}`);
  }
  const body = (await res.json()) as { archive: Array<{ target: string }> };
  return body.archive.map((entry) => entry.target);
}

// PART a channel via REST DELETE (mirrors `cicchetto/src/lib/api.ts`'s
// `postPart`, but framed for the runner's GRAPPA_BASE_URL). Used by
// test cleanup hooks to undo `/join`'s autojoin-persistence side-effect
// — the channel survives across test runs in `Networks.Credential.
// autojoin` otherwise. Idempotent: 404 if the channel was never joined
// is treated as success by the caller (afterEach catches and ignores).
export async function partChannel(
  token: string,
  networkSlug: string,
  channelName: string,
): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`partChannel: unexpected status ${res.status}`);
  }
}

// #1038 — the stored mute key: the network slug, a space, and the channel or
// DM peer.
//
// Written out LITERALLY here rather than imported from `src/lib/channelKey`,
// and that is the point: an e2e is the only witness that cic's builder, the
// server's `Grappa.IRC.Identifier.channel_key/2` and the stored bytes are the
// SAME string. Deriving it from cic's builder would make this agree with
// whatever cic does, including a drift that orphans every mute already
// stored. Same reasoning the server keeps its own literal pin in
// `resolver_test.exs` for the presence-pin key.
//
// The channel is NOT folded here: every spec passes an already-lowercase name,
// and folding would hide a stack that stopped folding. A spec that needs a
// mixed-case target should assert the folded literal it expects.
export function muteKey(networkSlug: string, target: string): string {
  return `${networkSlug} ${target}`;
}

// #866 — drop every per-conversation mute for `token`'s subject.
//
// notification_prefs live in `user_settings` and OUTLIVE the spec that wrote
// them: the seeded vjt is shared by the whole suite, so a mute left behind
// silences a channel for every later spec that expects a push or a beep. That
// is the shared-stack poisoning class, and it is silent — the victim spec
// fails on a missing notification with nothing pointing back here.
//
// Read-modify-write rather than PUT-the-defaults: the endpoint has no PATCH
// semantics, so writing a fresh default map would also clobber whatever
// whitelists / toggles another fixture had set.
export async function clearMutedConversations(token: string): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/me/settings/notification-prefs`;
  const headers = { authorization: `Bearer ${token}` };

  const current = await fetch(url, { headers });
  if (!current.ok) throw new Error(`clearMutedConversations: GET ${current.status}`);
  const { notification_prefs: prefs } = (await current.json()) as {
    notification_prefs: Record<string, unknown>;
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ ...prefs, muted_targets: {} }),
  });
  if (!res.ok) throw new Error(`clearMutedConversations: PUT ${res.status}`);
}

// JOIN a channel via REST POST (mirrors `cicchetto/src/lib/api.ts`'s
// `postJoin`). Used by tests that PART a seeded channel and need to
// restore it for subsequent specs (M9, in particular — without restore,
// later specs that assume #spec-wN is joined fail at selectChannel because
// the BottomBar tab no longer exists). 200/201/202 = success; the body
// shape isn't read.
export async function joinChannel(
  token: string,
  networkSlug: string,
  channelName: string,
): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(networkSlug)}/channels`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: channelName }),
  });
  if (!res.ok) {
    throw new Error(`joinChannel: unexpected status ${res.status}`);
  }
}

// GET /networks/:slug/channels — the channel list cic itself reads at boot
// (`networks.ts` `channelsBySlug`). A spec whose PRECONDITION is "already in
// this channel" must wait on THIS list rather than on `joinChannel` returning:
// the POST only asks, and the row lands once the upstream JOIN completes. A
// spec that races it is testing the boot ordering, not the behaviour it names
// (#793, where the invite's already-in branch was scored against a channel the
// server had not listed yet).
export async function listChannelNames(token: string, networkSlug: string): Promise<string[]> {
  const url = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(networkSlug)}/channels`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`listChannelNames: unexpected status ${res.status}`);
  }
  // The response IS the array (no named wrapper) — same shape cic's
  // `api.ts` `listChannels` reads.
  const body = (await res.json()) as Array<{ name: string }>;
  return body.map((c) => c.name);
}

// PATCH /networks/:slug — T32 connection_state transition. Mirrors
// `cicchetto/src/lib/api.ts`'s `patchNetwork`. Used by the parked-
// flow e2e: setting `connection_state: "parked"` triggers
// `Grappa.Networks.disconnect/2` server-side which terminates the
// Session.Server, broadcasts `connection_state_changed` over WS,
// and flips the credential row. Setting `connection_state:
// "connected"` triggers `Grappa.Networks.connect/1` (lazy spawn at
// next admission run, but the broadcast happens immediately).
//
// Body matches `NetworksController.update/2` action: required
// `connection_state` ("parked" | "connected"), optional `reason`
// string. 200 on success.
export async function patchNetworkConnectionState(
  token: string,
  networkSlug: string,
  body: { connection_state: "parked" | "connected"; reason?: string },
): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(networkSlug)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `patchNetworkConnectionState: ${networkSlug} → ${res.status} ${await res.text()}`,
    );
  }
}

// Settle a network back to "fully autojoined and NAMES-seeded" after a spec
// parked it. Returns as soon as that holds; gives up silently after the
// budget, because the caller is a best-effort `afterEach` and throwing there
// would replace one spec's failure with a confusing second one.
//
// #1796 — extracted from `cp15-b6-parked-disconnect-reconnect.spec.ts`, which
// is where the argument was made and paid for; a second network-parking spec
// re-typing it is how the subtle half of it (the 200-vs-204 distinction) would
// get dropped. Its reasoning, unchanged:
//
//   The testnet does NOT reset between specs, so leaving a parked credential
//   breaks every following spec that expects autojoin to be live. Observed:
//   skipping this poll cascaded 18 failures across m1-m9 and the downstream
//   cp15-b6-* specs, because every following spec inherits a half-spawned
//   Session.
//
//   #522 — `joined` is NOT a sufficient settle signal. The channels endpoint
//   reports `joined: true` the instant the channel enters `state.members` (the
//   self-JOIN echo), which lands BEFORE the 353/366 NAMES burst seeds the
//   member list; returning there leaks a mid-stabilization session into the
//   next spec and flakes its members assertion ~60% of the time. Only a 200
//   from GET /members (channel in `seeded_channels` → 366 landed, no NAMES in
//   flight) WITH the own nick present is the deterministic signal. HTTP 204
//   (`:uninitialized`) is joined-but-pre-NAMES → keep polling.
//
//   60 × 500ms = 30s: SpawnOrchestrator → IRC connect → SASL → autojoin →
//   JOIN echo → 353/366 → members seeded is empirically ~3-5s on a healthy
//   testnet; the ceiling absorbs upstream rate-limit penalties accumulated by
//   prior specs' churn. Budget the CALLER's `test.setTimeout` for it.
export async function settleNetworkAutojoin(
  token: string,
  networkSlug: string,
  channel: string,
  ownNick: string,
): Promise<void> {
  await patchNetworkConnectionState(token, networkSlug, {
    connection_state: "connected",
  }).catch(() => {});

  const headers = { authorization: `Bearer ${token}` };
  const channelsUrl = `${GRAPPA_BASE_URL}/networks/${networkSlug}/channels`;
  const membersUrl = `${GRAPPA_BASE_URL}/networks/${networkSlug}/channels/${encodeURIComponent(
    channel,
  )}/members`;
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await fetch(channelsUrl, { headers }).catch(() => null);
    if (res?.ok) {
      const channels = (await res.json()) as Array<{ name: string; joined: boolean }>;
      if (channels.find((c) => c.name === channel)?.joined) {
        const membersRes = await fetch(membersUrl, { headers }).catch(() => null);
        if (membersRes?.status === 200) {
          const { members } = (await membersRes.json()) as { members: Array<{ nick: string }> };
          if (members.some((m) => m.nick === ownNick)) return;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// #498 — self-serve accretion (`POST /session/networks`). Binds + spawns
// the visitor_enabled `slug` for the authenticated subject, anon
// (`auth_method: :none`), with the account name as the default nick. `204`
// = newly bound; `409` already_attached is treated as success so callers
// are `--repeat-each` idempotent (the credential already exists — a second
// accrete is a no-op, not a failure). Any other status throws. Follow with
// `patchNetworkConnectionState({connection_state: "connected"})` to
// guarantee the session is live regardless of prior state.
export async function accreteNetwork(token: string, slug: string): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/session/networks`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ network: slug }),
  });
  if (res.status === 204 || res.status === 409) return;
  throw new Error(`accreteNetwork: ${slug} → ${res.status} ${await res.text()}`);
}

// Fetch `/me` and return the read-cursor for `(networkSlug, channel)`,
// or `null` if no cursor has been set yet. Used by UX-6-K to assert
// that cic's cursor POST landed server-side after focus-leave.
//
// `/me` is the authoritative cold-load source per
// `lib/grappa/read_cursor.ex` (`bulk_for_subject/1`); the e2e probes
// it directly rather than tailing the WS broadcast because the post-
// fix code path is `cic POST → server set → server broadcast → cic
// applyReadCursorSet`. Reading `/me` shortcuts the loop and confirms
// the persist-side state without depending on WS timing.
export async function getReadCursor(
  token: string,
  networkSlug: string,
  channel: string,
): Promise<number | null> {
  const res = await fetch(`${GRAPPA_BASE_URL}/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`getReadCursor: /me → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    read_cursors: Record<string, Record<string, number>>;
  };
  return body.read_cursors?.[networkSlug]?.[channel] ?? null;
}

// E2E-ROBUSTNESS bucket D — per-spec subject reset. Drains every
// mutable surface for `userName` (DB rows + Session.Server restart
// + ETS entries) so the next spec begins from a clean baseline.
// Server-side gates: route compile-gated to dev/test Mix env
// (router.ex); admin_authn requires admin bearer.
//
// Caller MUST pass the seeded ADMIN token (getSeededAdmin().token),
// NOT the user's own token. The endpoint is admin-only.
//
// `baselineAutojoin` (network_slug → channels) restores
// `cred.autojoin_channels` to the seed-time list per network. cic's
// PART verb (DELETE /networks/.../channels) strips the channel from
// operator-config autojoin permanently (UX-1, m9-part-x-click,
// cp15-b6 exercise this); without restoration, every subsequent
// reset would see an empty autojoin list and the seed `#spec-wN`
// would never re-JOIN.
//
// `baselineSeed` (network_slug → [{name, seedCount, seedSender}])
// truncates per-channel scrollback to zero rows then re-seeds
// `seedCount` synthetic privmsg rows. Without this, prior specs'
// send_privmsg / peer JOIN/PRIVMSG accumulate across the run and
// later specs see different scrollback density → marker/scroll/
// cursor assertions flip (CP49 S2 residual cascade root).
//
// Throws on non-204 — afterEach treats reset failures as loud test
// failures, never silently ignores. Wire shape mirrors the
// SubjectReset.reset_error type (404 user_not_found, 504 reconnect
// timeout / autojoin timeout w/ network_slug, 500 reconnect_failed
// w/ slug + reason).
export interface BaselineSeedChannel {
  name: string;
  seedCount?: number;
  seedSender?: string;
}

/**
 * What one reset actually cost, for #934. `attempts` is how many times
 * the 433 retry below fired (1 = no retry); `phases` is the server's own
 * `k=v;k=v` breakdown, forwarded on the 204 as `x-grappa-reset-phases`.
 */
export type ResetOutcome = {
  attempts: number;
  phases: string;
};

export async function resetSubject(
  adminToken: string,
  userName: string,
  baselineAutojoin?: Record<string, string[]>,
  baselineSeed?: Record<string, BaselineSeedChannel[]>,
): Promise<ResetOutcome> {
  const body: Record<string, unknown> = { user_name: userName };
  if (baselineAutojoin) body.baseline_autojoin = baselineAutojoin;
  if (baselineSeed) {
    body.baseline_seed = Object.fromEntries(
      Object.entries(baselineSeed).map(([slug, chans]) => [
        slug,
        chans.map((c) => ({
          name: c.name,
          seed_count: c.seedCount ?? 0,
          seed_sender: c.seedSender ?? "seed-bot",
        })),
      ]),
    );
  }

  // #277/#653 — the reset restarts vjt's Session.Server, which reconnects to
  // bahamut-test and re-registers `vjt-grappa`. Under full-gate load an
  // earlier spec's upstream session may not have released the nick yet, so
  // the re-register hits 433 ERR_NICKNAMEINUSE and the reset 500s with
  // `{:client_exit, {:nick_rejected, 433, "vjt-grappa"}}`. That 433 is the
  // OBSERVABLE "nick not free yet" signal from the testnet — retry the whole
  // reset on it with bounded backoff until bahamut releases the ghost (204).
  // This is NOT a blind pre-sleep: we retry ONLY while the server reports the
  // nick still taken, and ONLY that one signal — every other non-204
  // (404 user_not_found, 504 timeout, any other 500) throws IMMEDIATELY, so a
  // real reset failure is never masked. Known bahamut ghost-race tail (the
  // #268 class; see feedback_integration_bahamut_ip_autokill_flake).
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${GRAPPA_BASE_URL}/admin/test/reset-subject`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 204) {
      return {
        attempts: attempt,
        phases: res.headers.get("x-grappa-reset-phases") ?? "",
      };
    }

    const text = await res.text().catch(() => "<no body>");
    const nickStillTaken = res.status === 500 && text.includes("nick_rejected");
    if (!nickStillTaken || attempt === maxAttempts) {
      throw new Error(`resetSubject(${userName}) failed: ${res.status} ${text}`);
    }
    // #934 — this retry used to be SILENT, and that silence cost a whole
    // investigation: `nick_rejected` appeared zero times in a full suite
    // log and the zero proved nothing, because nothing ever wrote one.
    // A loop that can multiply a 500 ms call by eight has to say so.
    process.stderr.write(`__RESETRETRY__\t${attempt}\t${userName}\tnick_rejected\n`);
    // Observed 433 → the ghosted nick isn't released yet. Back off (capped)
    // then re-register; each reset attempt also reconnects, which itself
    // gives bahamut time to reap the prior connection's ghost.
    await sleep(Math.min(500 * attempt, 2_000));
  }
  // Unreachable: the loop either returns on 204 or throws at maxAttempts.
  throw new Error(`resetSubject(${userName}): retry loop fell through`);
}

// Overwrite a user's `credential.autojoin_channels` via the admin
// PATCH. Mirrors `PATCH /admin/credentials/:user_id/:network_id`
// (`GrappaWeb.Admin.CredentialsController.update/2`).
//
// Why this and not `resetSubject(baselineAutojoin)`: an autojoin-only
// edit is classified `:left_alone` server-side
// (`Credentials.classify_session_action/3`) — a DB write with NO
// session restart, so it does NOT trigger the autojoin JOIN loop.
// That's exactly what the issue #38 repro needs: stage a +k channel
// into operator-config autojoin, THEN spawn (via /disconnect +
// Reconnect) so the JOIN fires at the next session boot and 475s.
// `resetSubject` can't stage a perpetually-failing +k channel — its
// `await_autojoin` polls every entry to `:joined` and would 504.
//
// Caller MUST pass the seeded ADMIN token. `userId` is the User UUID
// (the login subject `id`); `networkId` is the integer FK (always 1
// in the e2e seeder).
export async function setCredentialAutojoin(
  adminToken: string,
  userId: string,
  networkId: number,
  autojoinChannels: string[],
): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/admin/credentials/${encodeURIComponent(userId)}/${networkId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ autojoin_channels: autojoinChannels }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`setCredentialAutojoin(${userId}/${networkId}) → ${res.status} ${text}`);
  }
}

/**
 * #1883 — turn the pre-upload confirm opt-in on (or off) for this subject.
 *
 * The confirm is OFF by default, which is what `uploadJourney.pickFile`
 * describes. A spec whose SUBJECT is the confirm calls this after login and
 * then drives `sendPickedFiles` after the privacy notice's Continue — the
 * order being privacy first, confirm second (#1883e).
 *
 * Server-side and per-user, so it survives the page load the spec is about to
 * do; nothing in localStorage carries it.
 */
export async function setUploadConfirmEnabled(token: string, enabled: boolean): Promise<void> {
  const response = await fetch(`${GRAPPA_BASE_URL}/me/settings/upload-confirm-enabled`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ upload_confirm_enabled: enabled }),
  });
  if (!response.ok) {
    throw new Error(
      `setUploadConfirmEnabled(${enabled}) failed: ${response.status} ${await response.text()}`,
    );
  }
}
