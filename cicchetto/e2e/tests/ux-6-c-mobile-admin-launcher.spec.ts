// UX-6 bucket C (2026-05-21) — admin launcher button in the mobile
// drawer footer (vjt iPhone-dogfood Bug 3).
//
// Pre-bucket the mobile launcher footer (UX-5 BM) hosted only the
// settings cog + archive button. Admins on mobile had to open the
// LEFT sidebar drawer (BottomBar hamburger left) and scroll to the
// 🔧 sidebar admin row to reach AdminPane — one extra step over
// desktop's single sidebar click. Bucket adds a 4th launcher button
// gated on `isAdmin()`, mirroring the Sidebar admin row gate
// (single source of truth shared with SettingsDrawer admin entry).
// Tap dispatches selection-driven navigation to the $admin window
// — same handler shape as Sidebar admin row.
//
// Three-class parity matrix per `feedback_e2e_user_class_parity_matrix`:
// admin-gated is the EXEMPT shape — only ONE class (admin user) sees
// the surface. The spec still asserts the OPPOSITE polarity for the
// non-admin case so a future is_admin gate regression can't silently
// reveal the admin launcher to non-admins.
//
// Seed shape: this spec promotes the seeded `vjt` user to admin via
// `PATCH /admin/users/:id` (using the seeded admin-vjt bearer token)
// at test start, then reverts in afterAll. Reason: admin-vjt has no
// network bind in the seeder (intentional — m9b-admin-sessions-actions
// hardcodes session count = 2 and would break if admin-vjt had a
// bind). vjt has the bind + autojoined #bofh; promoting it
// temporarily gives the full surface (admin gate + joined channel +
// drawer hamburger) without ripple-affecting other specs.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import {
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
  VJT_USER,
} from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const GRAPPA_BASE_URL = "http://grappa-test:4000";

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

async function setAdminFlag(
  adminToken: string,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
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

test.describe("UX-6-C — admin launcher in mobile drawer footer", () => {
  let vjtUserId: string;

  test.beforeAll(async () => {
    const admin = getSeededAdmin();
    vjtUserId = await findVjtUserId(admin.token);
  });

  test.afterEach(async () => {
    // Always revert vjt to non-admin so other specs in the suite
    // continue to see the seeded baseline. AfterEach (not afterAll)
    // so a failing promote arm doesn't leak admin state into the
    // next test inside this file either.
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, false);
  });

  test("@webkit admin on mobile — drawer launcher footer hosts admin button; tap opens AdminPane", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    // Tap mobile hamburger (TopicBar right edge) → drawer opens.
    await page.getByLabel(/open members sidebar/i).tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    // BM launcher footer has the new admin button alongside settings +
    // archive. Order doesn't matter, just presence.
    const launcherFooter = drawer.locator(".mobile-panel-actions");
    await expect(launcherFooter).toBeVisible();
    await expect(launcherFooter.locator("[data-testid='mobile-panel-settings']")).toHaveCount(1);
    await expect(launcherFooter.locator("[data-testid='mobile-panel-archive']")).toHaveCount(1);
    await expect(launcherFooter.locator("[data-testid='mobile-panel-admin']")).toHaveCount(1);

    // Tap admin launcher → drawer closes (mutex with settings/archive),
    // AdminPane mounts. Selection-driven: Shell's
    // `<Show when={sel.kind === "admin" && isAdmin()}>` flips true
    // when the click handler calls setSelectedChannel with
    // $admin/$admin/admin.
    await launcherFooter.locator("[data-testid='mobile-panel-admin']").tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    const pane = page.getByTestId("admin-pane");
    await expect(pane).toBeVisible({ timeout: 5_000 });
    await expect(pane.getByRole("heading", { name: /admin console/i })).toBeVisible();
  });

  test("@webkit non-admin on mobile — drawer launcher footer hides the admin button", async ({
    page,
  }) => {
    // No promote: vjt stays non-admin for this arm. Per the gate
    // contract, the admin launcher must be absent from the DOM
    // (Show gate unmounts the button when isAdmin() === false).
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await page.getByLabel(/open members sidebar/i).tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    const launcherFooter = drawer.locator(".mobile-panel-actions");
    await expect(launcherFooter).toBeVisible();
    // Positive twin so a testid typo can't silently green both
    // halves of the gate.
    await expect(launcherFooter.locator("[data-testid='mobile-panel-settings']")).toHaveCount(1);
    await expect(launcherFooter.locator("[data-testid='mobile-panel-admin']")).toHaveCount(0);
  });

  test("desktop admin — members aside has NO launcher footer, so no admin button there either", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Desktop: BM launcher footer is mobile-only — the whole footer
    // is absent. Admin entry on desktop lives on the Sidebar admin
    // row (UX-4 bucket N) + SettingsDrawer admin entry (M-7); no
    // launcher button.
    await expect(page.locator(".shell-members .mobile-panel-actions")).toHaveCount(0);
    await expect(page.locator("[data-testid='mobile-panel-admin']")).toHaveCount(0);
    // Sidebar admin row is the desktop affordance — confirm it's
    // present (positive twin) so the gate is genuinely active.
    await expect(page.getByTestId("sidebar-admin-row")).toBeVisible();
  });
});
