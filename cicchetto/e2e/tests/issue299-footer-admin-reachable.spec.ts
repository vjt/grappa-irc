// #299 item 6 → superseded by #332 — footer admin reachable WITH the #75
// themes launcher present.
//
// History: #75 added a 🎨 themes launcher to the mobile drawer footer,
// taking it to FIVE buttons (home / archive / settings / themes / admin).
// On narrow devices the fifth button overflowed and clipped the
// high-frequency admin launcher off-screen (vjt 2026-07-18 dogfood). #299
// (Opt A) fixed the clip by REMOVING the themes launcher. #332 (P0, vjt)
// reversed that trade: the themes launcher is RESTORED, and the overflow is
// now handled the right way — `flex-wrap` on `.mobile-panel-actions`
// (default.css) wraps a 5th button to a new row instead of clipping admin.
//
// So the invariant this spec guards — "admin stays reachable" — is
// unchanged; only the mechanism flipped (button-removal → flex-wrap). It
// drives the real mobile layout (@webkit / iPhone 15) and proves:
//   (a) the footer holds FIVE buttons with the themes launcher PRESENT,
//   (b) admin is present, ≥44px, and TAPPABLE (renders the AdminPane — i.e.
//       not clipped off-screen even with the 5th button back), and
//   (c) themes is still reachable via the cog → themes nav row.
// The themes launcher's own deep-link behaviour is owned by the issue332
// spec; here it's just the 5th button that must not strand admin.
//
// vjt (admin-by-seed can drift under the shared stack) is explicitly
// promoted to admin for the admin-launcher assertions, then reverted in
// afterEach so the shared baseline is restored (mirrors #291).

import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
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

async function openMobileFooter(page: import("@playwright/test").Page) {
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

test.describe("#299 — footer admin reachable (themes launcher removed)", () => {
  let vjtUserId: string;

  test.beforeAll(async () => {
    vjtUserId = await findVjtUserId(getSeededAdmin().token);
  });

  test.afterEach(async () => {
    await setAdminFlag(getSeededAdmin().token, vjtUserId, false);
  });

  test("@webkit footer holds themes launcher; admin still present, ≥44px, and tappable", async ({
    page,
  }) => {
    await setAdminFlag(getSeededAdmin().token, vjtUserId, true);
    await loginAs(page, getSeededVjt());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    const drawer = await openMobileFooter(page);
    const footer = drawer.locator(".mobile-panel-actions");
    await expect(footer).toBeVisible();

    // #332 restored the themes launcher; the footer is FIVE buttons and the
    // row `flex-wrap`s so the 5th doesn't clip admin (the #299 regression
    // this spec still guards, now via wrap instead of removal).
    await expect(footer.locator("[data-testid='mobile-panel-themes']")).toHaveCount(1);
    await expect(footer.locator(".shell-chrome-btn")).toHaveCount(5);

    // Admin is present AND a proper ≥44px tap target (not clipped off-screen).
    const adminBtn = footer.locator("[data-testid='mobile-panel-admin']");
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
    // Themes is not admin-gated — base vjt reaches it. Proves the removed
    // footer launcher didn't strand the themes sub-page.
    await loginAs(page, getSeededVjt());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    const drawer = await openMobileFooter(page);
    // Cog closes the members drawer (mutex) + opens the settings drawer on
    // its "main" page, which hosts the themes nav row.
    await drawer.locator("[data-testid='mobile-panel-settings']").tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    // #299 item 3 — the legacy auto/mirc-light/irssi-dark radio selector is
    // gone from the settings main page (superseded by the gallery).
    await expect(page.getByLabel(/mirc light/i)).toHaveCount(0);
    await expect(page.getByLabel(/irssi dark/i)).toHaveCount(0);
    await page.getByTestId("themes-settings-entry").tap();
    await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
  });
});
