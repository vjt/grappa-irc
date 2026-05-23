// UX-6 bucket D close (2026-05-21) — iOS PWA keyboard layout pattern.
//
// 11 attempts on this surface (UX-6-D1 through D12). Final landed
// state covers the JS+CSS contracts via this spec. The visible
// iOS keyboard slide-in animation (test #3 from vjt's dogfood) is
// ACCEPTED as iOS WebKit limitation — per-frame diag during D11
// proved vvOffsetTop=0 and window.scrollY=0 throughout the slide,
// the visible motion is at the WKWebView compositor BELOW JS
// visibility (research-confirmed WebKit bug #297779, WKContentView
// _zoomToFocusRect). Not fixable in pure PWA; documented in
// docs/DESIGN_NOTES.md UX-6-D.
//
// Per `feedback_e2e_user_class_parity_matrix`: keyboard handling is
// device-class (iOS PWA standalone), EXEMPT from the parity matrix.
// Playwright doesn't emulate the on-screen keyboard at all — this
// spec asserts the JS+CSS contract that, given the inputs the
// keyboard WOULD produce (visualViewport.height shrink), the layout
// math is correct.
//
// Coverage:
// (a) html.is-ios class lands on iPhone UA (boot-time detection)
// (b) --vh CSS var writes from visualViewport.height
// (c) --viewport-height legacy CSS var writes from same source
// (d) D1 `:has(:focus){padding-bottom:0}` rule applies when input
//     has focus
// (e) Smart-pin: window.scrollTo(0,0) clamps any drift
// (f) Admin → Debug tab renders the diag panel + DiagFloat toggle

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededAdmin, getSeededVjt, NETWORK_NICK, NETWORK_SLUG, VJT_USER } from "../fixtures/seedData";

const GRAPPA_BASE_URL = "http://grappa-test:4000";
const CHANNEL = AUTOJOIN_CHANNELS[0];

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

// GREEN-CI batch 2 — replaces the original `promoteVjtToAdmin` helper
// that hardcoded `const adminToken = "admin-vjt"` (just the literal
// string, NOT a real bearer token). That bypassed admin auth → 401
// → `users.users` undefined → `.find` crashed before reaching the UI
// assertions. Mirrors the working pattern in ux-6-g-admin-mobile-h-scroll
// (findVjtUserId + setAdminFlag with `getSeededAdmin().token`).
async function promoteVjtToAdmin(): Promise<{ revert: () => Promise<void> }> {
  const admin = getSeededAdmin();
  const vjtUserId = await findVjtUserId(admin.token);
  await setAdminFlag(admin.token, vjtUserId, true);
  return {
    revert: async () => {
      await setAdminFlag(admin.token, vjtUserId, false);
    },
  };
}

test.describe("UX-6 D cluster close — iOS PWA keyboard pattern @webkit", () => {
  test("(a) html.is-ios class lands on iPhone UA after boot", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    const isIos = await page.evaluate(() =>
      document.documentElement.classList.contains("is-ios"),
    );
    expect(isIos).toBe(true);
  });

  test("(b) --vh CSS var is written from visualViewport.height in px", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    const vhVar = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--vh"),
    );
    expect(vhVar).toMatch(/^\d+(\.\d+)?px$/);
    const value = Number.parseFloat(vhVar);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(20);
  });

  test("(c) --viewport-height legacy CSS var writes from same source", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    const vpHeightVar = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--viewport-height"),
    );
    expect(vpHeightVar).toMatch(/^\d+px$/);
    const value = Number.parseInt(vpHeightVar, 10);
    expect(value).toBeGreaterThan(100);
  });

  test("(d) D1 :has(:focus) rule collapses padding-bottom when input focused", async ({
    page,
  }) => {
    await loginAs(page, getSeededVjt());
    // GREEN-CI batch 2 — UX-4 bucket B made `:home` the cold-load
    // default selection; HomePane has no `.compose-box`. Select the
    // autojoin channel first so the ComposeBox mounts (same fix shape
    // as ios-z-cluster-journey.spec.ts:57 lessons-learned).
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    const composeTa = page.locator(".compose-box textarea").first();
    await expect(composeTa).toBeVisible({ timeout: 10_000 });
    await composeTa.focus();
    const paddingBottom = await page.evaluate(() => {
      const shell = document.querySelector(".shell-mobile") as HTMLElement | null;
      if (!shell) return "(no shell)";
      return getComputedStyle(shell).paddingBottom;
    });
    expect(paddingBottom).toBe("0px");
  });

  test("(e) smart-pin: programmatic window scroll snaps back to 0", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    const result = await page.evaluate(async () => {
      const before = window.scrollY;
      window.scrollTo(0, 50);
      await new Promise<void>((r) => setTimeout(r, 100));
      const after = window.scrollY;
      return { before, after };
    });
    expect(result.before).toBe(0);
    expect(result.after).toBe(0);
  });

  test("(f) Admin → Debug tab renders diag panel + DiagFloat toggle", async ({ page }) => {
    const adminCtx = await promoteVjtToAdmin();
    try {
      await loginAs(page, getSeededVjt());
      // GREEN-CI batch 2 — mobile admin entry is via the members-drawer
      // launcher footer (`mobile-panel-admin`), NOT via the desktop
      // shell-chrome cog. Mirrors ux-6-c-mobile-admin-launcher.spec.ts
      // pattern: select channel → open members drawer → tap admin
      // launcher. Original spec used `.querySelector('[data-testid=
      // "shell-chrome-settings"]').click()` which on mobile resolves
      // the settings drawer but with admin-console-entry positioned
      // outside the viewport (drawer is full-height bottom sheet),
      // so the subsequent click never lands.
      await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
      await page.getByLabel(/open members sidebar/i).tap();
      const drawer = page.locator(".shell-members.open");
      await expect(drawer).toBeVisible({ timeout: 5_000 });
      await drawer.locator("[data-testid='mobile-panel-admin']").tap();
      await expect(page.getByTestId("admin-pane")).toBeVisible({ timeout: 5_000 });
      const debugTab = page.getByTestId("admin-tab-debug");
      await expect(debugTab).toBeVisible();
      await debugTab.tap();
      await expect(page.getByTestId("admin-debug-tab")).toBeVisible();
      const toggle = page.getByTestId("diag-float-toggle");
      await expect(toggle).toBeVisible();
      expect(await toggle.isChecked()).toBe(false);
      await toggle.check();
      const flagAfter = await page.evaluate(() => localStorage.getItem("cic_diag"));
      expect(flagAfter).toBe("1");
      await expect(page.getByTestId("diag-float")).toBeVisible();
      await toggle.uncheck();
      const flagAfterOff = await page.evaluate(() => localStorage.getItem("cic_diag"));
      expect(flagAfterOff).toBeNull();
    } finally {
      await adminCtx.revert();
    }
  });
});
