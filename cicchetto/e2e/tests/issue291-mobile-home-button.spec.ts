// #291 — mobile home button in the hamburger drawer footer.
//
// On the mobile narrow layout there was no way back to the home window
// (desktop has the sidebar home link). This adds a 🏠 launcher to the
// `.mobile-panel-actions` footer, LEFT-aligned, alongside archive /
// settings / admin — and enlarges ALL those launchers to ≥44px tap
// targets. (#299 removed the #75 themes launcher from this footer — five
// buttons overflowed on narrow devices and clipped admin. #332 (P0, vjt)
// RESTORED the 🎨 themes launcher: the footer is back to FIVE — home /
// archive / settings / themes / admin — and the overflow is now handled
// by `flex-wrap` on `.mobile-panel-actions` instead of dropping a button,
// so admin no longer clips. This spec's launcher-count assertions moved
// from 4 to 5 with that restoration.)
//
// This spec drives the real mobile layout (@webkit / iPhone 15): open
// the hamburger, assert all 5 launchers are present and each ≥44px, tap
// home and assert the drawer closes and the HOME window renders. The
// 5-launcher count needs the admin button present, so vjt is temporarily
// promoted to admin (mirrors ux-6-c-mobile-admin-launcher), then reverted
// in afterEach so the shared stack baseline is restored.

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

test.describe("#291 — mobile home button in drawer footer", () => {
  let vjtUserId: string;

  test.beforeAll(async () => {
    const admin = getSeededAdmin();
    vjtUserId = await findVjtUserId(admin.token);
  });

  test.afterEach(async () => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, false);
  });

  test("@webkit home launcher: all footer buttons ≥44px, tap returns to home", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    // Open the mobile hamburger → members drawer (hosts the footer).
    await page.getByLabel(/open members sidebar/i).tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    const launcherFooter = drawer.locator(".mobile-panel-actions");
    await expect(launcherFooter).toBeVisible();

    // All launchers present. #332 RESTORED the #75 themes button, so an
    // admin in a channel sees FIVE: home (#291), archive, settings, themes
    // (#332), admin. The themes launcher deep-links to the settings
    // drawer's themes sub-page (covered by issue332 spec).
    await expect(launcherFooter.locator("[data-testid='mobile-panel-home']")).toHaveCount(1);
    await expect(launcherFooter.locator("[data-testid='mobile-panel-archive']")).toHaveCount(1);
    await expect(launcherFooter.locator("[data-testid='mobile-panel-settings']")).toHaveCount(1);
    await expect(launcherFooter.locator("[data-testid='mobile-panel-themes']")).toHaveCount(1);
    await expect(launcherFooter.locator("[data-testid='mobile-panel-admin']")).toHaveCount(1);

    // Every launcher is a proper mobile tap target (≥44px, #291).
    const buttons = launcherFooter.locator(".shell-chrome-btn");
    await expect(buttons).toHaveCount(5);
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      if (box === null) throw new Error(`launcher ${i} has no bounding box`);
      expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
      expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    }

    // Tap home → drawer closes (mutex) + the HOME window renders.
    await launcherFooter.locator("[data-testid='mobile-panel-home']").tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator(".home-pane-registered").first()).toBeVisible({ timeout: 5_000 });
  });
});
