// #291 — home launcher (return to the home window) in the rail actions drawer.
//
// On the mobile narrow layout there was no way back to the home window
// (desktop has the sidebar home link). #291 added a 🏠 launcher alongside the
// other window-nav / own-signal launchers, and enlarged every launcher to a
// ≥44px tap target.
//
// #473 folded EVERY rail affordance into ONE `.rail-actions` drawer at the
// bottom of `.shell-members` — present on BOTH desktop and mobile and on
// EVERY window kind. It supersedes the retired mobile-only
// `.mobile-panel-actions` footer AND the post-#71 top ActionCluster: the
// settings cog + denoise toggle now live in the rail too. Each keeps its
// testid (the $list launcher is labelled "rooms" but keeps
// `mobile-panel-list`; the cog keeps `action-cluster-cog`).
//
// This spec drives the real mobile layout (@webkit / iPhone 15): open the
// drawer, assert the home launcher is present with its sibling launchers,
// assert each is a ≥44px tap target, tap home and assert the drawer closes and
// the HOME window renders. The full button set needs the admin launcher, so
// vjt is temporarily promoted to admin (mirrors ux-6-c-mobile-admin-launcher),
// then reverted in afterEach so the shared stack baseline is restored.

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

test.describe("#291 — home launcher in the rail actions drawer", () => {
  let vjtUserId: string;

  test.beforeAll(async () => {
    const admin = getSeededAdmin();
    vjtUserId = await findVjtUserId(admin.token);
  });

  test.afterEach(async () => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, false);
  });

  test("@webkit home launcher: all rail buttons ≥44px, tap returns to home", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    // Open the mobile hamburger → members drawer (hosts the rail).
    await page.getByLabel(/open members sidebar/i).tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    const rail = drawer.locator(".rail-actions");
    await expect(rail).toBeVisible();

    // #500 — the rail affordances collapsed behind ONE launcher; reveal the menu
    // (openRailMenu sees the drawer is already open and just taps the launcher).
    // The buttons live inside `.rail-actions-menu` now, so scope every query to
    // it.
    await openRailMenu(page);
    const menu = drawer.locator(".rail-actions-menu");
    await expect(menu).toBeVisible();

    // #473 — every rail affordance folded into the ONE `.rail-actions` drawer:
    // the window-nav launchers (home / rooms / admin), the own-signal launchers
    // (themes / archive), the settings cog (was the #71 top ActionCluster) and
    // the channel-gated denoise toggle. An admin on a channel window sees the
    // full set. testids are unchanged — the 📇 $list launcher keeps
    // `mobile-panel-list` (labelled "rooms" now; opens the directory, covered
    // by issue361), themes deep-links the settings themes sub-page (covered by
    // issue332), and the cog keeps `action-cluster-cog`.
    await expect(menu.locator("[data-testid='mobile-panel-home']")).toHaveCount(1);
    await expect(menu.locator("[data-testid='mobile-panel-list']")).toHaveCount(1);
    await expect(menu.locator("[data-testid='mobile-panel-archive']")).toHaveCount(1);
    await expect(menu.locator("[data-testid='mobile-panel-themes']")).toHaveCount(1);
    await expect(menu.locator("[data-testid='mobile-panel-admin']")).toHaveCount(1);
    // #473 — the settings cog folded INTO the rail (was a separate top
    // ActionCluster post-#71); it's now one of the rail buttons.
    await expect(menu.locator("[data-testid='action-cluster-cog']")).toHaveCount(1);
    // #473 — denoise (presence toggle) is channel-gated and shows on this
    // channel window (it too folded into the rail).
    await expect(menu.locator("[data-testid='presence-toggle']")).toHaveCount(1);

    // Every launcher is a proper mobile tap target (≥44px, #291) — the actual
    // #291 contract. This sweeps whatever the menu renders rather than pinning
    // a total: the exhaustive "these buttons and no others" set is owned by
    // issue473 ("rail hosts every labelled button"), and a total duplicated
    // here reddened this spec the moment #986 added detach + quit, neither of
    // which #291 has anything to say about. It cannot pass vacuously — the
    // seven testids above are each asserted present in this same `menu`.
    // #500 — scope to `.rail-actions-menu`: the pinned launcher ALSO carries
    // `.shell-chrome-btn` but lives OUTSIDE the menu.
    const buttons = menu.locator(".shell-chrome-btn");
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      if (box === null) throw new Error(`launcher ${i} has no bounding box`);
      // #339 — round to the CSS pixel the design targets. WebKit's
      // boundingBox() can return a sub-pixel value (43.99998 = 44 − ~1.5e-5)
      // on the iPhone-15 device-scale-factor, which a bare `>= 44` flakes on.
      // Math.round tolerates ONLY that ±0.5px rounding band — a genuinely
      // short tap-target (< 43.5) still fails. Matches the house pattern
      // (issue299 / issue361).
      expect(Math.round(box.width)).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
      expect(Math.round(box.height)).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    }

    // Tap home → drawer closes (mutex) + the HOME window renders.
    await menu.locator("[data-testid='mobile-panel-home']").tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator(".home-pane-registered").first()).toBeVisible({ timeout: 5_000 });
  });
});
