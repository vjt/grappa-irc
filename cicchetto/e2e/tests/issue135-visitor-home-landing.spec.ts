// Issue #135 (P0) — visitor home pane = welcome + featured + directory link.
//
// #211 phase 6 — the visitor home is now the SAME data-driven component as
// the user's (ruling A): welcome copy for visitors + per-network rows
// (each connected network renders its featured list + a "📇 Browse
// channels" button). The pre-phase-6 static `home-visitor-browse` control
// is gone — browse is now the per-network ConnectedRow button. This spec
// tracks that.
//
// What this proves, end-to-end, as a VISITOR landing on the home pane:
//   1. The welcome / orientation copy renders (shared with the unit).
//   2. The featured-channels list renders for the visitor's network
//      (operator-seeded via the admin REST path — the real #85 surface).
//   3. Clicking the network row's "📇 Browse channels" deep-links into the
//      #84 DirectoryPane ($list window).
//
// Seeding: featured channels added via the admin REST path, removed in
// `finally`. Network id resolved by slug from GET /admin/networks.

import { test, expect } from "../fixtures/test";
import { adminDeleteVisitor, GRAPPA_BASE_URL, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

// Unique per run: avoids featured-list bleed across retries / parallel
// runs on the shared seeded network. crypto.randomUUID() is available in
// the Node.js e2e context (mirrors channel-directory.spec.ts).
const FEATURED_NAME = `#e2e135-${crypto.randomUUID().slice(0, 8)}`;

async function resolveNetworkId(adminToken: string, slug: string): Promise<number> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) throw new Error(`resolveNetworkId: GET /admin/networks → ${res.status}`);
  const body = (await res.json()) as { networks: Array<{ id: number; slug: string }> };
  const row = body.networks.find((n) => n.slug === slug);
  if (!row) throw new Error(`resolveNetworkId: no network with slug ${slug}`);
  return row.id;
}

async function addFeatured(
  adminToken: string,
  networkId: number,
  name: string,
): Promise<number> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks/${networkId}/featured_channels`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name, description: "visitor landing featured" }),
  });
  if (!res.ok) throw new Error(`addFeatured: ${name} → ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: number }).id;
}

async function deleteFeaturedBestEffort(
  adminToken: string,
  networkId: number,
  featuredId: number,
): Promise<void> {
  try {
    await fetch(
      `${GRAPPA_BASE_URL}/admin/networks/${networkId}/featured_channels/${featuredId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } },
    );
  } catch {
    // best-effort teardown
  }
}

test("issue #135 — visitor home shows welcome + featured + a directory link", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`home135-${Date.now()}`);
  const networkId = await resolveNetworkId(admin.token, visitor.network_slug);
  const featuredId = await addFeatured(admin.token, networkId, FEATURED_NAME);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    const visitorSubject = {
      kind: "visitor",
      id: visitor.id,
      nick: visitor.nick,
    };

    // Seed the visitor bearer + subject so cic boots straight into Shell
    // (no captcha/anon dance), then auto-lands on the home pane.
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [visitor.token, JSON.stringify(visitorSubject)] as const,
    );
    await page.goto("/");
    await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });

    // (1) Welcome / orientation copy — stable phrase shared with the unit.
    await expect(page.getByText(/always-on IRC bouncer/i)).toBeVisible({ timeout: 10_000 });

    // (2) Featured-channels list for the visitor's network. The <ul>
    // testid renders inside the connected network's row (phase 6 — the
    // per-network ConnectedRow renders FeaturedLinks).
    await expect(page.getByTestId(`home-featured-${visitor.network_slug}`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(FEATURED_NAME)).toBeVisible({ timeout: 10_000 });

    // (3) The network row's "📇 Browse channels" deep-links into
    // DirectoryPane ($list). Scope to the visitor's network row (there may
    // be multiple connected networks since phase-6 autoconnect).
    await page
      .locator(".home-pane-network-row")
      .filter({ hasText: visitor.network_slug })
      .getByRole("button", { name: /browse channels/i })
      .first()
      .click();
    await expect(page.locator(".directory-search")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".directory-refresh")).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctx.close();
    await deleteFeaturedBestEffort(admin.token, networkId, featuredId);
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
