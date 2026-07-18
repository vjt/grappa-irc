// #299 item 6 (Opt A) — footer admin reachable after removing the #75
// themes launcher.
//
// #75 added a 🎨 themes launcher to the mobile drawer footer, taking it to
// FIVE buttons (home / archive / settings / themes / admin). On narrow
// devices the fifth button overflowed and clipped the high-frequency admin
// launcher off-screen (vjt 2026-07-18 dogfood). The themes launcher was
// pure redundancy — it only ever deep-linked to the settings drawer's themes
// sub-page, which is already reachable from the cog. Opt A removes it.
//
// This spec drives the real mobile layout (@webkit / iPhone 15) and proves:
//   (a) the footer is back to FOUR buttons with the themes launcher ABSENT,
//   (b) admin is present, ≥44px, and TAPPABLE (renders the AdminPane — i.e.
//       not clipped off-screen), and
//   (c) themes is still reachable via the cog → themes nav row.
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

  test("@webkit footer drops themes launcher; admin present, ≥44px, and tappable", async ({
    page,
  }) => {
    await setAdminFlag(getSeededAdmin().token, vjtUserId, true);
    await loginAs(page, getSeededVjt());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    const drawer = await openMobileFooter(page);
    const footer = drawer.locator(".mobile-panel-actions");
    await expect(footer).toBeVisible();

    // The themes launcher is GONE; the footer is back to FOUR buttons.
    await expect(footer.locator("[data-testid='mobile-panel-themes']")).toHaveCount(0);
    await expect(footer.locator(".shell-chrome-btn")).toHaveCount(4);

    // Admin is present AND a proper ≥44px tap target (not clipped off-screen).
    const adminBtn = footer.locator("[data-testid='mobile-panel-admin']");
    await expect(adminBtn).toHaveCount(1);
    const box = await adminBtn.boundingBox();
    if (box === null) throw new Error("admin launcher has no bounding box");
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);

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
