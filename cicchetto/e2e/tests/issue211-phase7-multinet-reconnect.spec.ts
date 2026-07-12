// #211 phase 7 — HEADLINE e2e: ONE visitor bound to TWO networks
// survives a REAL cic↔grappa WebSocket drop and reappears LIVE on BOTH
// networks simultaneously.
//
// The coverage gap this closes (verified 2026-07-12): the existing
// reconnect corpus proves either
//   (a) SINGLE-network reconnect via a real WS drop
//       (message-replay-on-reconnect — the pattern this spec generalises),
//   (b) per-network PARK→reconnect via a deliberate
//       `PATCH /networks/:id {connection_state}` — NOT a real socket
//       drop, and it asserts only the DB `connection_state`, never a live
//       members list or PRIVMSG round-trip (issue211-phase6-matrix), or
//   (c) multi-network ACCRETION with no reconnect at all
//       (issue211-phase3-multinet-visitor).
// NONE proved the multi-network generalisation of (a): the SAME subject
// on MULTIPLE networks undergoing a real WS reconnect and REAPPEARING
// LIVE on ALL of them (own nick back in members on EVERY net, a live
// PRIVMSG recovered on EACH). This spec is that proof.
//
// WHY THIS IS THE PHASE-7 PROOF, not just a reconnect proof. azzurra and
// azzurra2 are TWO SEPARATE IRC networks: azzurra dials the azzurra-testnet
// leaf (`bahamut-test`), azzurra2 dials a standalone second ircd
// (`bahamut-test2`) with its OWN nick namespace — no S2S link between them
// (see cicchetto/e2e/compose.yaml). That separation is what lets ONE
// visitor hold a LIVE session on BOTH simultaneously, and it is why the
// setup can then edit azzurra2's nick via the phase-7 subject-agnostic
// `PATCH /networks/:id/identity` door to a value DIFFERENT from azzurra's:
// per-`(subject, network)` credential identity, proven end-to-end (the
// same visitor presenting distinct nicks on its two networks). A
// same-nick collision on ONE shared ircd would 433 → respawn-flood →
// bahamut autokills the source IP network-wide (verified via container
// logs 2026-07-12) — the separate-ircd topology is what sidesteps that
// trap. THEN it drops the cic socket and proves both networks recover.
//
// Runs on chromium desktop (members pane renders directly, no mobile
// drawer). A single browser context holds the ONE visitor; cic
// subscribes to EVERY joined channel across BOTH networks from the
// channels-loop (subscribe.ts), not just the focused one, so the
// reconnect backfill (`refreshScrollback` for every `joined` key) heals
// both networks in one socket resume.

import type { Browser, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test";
import { selectChannel, waitForUserTopicReady } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import {
  adminDeleteVisitor,
  assertMessagePersisted,
  GRAPPA_BASE_URL,
  mintVisitor,
} from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

const ANCHOR = "azzurra";
const SECOND = "azzurra2";

// Two full connect chains + an identity bounce + a WS drop/resume + a
// peer round-trip on each network — well past the default. Give it
// plenty of testnet-latency headroom (matches the phase-6 matrix budget).
test.setTimeout(150_000);

// Boot the ONE visitor into a fresh browser context. The subject wire is
// phase-7-slim ({id, registered}); per-network nick lives on the
// GET /networks rows, so no nick/network_slug is seeded here.
async function bootVisitor(
  browser: Browser,
  visitor: { id: string; token: string },
): Promise<{ ctx: Awaited<ReturnType<Browser["newContext"]>>; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [visitor.token, JSON.stringify({ kind: "visitor", id: visitor.id })] as const,
  );
  await page.goto("/");
  await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });
  return { ctx, page };
}

type NetRow = { slug: string; nick: string; connection_state: string };

async function getNetworks(token: string): Promise<NetRow[]> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`getNetworks: ${res.status} ${await res.text()}`);
  return (await res.json()) as NetRow[];
}

// Guard: the visitor subject must survive the whole setup. A same-nick
// collision on a shared ircd would 433 → respawn-flood → bahamut autokills
// the source IP → `mark_failed` EXPIRES the visitor row → the subject is
// purged and its token 401s (the trap that motivated the separate-ircd
// topology). Asserting the subject is still authenticated after each setup
// step fails loud with the exact step, rather than surfacing later as an
// opaque 401 on the first JOIN.
async function assertAlive(token: string, label: string): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`assertAlive[${label}]: /me → ${res.status} ${await res.text()}`);
  }
}

