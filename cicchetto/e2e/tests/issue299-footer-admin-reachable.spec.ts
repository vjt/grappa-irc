// #299 item 6 → #332 → #473 — admin reachable from the rail actions drawer,
// with every launcher present.
//
// History: #75 added a 🎨 themes launcher to the mobile drawer footer, taking
// it to five buttons; on narrow devices the fifth overflowed and clipped the
// high-frequency admin launcher off-screen (vjt 2026-07-18 dogfood). #299
// removed themes to fix the clip; #332 restored it and switched the footer to
// `flex-wrap` so overflow wrapped instead of clipping. #473 retired that
// mobile-only `.mobile-panel-actions` footer entirely: every affordance now
// lives in ONE `.rail-actions` drawer at the bottom of `.shell-members`, a flex
// COLUMN on both desktop and mobile — rows stack, so the clip-vs-wrap problem
// this spec was born from cannot recur.
//
// The invariant this spec guards — "admin stays reachable" — is unchanged. It
// drives the real mobile layout (@webkit / iPhone 15) and proves:
//   (a) the themes launcher — the one that caused the clip — is PRESENT,
//   (b) admin is present, ≥44px, and TAPPABLE (renders the AdminPane), and
//   (c) themes is still reachable via the cog → themes nav row.
// The themes launcher's own deep-link behaviour is owned by the issue332 spec;
// here it's just one of the rail buttons that must not strand admin.
//
// vjt (admin-by-seed can drift under the shared stack) is explicitly promoted
// to admin for the admin-launcher assertions, then reverted in afterEach so the
// shared baseline is restored (mirrors #291).

import { loginAs, openRailMenu, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import {
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
  VJT_USER,
} from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const GRAPPA_BASE_URL = "http://grappa-test:4000";
const MIN_TAP_TARGET_PX = 44;

test.setTimeout(60_000);

async function findVjtUserId(adminToken: string): Promise<string> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`GET /admin/users → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { users: { id: string; name: string }[] };
  const vjt = body.users.find((u) => u.name === VJT_USER);
  if (!vjt) {
    throw new Error(`vjt user not found in admin users list: ${JSON.stringify(body)}`);
  }
  return vjt.id;
}

async function setAdminFlag(adminToken: string, userId: string, isAdmin: boolean): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ is_admin: isAdmin }),
  });
  if (!res.ok) {
    throw new Error(
      `PATCH /admin/users/${userId} is_admin=${isAdmin} → ${res.status} ${await res.text()}`,
    );
  }
}

// Open the mobile members/rail drawer via the TopicBar hamburger (present on
// the channel windows these tests drive) and return the drawer locator so
// callers can scope to the `.rail-actions` cluster inside it.
async function openRailDrawer(page: import("@playwright/test").Page) {
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

test.describe("#299 — admin reachable from the rail actions drawer", () => {
  let vjtUserId: string;

  test.beforeAll(async () => {
    vjtUserId = await findVjtUserId(getSeededAdmin().token);
  });

  test.afterEach(async () => {
    await setAdminFlag(getSeededAdmin().token, vjtUserId, false);
  });

  test("@webkit rail holds themes launcher; admin still present, ≥44px, and tappable", async ({
    page,
  }) => {
    await setAdminFlag(getSeededAdmin().token, vjtUserId, true);
    await loginAs(page, getSeededVjt());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    const drawer = await openRailDrawer(page);
    const rail = drawer.locator(".rail-actions");
    await expect(rail).toBeVisible();

    // #500 — the launchers collapsed behind ONE launcher button; open the menu
    // before reaching any rail affordance. The buttons live in
    // `.rail-actions-menu`, in the DOM only after the launcher is tapped.
    await openRailMenu(page);
    const railMenu = page.locator(".rail-actions-menu");

    // #473/#500 — every launcher lives in the ONE `.rail-actions-menu`. The
    // themes launcher is PRESENT (its clip-vs-wrap history is moot now the rail
    // is a flex column) and it does NOT strand admin — the whole subject of
    // this spec. The settings cog folded into the rail with the
    // `action-cluster-cog` testid (no `mobile-panel-settings` button ever
    // existed). The exhaustive "these and no others" total lives in issue473,
    // which owns it: pinned here too it made THIS spec red for #986's detach +
    // quit, an arrival that cannot strand anything.
    await expect(railMenu.locator("[data-testid='mobile-panel-themes']")).toHaveCount(1);
    await expect(railMenu.locator("[data-testid='action-cluster-cog']")).toHaveCount(1);

    // Admin is present AND a proper ≥44px tap target.
    const adminBtn = railMenu.locator("[data-testid='mobile-panel-admin']");
    await expect(adminBtn).toHaveCount(1);
    const box = await adminBtn.boundingBox();
    if (box === null) throw new Error("admin launcher has no bounding box");
    // Round: webkit returns sub-pixel fractional widths (e.g. 43.99997 for a
    // 44px min box) — assert the rounded tap target, not the raw float.
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);

    // Reachable end-to-end: tap admin → members drawer closes (mutex) and the
    // AdminPane renders.
    await adminBtn.tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId("admin-pane")).toBeVisible({ timeout: 5_000 });
  });

  test("@webkit themes still reachable via the cog → themes nav row", async ({ page }) => {
    // Themes is not admin-gated — base vjt reaches it. Proves the rail's cog →
    // themes nav row reaches the themes sub-page (no launcher stranded it).
    await loginAs(page, getSeededVjt());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await openRailDrawer(page);
    // #500 — the cog lives behind the rail launcher menu now; open it first.
    await openRailMenu(page);
    // #473 — the cog lives in the `.rail-actions-menu`. Tapping it closes the
    // members drawer (mutex) + opens the settings drawer on its "main" page,
    // which hosts the themes nav row.
    await page.locator(".rail-actions-menu [data-testid='action-cluster-cog']").tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    // #299 item 3 — the legacy auto/mirc-light/irssi-dark radio selector is
    // gone from the settings main page (superseded by the gallery).
    await expect(page.getByLabel(/mirc light/i)).toHaveCount(0);
    await expect(page.getByLabel(/irssi dark/i)).toHaveCount(0);
    await page.getByTestId("themes-settings-entry").tap();
    await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
  });
});
