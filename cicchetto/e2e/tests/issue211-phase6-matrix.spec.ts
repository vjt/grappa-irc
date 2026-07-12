// #211 phase 6 — HEADLINE e2e: the two-parallel-azzurra-testnet matrix.
//
// vjt (caps his): "ALL OF THIS MUST FUCKING BE TESTED END TO END BY
// STARTING TWO FUCKING AZZURRA TESTNETS IN PARALLEL AND TESTING ALL THE
// FUCKING CASES!" — the seeder (compose.yaml) flags TWO visitor_enabled +
// visitor_autoconnect networks (azzurra + azzurra2, same bahamut-test
// leaf) plus a THIRD visitor_enabled-but-not-autoconnect network
// (azzurra3, the on-demand AVAILABLE tier). This spec drives the
// multi-network visitor matrix through the real testnet:
//
//   * fresh visitor login AUTO-CONNECTS BOTH autoconnect networks
//     (both live, own nick in members on BOTH, live PRIVMSG on BOTH);
//   * per-network DISCONNECT (park) azzurra → azzurra greyed, azzurra2
//     stays live; per-network RECONNECT azzurra → live again;
//   * anon visitor one-tap CONNECTS the available (non-autoconnect)
//     azzurra3 from the home page → live.
//
// The reboot-persistence case ("park A → reboot container → A still
// parked") + the per-network-identity peer-witness case are covered by
// the server-side test suite (bootstrap_test "PARKED visitor credential
// is NOT respawned"; networks_controller_test identity) — a container
// reboot is out of the Playwright harness's control; the DONE comment
// notes the split.
//
// Runs on chromium desktop (members pane renders directly).

import type { Browser, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test";
import { composeSend, selectChannel, waitForUserTopicReady } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { adminDeleteVisitor, GRAPPA_BASE_URL, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

// Two full connect chains + a peer round-trip on each network — well
// past the default; give it plenty of testnet-latency headroom.
test.setTimeout(120_000);

async function bootVisitor(
  browser: Browser,
  visitor: { id: string; nick: string; token: string },
): Promise<{ ctx: Awaited<ReturnType<Browser["newContext"]>>; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [
      visitor.token,
      // #211 phase 6 — the subject wire has NO network_slug (multi-network).
      JSON.stringify({ kind: "visitor", id: visitor.id, nick: visitor.nick }),
    ] as const,
  );
  await page.goto("/");
  await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });
  return { ctx, page };
}

// Poll GET /networks until it lists at least `n` rows (the async
// autoconnect fan-out settles after the sync anchor connect).
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

test("issue #211 phase 6 — fresh visitor AUTO-CONNECTS both azzurra + azzurra2 (live on BOTH)", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const channel = `#p6-${stamp}`;
  const visitor = await mintVisitor(`p6auto-${stamp}`);

  // The anchor (sync) network is azzurra (first by id); azzurra2 attaches
  // async. Both are visitor_autoconnect in the seed.
  const nets = await waitForNetworks(visitor.token, 2);
  const slugs = nets.map((n) => n.slug).sort();
  expect(slugs).toContain("azzurra");
  expect(slugs).toContain("azzurra2");

  const { ctx, page } = await bootVisitor(browser, visitor);
  const peers: IrcPeer[] = [];

  try {
    await waitForUserTopicReady(page, `visitor:${visitor.id}`);

    // Prove BOTH networks are live end-to-end: JOIN the same channel on
    // each, own nick in members, a peer PRIVMSG lands.
    for (const slug of ["azzurra", "azzurra2"]) {
      await selectChannel(page, slug, "Server", { awaitWsReady: false });
      await expect(
        page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
      ).toBeVisible({ timeout: 30_000 });

      await composeSend(page, `/join ${channel}`);
      await selectChannel(page, slug, channel, { ownNick: visitor.nick });

      const membersPane = page.locator(".shell-members .members-pane");
      await expect(membersPane.locator(".member-name", { hasText: visitor.nick })).toBeVisible({
        timeout: 15_000,
      });

      const peer = await IrcPeer.connect({ nick: `pp6-${slug}-${stamp % 100000}` });
      peers.push(peer);
      await peer.join(channel);
      const wireMsg = `p6-${slug}-${stamp}`;
      peer.privmsg(channel, wireMsg);
      await expect(
        page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]', { hasText: wireMsg }),
      ).toBeVisible({ timeout: 20_000 });
    }
  } finally {
    for (const peer of peers) await peer.disconnect("e2e cleanup").catch(() => {});
    await ctx.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});

test("issue #211 phase 6 — per-network park azzurra keeps azzurra2 live; reconnect restores azzurra", async () => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const visitor = await mintVisitor(`p6park-${stamp}`);

  try {
    await waitForNetworks(visitor.token, 2);

    // Park azzurra via the subject-agnostic PATCH /networks/:id (ruling D).
    const parkRes = await fetch(`${GRAPPA_BASE_URL}/networks/azzurra`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${visitor.token}` },
      body: JSON.stringify({ connection_state: "parked", reason: "matrix" }),
    });
    expect(parkRes.status).toBe(200);
    expect((await parkRes.json()).connection_state).toBe("parked");

    // azzurra is parked; azzurra2 stays connected — GET /networks reflects it.
    const rows = (await (
      await fetch(`${GRAPPA_BASE_URL}/networks`, {
        headers: { authorization: `Bearer ${visitor.token}` },
      })
    ).json()) as Array<{ slug: string; connection_state: string }>;
    const azzurra = rows.find((r) => r.slug === "azzurra");
    const azzurra2 = rows.find((r) => r.slug === "azzurra2");
    expect(azzurra?.connection_state).toBe("parked");
    expect(azzurra2?.connection_state).toBe("connected");

    // Reconnect azzurra → connected again.
    const connRes = await fetch(`${GRAPPA_BASE_URL}/networks/azzurra`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${visitor.token}` },
      body: JSON.stringify({ connection_state: "connected" }),
    });
    expect(connRes.status).toBe(200);
    expect((await connRes.json()).connection_state).toBe("connected");
  } finally {
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});

test("issue #211 phase 6 — visitor one-tap connects the AVAILABLE (non-autoconnect) azzurra3", async () => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const visitor = await mintVisitor(`p6avail-${stamp}`);

  try {
    await waitForNetworks(visitor.token, 2);

    // azzurra3 is visitor_enabled but NOT autoconnect → not attached at
    // login. It appears in /me's home_data.available_networks.
    const me = (await (
      await fetch(`${GRAPPA_BASE_URL}/me`, {
        headers: { authorization: `Bearer ${visitor.token}` },
      })
    ).json()) as { home_data: { available_networks: Array<{ slug: string }> } };
    const availSlugs = me.home_data.available_networks.map((n) => n.slug);
    expect(availSlugs).toContain("azzurra3");

    // One-tap connect (accretion) — anon-allowed (ruling C follow-up 2).
    const addRes = await fetch(`${GRAPPA_BASE_URL}/session/networks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${visitor.token}` },
      body: JSON.stringify({ network: "azzurra3" }),
    });
    expect(addRes.status).toBe(204);

    // azzurra3 now attached + connected.
    const rows = await waitForNetworks(visitor.token, 3);
    expect(rows.map((r) => r.slug)).toContain("azzurra3");
  } finally {
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