// Poll GET /networks until `slug` reaches `state` (or throw). Used to
// gate on the async spawn/park/reconnect fan-out settling.
async function waitForNetworkState(
  token: string,
  slug: string,
  state: string,
  attempts = 60,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    // Do NOT mask a 401 here — if the subject dies mid-poll we want the
    // failure surfaced at the exact step, not swallowed into a
    // "never reached state" timeout.
    const rows = await getNetworks(token);
    const row = rows.find((r) => r.slug === slug);
    if (row?.connection_state === state) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForNetworkState: ${slug} never reached ${state}`);
}

// Set the per-network nick via the phase-7 subject-agnostic door
// `PATCH /networks/:slug/identity`. On a live session this bounces the
// upstream (SpawnOrchestrator.reconnect); on a failed/parked one it
// persists only and the next spawn reads it.
async function setNetworkNick(token: string, slug: string, nick: string): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks/${slug}/identity`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ nick }),
  });
  if (!res.ok) throw new Error(`setNetworkNick: ${slug}=${nick} → ${res.status} ${await res.text()}`);
}

async function patchConnectionState(
  token: string,
  slug: string,
  state: "connected" | "parked",
): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks/${slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ connection_state: state }),
  });
  if (!res.ok) {
    throw new Error(`patchConnectionState: ${slug}=${state} → ${res.status} ${await res.text()}`);
  }
}

async function fetchMembers(token: string, slug: string, channel: string): Promise<string[]> {
  const res = await fetch(
    `${GRAPPA_BASE_URL}/networks/${slug}/channels/${encodeURIComponent(channel)}/members`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`fetchMembers: ${slug}/${channel} → ${res.status}`);
  const body = (await res.json()) as { members: Array<{ nick: string }> };
  return body.members.map((m) => m.nick);
}

// Poll members until the visitor's OWN nick is present (per
// feedback_e2e_visitor_members_list — the visible liveness proof).
async function waitForOwnNickInMembers(
  token: string,
  slug: string,
  channel: string,
  ownNick: string,
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const members = await fetchMembers(token, slug, channel).catch(() => []);
    if (members.includes(ownNick)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForOwnNickInMembers: ${ownNick} never appeared in ${slug}/${channel}`);
}

// JOIN via REST, retrying on 404. `POST /networks/:slug/channels` needs a
// LIVE registered session — before the upstream reaches 001 the
// controller's `Session.send_join` returns `:no_session` → 404. Both
// networks carry a `connection_state: :connected` DB row (that gate
// passed) while the upstream is still mid-register, so a bare joinChannel
// races the register. Retry on 404 until the JOIN sticks (same
// poll-until-ready discipline the park/reconnect specs use for autojoin).
async function joinChannelWhenReady(
  token: string,
  slug: string,
  channel: string,
): Promise<void> {
  let last = "";
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${GRAPPA_BASE_URL}/networks/${slug}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: channel }),
    });
    if (res.ok) return;
    last = `${res.status} ${await res.text()}`;
    // 404 = session not registered yet (`:no_session`); keep polling.
    // Any other status is a real error — surface it immediately.
    if (res.status !== 404) {
      throw new Error(`joinChannelWhenReady: ${slug}/${channel} → ${last}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `joinChannelWhenReady: ${slug}/${channel} never became joinable (last: ${last})`,
  );
}

