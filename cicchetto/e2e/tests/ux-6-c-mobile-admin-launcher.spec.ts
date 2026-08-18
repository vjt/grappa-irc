// UX-6 bucket C (2026-05-21) → #473 — admin launcher button in the rail
// actions drawer (vjt iPhone-dogfood Bug 3).
//
// UX-6-C added an admin launcher gated on `isAdmin()`, mirroring the Sidebar
// admin row gate (single source of truth shared with the SettingsDrawer admin
// entry). Tap dispatches selection-driven navigation to the $admin window —
// same handler shape as the Sidebar admin row.
//
// #473 folded every rail affordance into ONE `.rail-actions` drawer at the
// bottom of `.shell-members`, present on BOTH desktop and mobile and on EVERY
// window kind. The admin launcher keeps its `mobile-panel-admin` testid and its
// `isAdmin()` gate. Crucially the DESKTOP rail — which pre-#473 had only a cog
// and the denoise monkey — now hosts the SAME window-nav launchers (including
// admin) as mobile, so the old "desktop has no launcher footer" premise is
// dead (see the desktop test below).
//
// Three-class parity matrix per `feedback_e2e_user_class_parity_matrix`:
// admin-gated is the EXEMPT shape — only ONE class (admin user) sees the
// surface. The spec still asserts the OPPOSITE polarity for the non-admin case
// so a future is_admin gate regression can't silently reveal the admin
// launcher to non-admins.
//
// Seed shape: this spec promotes the seeded `vjt` user to admin via
// `PATCH /admin/users/:id` (using the seeded admin-vjt bearer token) at test
// start, then reverts in afterEach. Reason: admin-vjt has no network bind in
// the seeder (intentional — m9b-admin-sessions-actions hardcodes session count
// = 2 and would break if admin-vjt had a bind). vjt has the bind + autojoined
// #bofh; promoting it temporarily gives the full surface (admin gate + joined
// channel + rail drawer) without ripple-affecting other specs.

import { loginAs, openRailMenu, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { findUserIdByName, GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
test.setTimeout(60_000);

async function setAdminFlag(adminToken: string, userId: string, isAdmin: boolean): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ is_admin: isAdmin }),
  });
  if (!res.ok) {
    throw new Error(
      `PATCH /admin/users/${userId} is_admin=${isAdmin} → ${res.status} ${await res.text()}`,
    );
  }
}

test.describe("UX-6-C / #473 — admin launcher in the rail actions drawer", () => {
  let vjtUserId: string;

  // beforeEACH, not beforeAll: the subject is per-test (#1078), so its
  // user id has to be resolved per test — a once-per-file lookup would
  // hold the id of a user that no longer exists.
  test.beforeEach(async () => {
    const admin = getSeededAdmin();
    vjtUserId = await findUserIdByName(admin.token, specUser().name);
  });

  test.afterEach(async () => {
    // Always revert vjt to non-admin so other specs in the suite
    // continue to see the seeded baseline. AfterEach (not afterAll)
    // so a failing promote arm doesn't leak admin state into the
    // next test inside this file either.
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, false);
  });

  test("@webkit admin on mobile — rail actions drawer hosts admin button; tap opens AdminPane", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    // Tap mobile hamburger (TopicBar right edge) → drawer opens.
    await page.getByLabel(/open members sidebar/i).tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    // #500 — the rail affordances collapsed behind ONE launcher; the buttons
    // live in `.rail-actions-menu`, in the DOM only after the launcher is
    // tapped. Open it before reaching any rail button.
    await openRailMenu(page);

    // #473/#500 — the `.rail-actions-menu` hosts the admin button alongside the
    // settings cog + archive (the cog folded into the rail here, was the #71
    // top ActionCluster). Order doesn't matter, just presence. No
    // `mobile-panel-settings` button ever existed — the cog is
    // `action-cluster-cog`.
    const rail = drawer.locator(".rail-actions");
    await expect(rail).toBeVisible();
    const railMenu = page.locator(".rail-actions-menu");
    await expect(railMenu.locator("[data-testid='action-cluster-cog']")).toHaveCount(1);
    await expect(railMenu.locator("[data-testid='mobile-panel-archive']")).toHaveCount(1);
    await expect(railMenu.locator("[data-testid='mobile-panel-admin']")).toHaveCount(1);

    // Tap admin launcher → drawer closes (mutex with settings/archive),
    // AdminPane mounts. Selection-driven: Shell's
    // `<Show when={sel.kind === "admin" && isAdmin()}>` flips true
    // when the click handler calls setSelectedChannel with
    // $admin/$admin/admin.
    await railMenu.locator("[data-testid='mobile-panel-admin']").tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    const pane = page.getByTestId("admin-pane");
    await expect(pane).toBeVisible({ timeout: 5_000 });
    await expect(pane.getByRole("heading", { name: /admin console/i })).toBeVisible();
  });

  test("@webkit non-admin on mobile — rail actions drawer hides the admin button", async ({
    page,
  }) => {
    // No promote: vjt stays non-admin for this arm. Per the gate
    // contract, the admin launcher must be absent from the DOM
    // (Show gate unmounts the button when isAdmin() === false).
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await page.getByLabel(/open members sidebar/i).tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    // #500 — the admin button (and its absence) only exists inside
    // `.rail-actions-menu` after the launcher is tapped; open the menu first,
    // or the absence assertion would pass trivially with the menu closed.
    await openRailMenu(page);

    const rail = drawer.locator(".rail-actions");
    await expect(rail).toBeVisible();
    const railMenu = page.locator(".rail-actions-menu");
    // Positive twin so a testid typo can't silently green both halves of the
    // gate. #473 — the always-present settings cog lives in the rail menu; use
    // it as the positive twin (proves the menu rendered AND is OPEN) while the
    // admin button is absent for a non-admin.
    await expect(railMenu.locator("[data-testid='action-cluster-cog']")).toHaveCount(1);
    await expect(railMenu.locator("[data-testid='mobile-panel-admin']")).toHaveCount(0);
  });

  test("desktop admin — members rail hosts the RailActions admin button (retired mobile footer is gone)", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    // #473 — the rail actions drawer is PERMANENT on every window kind and on
    // BOTH form factors, so the desktop members rail now hosts the SAME
    // RailActions launchers as mobile — including the isAdmin()-gated admin
    // button the desktop rail never had before ("a cog and a monkey"). This
    // repurposes the old dead premise (which asserted desktop had NO launcher
    // footer, hence no admin button there): assert the rail IS present and the
    // admin button lives in it on desktop.
    await expect(page.locator(".shell-members .rail-actions")).toBeVisible();
    // #500 — the launchers collapsed behind ONE launcher button; open the menu
    // (on desktop the rail is always on screen, so this taps the launcher
    // directly) before reaching the admin button.
    await openRailMenu(page);
    await expect(page.locator(".rail-actions-menu [data-testid='mobile-panel-admin']")).toHaveCount(
      1,
    );
    // The retired mobile-only `.mobile-panel-actions` footer is gone entirely —
    // guard that the migration left no stray footer anywhere.
    await expect(page.locator(".mobile-panel-actions")).toHaveCount(0);
    // The Sidebar admin row is still the desktop sidebar affordance (unchanged
    // by #473) — confirm it's present (positive twin) so both desktop admin
    // doors are covered.
    await expect(page.getByTestId("sidebar-admin-row")).toBeVisible();
  });
});
