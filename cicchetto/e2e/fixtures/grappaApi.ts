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

const GRAPPA_BASE_URL = "http://grappa-test:4000";

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
