// Issue #135 (P0) — visitor home pane = welcome + featured + directory link.
//
// What this spec proves, end-to-end, as a VISITOR landing on the home
// pane (the auto-selected window on cold load for every identity):
//   1. The static welcome / orientation copy renders (a stable phrase the
//      HomePane.test.tsx unit also pins — keep them in sync).
//   2. The featured-channels list renders for the visitor's single
//      network (operator-seeded via the admin REST path, mirroring
//      featured-channels.spec.ts, so this asserts the real #85 display
//      surface, not a stub).
//   3. The NEW wiring: clicking "📇 Browse channels" deep-links into the
//      #84 DirectoryPane ($list window). Pre-#135 the visitor pane had no
//      such affordance — the `home-visitor-browse` control does not exist,
//      so this step is RED before the HomePane change and green after.
//
// The directory link mirrors ConnectedRow.onBrowse EXACTLY (a kind:"list"
// selection), so the DirectoryPane mount is the same one channel-
// directory.spec.ts exercises — we assert its immediate `.directory-search`
// box (renders outside the LIST-data <Show>, so no async round-trip).
//
// Seeding: featured channels are added to the visitor's network via the
// admin REST path and removed in `finally`. The network id is resolved by
// slug from GET /admin/networks (the e2e seeder is single-network, id 1,
// but resolving by slug keeps this robust to seed changes). A unique
// channel name per run avoids cross-run / cross-spec bleed.

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
      network_slug: visitor.network_slug,
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
    // testid renders only when the operator-seeded list is non-empty.
    await expect(page.getByTestId(`home-featured-${visitor.network_slug}`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(FEATURED_NAME)).toBeVisible({ timeout: 10_000 });

    // (3) NEW wiring — the directory link deep-links into DirectoryPane.
    await page.getByTestId("home-visitor-browse").click();
    await expect(page.locator(".directory-search")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".directory-refresh")).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctx.close();
    await deleteFeaturedBestEffort(admin.token, networkId, featuredId);
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
