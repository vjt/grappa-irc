// #221 — solanum-node integration proof. The azzurra2 network runs SOLANUM
// (the ircd Libera.Chat runs) since #221, so this drives grappa's WHOIS /
// WHO parser against the REAL Libera-shaped upstream, not a bahamut mock.
//
// What this proves that the bahamut fixture cannot:
//   - gap (c): a masked `/who <mask>` round-trips through solanum, whose
//     352 RPL_WHOREPLY sets the channel field to "*" for a mask
//     (modules/m_who.c:507) — the exact wire shape that broke grappa's
//     channel-keyed correlation pre-#221. The WhoModal appearing with the
//     peer's row proves the single-in-flight who_fold fix works against
//     the real ircd.
//   - gap (b): the visitor reaching a LIVE session on solanum at all proves
//     the on-connect usermode parse handles solanum's usermode table (a
//     bahamut-letter assumption would not have crashed the connect, but the
//     221/self-MODE fold is exercised on every connect regardless — see
//     event_router_test #221 for the letter-level characterization).
//
// The gap-(a) solanum WHOIS extras (330/671/276) require a TLS peer +
// services (account) which this plaintext, services-less CI node does not
// provide, so those folds are proven at the unit boundary
// (event_router_test.exs #221) rather than forced here — the solanum node's
// value for gap (a) is the numeric ROUTING (delegation, no misroute), which
// the mask-WHO + whois-card round-trip on the real ircd exercises.
//
// Runs on chromium desktop (members pane renders directly). Visitor bootstrap
// mirrors issue211-phase6-matrix / phase7 (azzurra2 accretion via
// POST /session/networks), so it shares their per-IP-budget discipline.

import type { Browser, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { composeSend, selectChannel, waitForUserTopicReady } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { adminDeleteVisitor, GRAPPA_BASE_URL, joinChannel, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

// A visitor connect on solanum + a peer round-trip + a WHO/WHOIS pair —
// give it testnet-latency headroom (matches the phase-6 matrix budget).
test.setTimeout(120_000);

// The solanum node carries the `bahamut-test2` docker-network alias (#221
// kept it so the azzurra2 seed resolves unchanged), so peers dial it by
// that name — the SECOND network's ircd, distinct from the shared leaf.
const SOLANUM_HOST = "bahamut-test2";
const SECOND = "azzurra2";

async function waitForNetworks(token: string, n: number): Promise<Array<{ slug: string }>> {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const rows = (await res.json()) as Array<{ slug: string }>;
      if (rows.length >= n) return rows;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForNetworks: never reached ${n} networks`);
}

// Resolve the per-network nick for `slug` (#211 phase 7 — a visitor's nick
// is per-(subject, network), on the GET /networks rows, not the subject).
async function nickForNetwork(token: string, slug: string): Promise<string> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`nickForNetwork: GET /networks → ${res.status}`);
  const rows = (await res.json()) as Array<{ slug: string; nick: string }>;
  const row = rows.find((r) => r.slug === slug);
  if (!row) throw new Error(`nickForNetwork: ${slug} not attached`);
  return row.nick;
}

async function bootVisitor(
  browser: Browser,
  visitor: { id: string },
): Promise<{ ctx: Awaited<ReturnType<Browser["newContext"]>>; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await waitForUserTopicReady(page, `visitor:${visitor.id}`);
  return { ctx, page };
}

test("#221 — /who <mask> round-trips through the solanum node (352 channel='*')", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const channel = `#sol-${stamp}`;
  let visitor: Awaited<ReturnType<typeof mintVisitor>> | null = null;
  let ctx: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  const peers: IrcPeer[] = [];

  try {
    visitor = await mintVisitor(`sol221-${stamp % 1000000}`);

    // Default seed autoconnects only azzurra; accrete azzurra2 (solanum) so
    // there is a LIVE solanum session to drive the WHO through.
    await waitForNetworks(visitor.token, 1);
    const addRes = await fetch(`${GRAPPA_BASE_URL}/session/networks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${visitor.token}` },
      body: JSON.stringify({ network: SECOND }),
    });
    expect(addRes.ok).toBe(true);
    await waitForNetworks(visitor.token, 2);

    // The solanum (azzurra2) per-network nick — may differ from the anchor.
    const solNick = await nickForNetwork(visitor.token, SECOND);

    const booted = await bootVisitor(browser, visitor);
    ctx = booted.ctx;
    const page = booted.page;

    // JOIN a channel on the solanum network + focus it.
    await joinChannel(visitor.token, SECOND, channel);
    await selectChannel(page, SECOND, channel, { ownNick: solNick });

    const membersPane = page.locator(".shell-members .members-pane");
    await expect(membersPane.locator(".member-name", { hasText: solNick })).toBeVisible({
      timeout: 20_000,
    });

    // A peer on the SAME solanum node (dialed by the bahamut-test2 alias),
    // joined to the same channel so the mask matches + it is reachable.
    const peerNick = `solpeer-${stamp % 100000}`;
    const peer = await IrcPeer.connect({ nick: peerNick, host: SOLANUM_HOST });
    peers.push(peer);
    await peer.join(channel);

    // A nick-mask WHO against the real solanum ircd. solanum answers 352
    // with the channel field "*" for a mask + 315 echoing the mask — the
    // exact shape that produced pre-#221 silence. The WhoModal appearing
    // with the peer's row is the end-to-end proof on the real ircd.
    await composeSend(page, `/who ${peerNick}*`);

    const modal = page.getByTestId("who-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal.locator(".who-modal-row", { hasText: peerNick })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    for (const peer of peers) await peer.disconnect("#221 solanum done").catch(() => {});
    if (ctx) await ctx.close();
    if (visitor) await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
