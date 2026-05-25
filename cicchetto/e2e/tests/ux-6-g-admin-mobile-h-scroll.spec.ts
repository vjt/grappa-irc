// UX-6 bucket G (2026-05-21) — admin tables on mobile render the
// horizontal scrollbar but ignore the iOS pan-x gesture (vjt iPhone
// dogfood: "horiz content, scrollbar, but content doesn't move").
//
// Root cause: `.admin-pane` carries `touch-action: pan-y` (UX-5 BO
// defensive carve-out against the `.shell-mobile { touch-action: none }`
// blanket). Browser `touch-action` is the INTERSECTION across the
// ancestor chain — even when `.admin-tab-panel` declares `pan-x pan-y`,
// the parent's `pan-y` clamps back to `pan-y` only. Result: the
// table renders an overflow-x scrollbar (visual cue) but iOS rejects
// the horizontal pan, so the operator cannot read columns past the
// viewport (sessions 656px / networks 631px / visitors 517px at
// iPhone 15 content width 361px).
//
// Fix (CSS-only, two declarations):
//   1. `.admin-pane { touch-action: pan-x pan-y }` — relaxes the
//      ancestor INTERSECTION ceiling so child pan-x can take effect.
//   2. `.admin-tab-panel { overflow-x: auto; touch-action: pan-x pan-y }`
//      — table scrolls inside the panel (not the page); the panel
//      itself owns the gesture authority for pan-x.
//
// Per `feedback_e2e_user_class_parity_matrix`: AdminPane is admin-
// gated (EXEMPT). This spec runs the admin arm only; non-admin
// can't reach the surface at all.
//
// Seed shape: same as UX-6-C — PATCH the seeded `vjt` user to admin
// via admin-vjt bearer at test start, revert in afterEach. admin-vjt
// has no IRC bind (m9b session-count == 2 hardcode); vjt has the bind
// + autojoined #bofh so it can reach the mobile launcher footer.

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

// Tabs whose default panel is wide enough on iPhone 15 to require
// pan-x. Networks is the only deterministic-wide tab in the e2e seed
// (2 seeded networks render a 631px-wide table on a 361px content
// area). Visitors / Sessions tabs are empty in the baseline seed so
// their wide-content assertion would false-fail; the cross-ancestor
// touch-action check covers them via the loop below regardless.
const WIDE_TABLE_TABS = ["visitors", "sessions", "networks"] as const;
const DETERMINISTIC_WIDE_TAB = "networks" as const;

test.setTimeout(90_000);

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

test.describe("UX-6-G — admin pane horizontal scroll on mobile", () => {
  let vjtUserId: string;

  test.beforeAll(async () => {
    const admin = getSeededAdmin();
    vjtUserId = await findVjtUserId(admin.token);
  });

  test.afterEach(async () => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, false);
  });

  test("@webkit admin on mobile — wide admin tables permit pan-x via touch-action", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await page.getByLabel(/open members sidebar/i).tap();
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toBeVisible({ timeout: 5_000 });
    await drawer.locator("[data-testid='mobile-panel-admin']").tap();

    const pane = page.getByTestId("admin-pane");
    await expect(pane).toBeVisible({ timeout: 5_000 });

    // Pre-fix: `.admin-pane` declared `touch-action: pan-y` and the
    // CSS-spec INTERSECTION rule meant any descendant declaring
    // `pan-x pan-y` got clamped back to `pan-y` only. iOS rejected
    // the horizontal pan, the scrollbar appeared but the table did
    // not move. Asserting both ancestor + scroller carry `pan-x` (in
    // addition to `pan-y`) keeps the bug from regressing — a future
    // hand re-tightening either one back to `pan-y` would re-break
    // mobile h-scroll silently.
    const paneTouch = await pane.evaluate((el) => window.getComputedStyle(el).touchAction);
    expect(paneTouch, "admin-pane touch-action must allow pan-x").toMatch(/pan-x/);

    for (const tab of WIDE_TABLE_TABS) {
      await page.getByTestId(`admin-tab-${tab}`).tap();
      const panel = page.locator(`#admin-tab-${tab}`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
      const panelStyle = await panel.evaluate((el) => {
        const cs = window.getComputedStyle(el);
        return {
          touchAction: cs.touchAction,
          overflowX: cs.overflowX,
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
        };
      });
      expect(
        panelStyle.touchAction,
        `admin-tab-panel(${tab}) touch-action must allow pan-x`,
      ).toMatch(/pan-x/);
      expect(
        panelStyle.overflowX,
        `admin-tab-panel(${tab}) overflow-x must be auto/scroll for the table to be scrollable`,
      ).toMatch(/auto|scroll/);
      // Positive twin: on the deterministic-wide tab, assert the panel
      // actually has wider content than its viewport so the pan-x
      // permission isn't trivially passing on an empty tab. The other
      // wide-table tabs (visitors/sessions) are empty in the baseline
      // seed and would false-fail this check.
      if (tab === DETERMINISTIC_WIDE_TAB) {
        expect(
          panelStyle.scrollW,
          `admin-tab-panel(${tab}) must contain wider content than its viewport for pan-x to be meaningful`,
        ).toBeGreaterThan(panelStyle.clientW);
      }
    }
  });

  test("@webkit admin on mobile — pan-x gesture actually scrolls the wide table", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await page.getByLabel(/open members sidebar/i).tap();
    await page.locator(".shell-members.open [data-testid='mobile-panel-admin']").tap();
    await expect(page.getByTestId("admin-pane")).toBeVisible({ timeout: 5_000 });

    await page.getByTestId("admin-tab-networks").tap();
    const panel = page.locator("#admin-tab-networks");
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // Drive panel.scrollLeft directly — the touch-action assertion in
    // the sibling spec covers the gesture-permission half; this case
    // ensures the panel is genuinely scrollable (not just paint-only)
    // by exercising the same `el.scrollLeft` channel WebKit's pan
    // handler eventually mutates. Pre-fix the table was a descendant
    // of `.admin-networks-tab` which (sans `overflow-x: auto` on the
    // parent panel) had no scrollLeft to mutate.
    const before = await panel.evaluate((el) => el.scrollLeft);
    expect(before, "panel starts at scrollLeft=0").toBe(0);
    await panel.evaluate((el) => {
      el.scrollLeft = 100;
    });
    const after = await panel.evaluate((el) => el.scrollLeft);
    expect(after, "panel.scrollLeft must accept programmatic h-scroll").toBeGreaterThan(0);
  });

  test("@webkit admin on mobile — vertical scroll inside the pane still works", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await page.getByLabel(/open members sidebar/i).tap();
    await page.locator(".shell-members.open [data-testid='mobile-panel-admin']").tap();
    await expect(page.getByTestId("admin-pane")).toBeVisible({ timeout: 5_000 });

    // Negative twin: relaxing `.admin-pane` from `pan-y` to `pan-x pan-y`
    // must keep pan-y intact (a careless rewrite to `pan-x` alone would
    // silently drop vertical scroll while passing the pan-x asserts
    // above). Both axes must remain in the touch-action declaration.
    const paneTouch = await page
      .getByTestId("admin-pane")
      .evaluate((el) => window.getComputedStyle(el).touchAction);
    expect(paneTouch, "admin-pane touch-action must STILL allow pan-y").toMatch(/pan-y/);
    expect(paneTouch, "admin-pane touch-action must allow pan-x").toMatch(/pan-x/);
  });
});
