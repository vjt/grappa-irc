// #211 phase 3 — HEADLINE e2e: the fresh-visitor → JOINED-channel →
// live-PRIVMSG chain, end-to-end, through the READ-CUTOVER.
//
// This is the phase's flagship proof. Before phase 3 NO single spec
// exercised the WHOLE visitor connect chain at once; the pieces
// (provision, SessionPlan.resolve, spawn, upstream connect, JOIN,
// members seed, live message) were covered piecemeal. This spec drives
// a FRESH visitor (minted this run, not the seeded vjt) all the way:
//
//   login  →  provision (+ the phase-3 write-through Credential)
//          →  Visitors.SessionPlan.resolve READS the Credential (cutover)
//          →  Bootstrap/spawn  →  upstream IRC connect on the
//             visitor_enabled "azzurra" network
//          →  /join a channel  →  lands JOINED
//          →  members list includes the visitor's OWN nick
//             (per feedback_e2e_visitor_members_list)
//          →  a peer sends a real PRIVMSG that flows to the visitor's
//             scrollback on the wire.
//
// Plus two allowlist assertions:
//   * a visitor CANNOT attach a non-visitor_enabled network (the gate).
//   * the admin visitor_enabled toggle flips a network live (no restart)
//     and a visitor can then log into the just-enabled network.
//
// Runs on chromium desktop (members pane renders directly in
// `.shell-members .members-pane`, no mobile drawer).

import type { Browser, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test";
import { composeSend, selectChannel, waitForUserTopicReady } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import {
  adminDeleteVisitor,
  GRAPPA_BASE_URL,
  mintVisitor,
  type MintedVisitor,
} from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

const VISITOR_NETWORK = "azzurra";

// Full chain + testnet latency + a peer round-trip — well past 30s.
test.setTimeout(90_000);

async function bootVisitor(
  browser: Browser,
  visitor: MintedVisitor,
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
      JSON.stringify({
        kind: "visitor",
        id: visitor.id,
        nick: visitor.nick,
        network_slug: visitor.network_slug,
      }),
    ] as const,
  );
  await page.goto("/");
  await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });
  return { ctx, page };
}

test("issue #211 phase 3 — fresh visitor lands JOINED with own nick + a live PRIVMSG (full read-cutover chain)", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const channel = `#p3-${stamp}`;

  // A FRESH visitor — provisioned this run. The login round-trips the
  // WHOLE chain: provision writes the visitor row AND (phase-3
  // write-through) its (visitor_id, network_id) Credential; the spawn's
  // SessionPlan.resolve READS that Credential. mintVisitor sends no
  // `network`, so login defaults to the sole visitor_enabled network
  // ("azzurra", seeded enabled in compose.yaml).
  const visitor = await mintVisitor(`p3-${stamp}`);
  expect(visitor.network_slug).toBe(VISITOR_NETWORK);

  const { ctx, page } = await bootVisitor(browser, visitor);
  let peer: IrcPeer | null = null;

  try {
    // Upstream session is connected: the $server window shows the
    // registration numerics (same connection gate as issue187/153/154).
    await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 30_000 });

    await waitForUserTopicReady(page, `visitor:${visitor.id}`);

    // JOIN a channel and focus it → the visitor lands JOINED. selectChannel
    // with `ownNick` waits for the members-seeded state for the visitor.
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 20_000 });
    await selectChannel(page, visitor.network_slug, channel, { ownNick: visitor.nick });

    // HEADLINE 1 — the members list includes the visitor's OWN nick
    // (feedback_e2e_visitor_members_list). This proves the JOIN completed
    // AND the 353/366 seed reached the freshly-provisioned visitor's
    // per-channel topic — the whole spawn+connect+join chain worked.
    const membersPane = page.locator(".shell-members .members-pane");
    await expect(membersPane).toBeVisible({ timeout: 10_000 });
    await expect(membersPane.locator(".member-name", { hasText: visitor.nick })).toBeVisible({
      timeout: 15_000,
    });
    await expect(membersPane.locator("p.muted", { hasText: "loading" })).toHaveCount(0);

    // HEADLINE 2 — a real PRIVMSG on the wire reaches the visitor's
    // scrollback. A peer joins the same channel and speaks; the visitor's
    // upstream session (spawned off the read-cutover Credential) delivers
    // the line into scrollback.
    peer = await IrcPeer.connect({ nick: `peer-p3-${stamp % 100000}` });
    await peer.join(channel);
    await expect(
      membersPane.locator(".member-name", { hasText: peer.nick }),
    ).toBeVisible({ timeout: 15_000 });

    const wireMsg = `phase3-live-${stamp}`;
    peer.privmsg(channel, wireMsg);

    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]', {
        hasText: wireMsg,
      }),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    if (peer) await peer.disconnect("e2e cleanup").catch(() => {});
    await ctx.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});

test("issue #211 phase 3 — a visitor CANNOT attach a non-visitor_enabled network (allowlist gate)", async () => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const slug = `p3-off-${stamp}`;

  // Create a network that is NOT visitor_enabled (admin create defaults
  // visitor_enabled=false). A visitor login naming it must be refused by
  // the runtime allowlist gate with 403 network_not_visitor_enabled.
  const createRes = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ slug }),
  });
  expect(createRes.status).toBe(201);
  const networkId = (await createRes.json()).id as number;

  try {
    const res = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: `gate-${stamp}`, network: slug }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("network_not_visitor_enabled");
  } finally {
    // The network has no visitor credential (login was refused), so the
    // delete guard passes. DELETE keys on the integer id (router:
    // `/admin/networks/:id`), not the slug.
    await fetch(`${GRAPPA_BASE_URL}/admin/networks/${networkId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${admin.token}` },
    }).catch(() => {});
  }
});

test("issue #211 phase 3 — admin visitor_enabled toggle flips a network live (no restart)", async () => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const slug = `p3-toggle-${stamp}`;
  let visitorId: string | null = null;

  // Off by default → a targeted login is refused.
  const createRes = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ slug }),
  });
  expect(createRes.status).toBe(201);
  const networkId = (await createRes.json()).id as number;

  try {
    const before = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: `tog-${stamp}`, network: slug }),
    });
    expect(before.status).toBe(403);

    // Flip visitor_enabled ON via the admin PATCH — no restart.
    const patchRes = await fetch(`${GRAPPA_BASE_URL}/admin/networks/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ visitor_enabled: true }),
    });
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).visitor_enabled).toBe(true);

    // The allowlist now admits the network. (No server bound on this
    // network → the flow reaches SessionPlan and fails :no_server, which
    // is a 502 upstream_unreachable — NOT the 403 gate. That the gate is
    // gone is the proof the toggle took effect at request time.)
    const after = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: `tog-${stamp}`, network: slug }),
    });
    expect(after.status).not.toBe(403);
    // Best-effort: capture the visitor id if one was provisioned before
    // the spawn failed, so teardown can drop it + its credential.
    if (after.ok) {
      visitorId = (await after.json())?.subject?.id ?? null;
    }
  } finally {
    if (visitorId) await adminDeleteVisitor(admin.token, visitorId).catch(() => {});
    // Disable again so the network has no visitor credential blocking the
    // delete, then remove it (DELETE keys on the integer id).
    await fetch(`${GRAPPA_BASE_URL}/admin/networks/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ visitor_enabled: false }),
    }).catch(() => {});
    await fetch(`${GRAPPA_BASE_URL}/admin/networks/${networkId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${admin.token}` },
    }).catch(() => {});
  }
});