test("issue #211 phase 7 — one visitor on TWO networks survives a real cic WS drop and reappears LIVE on BOTH", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  // Distinct channel per network so each members list is isolated to its
  // own network.
  const anchorChannel = `#p7a-${stamp}`;
  const secondChannel = `#p7b-${stamp}`;
  // A DISTINCT per-network nick for azzurra2 — set via the phase-7
  // `PATCH /networks/:id/identity` door on the LIVE session. It proves
  // identity is per-`(subject, network)`: azzurra keeps the minted nick,
  // azzurra2 gets its own, and both stay live because they are TWO
  // SEPARATE ircds (azzurra → bahamut-test, azzurra2 → the standalone
  // bahamut-test2, independent nick namespaces — see compose.yaml).
  const secondNick = `p7b${stamp % 100000}`;

  let visitor: Awaited<ReturnType<typeof mintVisitor>> | null = null;
  let ctx: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  const peers: IrcPeer[] = [];

  try {
    // ── SETUP: two live upstreams for ONE visitor on TWO SEPARATE ircds ──
    //
    // azzurra and azzurra2 are DIFFERENT IRC networks: azzurra dials the
    // azzurra-testnet leaf (`bahamut-test`), azzurra2 dials a standalone
    // second ircd (`bahamut-test2`) with its OWN nick namespace. Because
    // they share no S2S link, one visitor can hold a LIVE session on BOTH
    // simultaneously with NO 433 collision — which is exactly what makes
    // this a real two-network reconnect proof (and sidesteps the
    // shared-leaf autokill: a same-nick collision on ONE ircd would 433 →
    // respawn-flood → bahamut bans the source IP network-wide).

    // 1. Mint the visitor → anchor azzurra auto-connects under `anchorNick`.
    visitor = await mintVisitor(`p7-${stamp}`);
    expect(visitor.network_slug).toBe(ANCHOR);
    const anchorNick = visitor.nick;
    await waitForNetworkState(visitor.token, ANCHOR, "connected");
    await assertAlive(visitor.token, "after-anchor-connected");

    // 2. Accrete azzurra2 → dials the SEPARATE ircd. The copied nick can't
    //    collide (different namespace), so it registers cleanly and goes
    //    live. Two live upstreams, one visitor, two networks.
    const addRes = await fetch(`${GRAPPA_BASE_URL}/session/networks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${visitor.token}` },
      body: JSON.stringify({ network: SECOND }),
    });
    expect(addRes.status).toBe(204);
    await waitForNetworkState(visitor.token, SECOND, "connected");
    await assertAlive(visitor.token, "after-accrete-azzurra2");

    // 3. Give azzurra2 a DISTINCT per-network nick via the phase-7 identity
    //    door on the LIVE session (SpawnOrchestrator.reconnect bounce). This
    //    is the phase-7 headline: identity is per-`(subject, network)`, so
    //    the same visitor now presents DIFFERENT nicks on its two networks.
    await setNetworkNick(visitor.token, SECOND, secondNick);
    await waitForNetworkState(visitor.token, SECOND, "connected");
    await assertAlive(visitor.token, "after-rename-azzurra2");

    // JOIN a channel on each network (REST) so both have a live window with
    // the visitor's own nick in members. `waitForOwnNickInMembers` is the
    // REAL liveness gate: it only passes once the upstream is fully
    // registered AND the JOIN completed.
    await joinChannelWhenReady(visitor.token, ANCHOR, anchorChannel);
    await joinChannelWhenReady(visitor.token, SECOND, secondChannel);
    await waitForOwnNickInMembers(visitor.token, ANCHOR, anchorChannel, anchorNick);
    await waitForOwnNickInMembers(visitor.token, SECOND, secondChannel, secondNick);

    // Now that BOTH sessions are fully registered, confirm the two
    // per-network nicks really differ (the phase-7 per-network identity is
    // live, not a false pass where azzurra2 kept the anchor nick).
    // `/networks` reports the LIVE session nick, trustworthy only
    // post-registration — hence AFTER the members gate.
    const nets = await getNetworks(visitor.token);
    const anchorRow = nets.find((n) => n.slug === ANCHOR);
    const secondRow = nets.find((n) => n.slug === SECOND);
    expect(anchorRow?.connection_state).toBe("connected");
    expect(secondRow?.connection_state).toBe("connected");
    expect(anchorRow?.nick).toBe(anchorNick);
    expect(secondRow?.nick).toBe(secondNick);
    expect(anchorRow?.nick).not.toBe(secondRow?.nick);

    // ── BROWSER: boot cic, subscribe both channels, then drop the WS ──

    const booted = await bootVisitor(browser, visitor);
    ctx = booted.ctx;
    const page = booted.page;
    await waitForUserTopicReady(page, `visitor:${visitor.id}`);

    // Focus each channel once so cic renders a row and its per-channel
    // topic enters `joined` (the backfill cursor `lastSeenIdByKey`
    // requires at least one rendered row per key to resume from). cic
    // subscribes EVERY joined channel across BOTH networks from the
    // channels-loop, so after focusing both, both keys are in `joined`.
    await selectChannel(page, ANCHOR, anchorChannel, { ownNick: anchorNick });
    await expect(
      page.locator(".shell-members .members-pane .member-name", { hasText: anchorNick }),
    ).toBeVisible({ timeout: 15_000 });
    await selectChannel(page, SECOND, secondChannel, { ownNick: secondNick });
    await expect(
      page.locator(".shell-members .members-pane .member-name", { hasText: secondNick }),
    ).toBeVisible({ timeout: 15_000 });

    // Baseline: a live PRIVMSG on each network BEFORE the drop, so the
    // backfill cursor (lastSeenIdByKey) is set on both per-channel keys.
    const anchorPeer = await IrcPeer.connect({ nick: `pa7-${stamp % 100000}` });
    peers.push(anchorPeer);
    await anchorPeer.join(anchorChannel);
    // The azzurra2 peer must dial the SEPARATE ircd (`bahamut-test2`) — a
    // peer on the azzurra leaf would speak into a DIFFERENT nick namespace
    // and the visitor's azzurra2 session (on bahamut-test2) would never
    // see it. The docker alias `bahamut-test2` is reachable from the runner
    // on the shared grappa-e2e bridge (see compose.yaml).
    const secondPeer = await IrcPeer.connect({
      nick: `pb7-${stamp % 100000}`,
      host: "bahamut-test2",
    });
    peers.push(secondPeer);
    await secondPeer.join(secondChannel);

    const anchorBefore = `p7-anchor-before-${stamp}`;
    const secondBefore = `p7-second-before-${stamp}`;
    anchorPeer.privmsg(anchorChannel, anchorBefore);
    secondPeer.privmsg(secondChannel, secondBefore);
    // The second channel is the focused one; assert its baseline renders.
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]', {
        hasText: secondBefore,
      }),
    ).toBeVisible({ timeout: 20_000 });

    // ── THE DROP: hold cic's socket down; peers speak on BOTH networks ──

    await page.evaluate(async () => {
      if (!window.__cic_dropSocketForTests) {
        throw new Error("__cic_dropSocketForTests hook missing");
      }
      await window.__cic_dropSocketForTests();
    });
    await page.waitForFunction(
      () => window.__cic_socketHealth?.state().state !== "open",
    );

    // Peers send a PRIVMSG on EACH network while cic is confirmed
    // disconnected. Both are persisted server-side (Session.Server persist
    // is synchronous) and broadcast on their per-channel topics with no
    // live cic subscriber → dropped from the live stream. Only the DB rows
    // remain — the multi-network gap the reconnect backfill must heal.
    const anchorGap = `p7-anchor-gap-${stamp}`;
    const secondGap = `p7-second-gap-${stamp}`;
    anchorPeer.privmsg(anchorChannel, anchorGap);
    secondPeer.privmsg(secondChannel, secondGap);

    // Server-side truth: both gap messages persisted (independent of cic).
    await assertMessagePersisted({
      token: visitor.token,
      networkSlug: ANCHOR,
      channel: anchorChannel,
      sender: anchorPeer.nick,
      body: anchorGap,
      kind: "privmsg",
      timeoutMs: 15_000,
    });
    await assertMessagePersisted({
      token: visitor.token,
      networkSlug: SECOND,
      channel: secondChannel,
      sender: secondPeer.nick,
      body: secondGap,
      kind: "privmsg",
      timeoutMs: 15_000,
    });

    // ── RESUME: reconnect the socket; both networks must heal ──

    await page.evaluate(async () => {
      if (!window.__cic_resumeSocketForTests) {
        throw new Error("__cic_resumeSocketForTests hook missing");
      }
      await window.__cic_resumeSocketForTests();
    });

    // HEADLINE — the gap PRIVMSG appears in scrollback on BOTH networks
    // WITHOUT a page refresh. The socket-open effect fires
    // `refreshScrollback` for every `joined` key, so both per-channel
    // backfills fetch `?after=<lastSeenId>` and append via the same
    // appendToScrollback verb the live handler uses. Assert the focused
    // (second) network first — it is already rendered — then switch to the
    // anchor and assert its gap row backfilled too.
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]', {
        hasText: secondGap,
      }),
    ).toBeVisible({ timeout: 30_000 });

    await selectChannel(page, ANCHOR, anchorChannel, { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]', {
        hasText: anchorGap,
      }),
    ).toBeVisible({ timeout: 30_000 });

    // HEADLINE — own nick is LIVE in members on BOTH networks after the
    // reconnect (per feedback_e2e_visitor_members_list). Anchor is
    // focused now; assert its members, then switch to second and assert
    // its members. Distinct nicks prove the two independent live sessions
    // both survived the drop.
    await expect(
      page.locator(".shell-members .members-pane .member-name", { hasText: anchorNick }),
    ).toBeVisible({ timeout: 20_000 });
    await selectChannel(page, SECOND, secondChannel, { awaitWsReady: false });
    await expect(
      page.locator(".shell-members .members-pane .member-name", { hasText: secondNick }),
    ).toBeVisible({ timeout: 20_000 });

    // HEADLINE — a live PRIVMSG round-trips on BOTH networks AFTER the
    // reconnect (not just backfill — the live stream itself recovered).
    const anchorAfter = `p7-anchor-after-${stamp}`;
    const secondAfter = `p7-second-after-${stamp}`;
    anchorPeer.privmsg(anchorChannel, anchorAfter);
    secondPeer.privmsg(secondChannel, secondAfter);
    // Second is focused; assert its live row, then switch to anchor.
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]', {
        hasText: secondAfter,
      }),
    ).toBeVisible({ timeout: 20_000 });
    await selectChannel(page, ANCHOR, anchorChannel, { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]', {
        hasText: anchorAfter,
      }),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    for (const peer of peers) await peer.disconnect("e2e cleanup").catch(() => {});
    if (ctx) await ctx.close();
    if (visitor) await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});

declare global {
  interface Window {
    __cic_dropSocketForTests?: () => Promise<void>;
    __cic_resumeSocketForTests?: () => Promise<void>;
    __cic_socketHealth?: {
      state: () => { state: string };
    };
  }
}
