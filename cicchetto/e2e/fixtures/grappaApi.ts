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
    throw new Error(
      `grappaApi.login: ${identifier} → ${response.status} ${await response.text()}`,
    );
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
};

export async function mintVisitor(nick: string): Promise<MintedVisitor> {
  const response = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: nick }),
  });
  if (!response.ok) {
    throw new Error(
      `grappaApi.mintVisitor: ${nick} → ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    token: string;
    subject: { kind: "visitor"; id: string };
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
  };
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
  const messagesUrl = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(
    networkSlug,
  )}/channels/${encodeURIComponent(channel)}/messages`;
  const messagesRes = await fetch(messagesUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!messagesRes.ok) {
    throw new Error(
      `restoreReadCursorToTail: GET /messages → ${messagesRes.status} ${await messagesRes.text()}`,
    );
  }
  const rows = (await messagesRes.json()) as Array<{ id: number }>;
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

// #156 — set the seeded user's read cursor on `(networkSlug, channel)`
// to a SPECIFIC message id (vs `restoreReadCursorToTail`, which always
// targets the newest row). Used by the unread-divider-beyond-window spec
// to plant an EARLY cursor so the unread count far exceeds the initial
// scrollback window. The server's `ReadCursor.set/4` is last-write-wins
// and accepts a backward move, so this can rewind a cursor a prior spec
// left at the tail. Caller restores via `restoreReadCursorToTail` in
// afterAll (BUGHUNT-3 cascade rule).
export async function setReadCursorToId(
  token: string,
  networkSlug: string,
  channel: string,
  messageId: number,
): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(
    networkSlug,
  )}/channels/${encodeURIComponent(channel)}/read-cursor`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message_id: messageId }),
  });
  if (!res.ok) {
    throw new Error(
      `setReadCursorToId: POST /read-cursor → ${res.status} ${await res.text()}`,
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
  const base = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(
    networkSlug,
  )}/channels/${encodeURIComponent(channel)}/messages`;
  const headers = { authorization: `Bearer ${token}` };
  const byId = new Map<number, WireMessage>();
  let before: number | undefined;
  // Bounded loop: the e2e seed is ~200 rows; 50 pages of ~50 is a safe
  // ceiling that also stops a server bug from spinning forever.
  for (let page = 0; page < 50; page++) {
    const url = before === undefined ? base : `${base}?before=${before}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`fetchAllMessagesAsc: GET → ${res.status} ${await res.text()}`);
    }
    const rows = (await res.json()) as WireMessage[];
    if (rows.length === 0) break;
    for (const r of rows) byId.set(r.id, r);
    // Server returns DESC; the oldest id in this page is the next cursor.
    before = rows.reduce((min, r) => (r.id < min ? r.id : min), rows[0]?.id ?? 0);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
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
export async function adminDeleteVisitor(
  adminToken: string,
  visitorId: string,
): Promise<void> {
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

// Poll GET /networks/:network_slug/channels/:channel/messages for a
// row matching {sender, body}. Channel id in the URL is the channel
// NAME (`#bofh`) — grappa's REST surface keys channels by slug-shape,
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

  const url = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(opts.networkSlug)}/channels/${encodeURIComponent(opts.channel)}/messages`;
  const headers = { Authorization: `Bearer ${opts.token}` };

  let lastSeen: string[] = [];
  while (Date.now() < deadline) {
    const response = await fetch(url, { headers });
    if (response.ok) {
      const messages = (await response.json()) as WireMessage[];
      const matched = messages.find(
        (m) =>
          m.sender === opts.sender &&
          (opts.body === undefined || m.body === opts.body) &&
          (opts.kind === undefined || m.kind === opts.kind),
      );
      if (matched) return;
      lastSeen = messages.map((m) => `${m.kind}/${m.sender}: ${m.body}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `assertMessagePersisted: timeout after ${timeoutMs}ms — channel=${opts.channel} sender=${opts.sender} body=${JSON.stringify(opts.body)} kind=${JSON.stringify(opts.kind)}; last seen: ${JSON.stringify(lastSeen)}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// JOIN a channel via REST POST (mirrors `cicchetto/src/lib/api.ts`'s
// `postJoin`). Used by tests that PART a seeded channel and need to
// restore it for subsequent specs (M9, in particular — without restore,
// later specs that assume #bofh is joined fail at selectChannel because
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
// reset would see an empty autojoin list and the seed `#bofh`
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

export async function resetSubject(
  adminToken: string,
  userName: string,
  baselineAutojoin?: Record<string, string[]>,
  baselineSeed?: Record<string, BaselineSeedChannel[]>,
): Promise<void> {
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

  const res = await fetch(`${GRAPPA_BASE_URL}/admin/test/reset-subject`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 204) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`resetSubject(${userName}) failed: ${res.status} ${text}`);
  }
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
    throw new Error(
      `setCredentialAutojoin(${userId}/${networkId}) → ${res.status} ${text}`,
    );
  }
}
