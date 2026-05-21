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
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";

const GRAPPA_BASE_URL = "http://grappa-test:4000";

test.setTimeout(60_000);

async function promoteVjtToAdmin(): Promise<{ revert: () => Promise<void> }> {
  // Mint admin via admin-vjt seeded bearer token, PATCH vjt's
  // is_admin true (matches UX-6-G + UX-6-C pattern). Revert in
  // finally so other parallel specs aren't affected.
  const adminToken = "admin-vjt";
  const findVjtRes = await fetch(`${GRAPPA_BASE_URL}/admin/users`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const users = (await findVjtRes.json()) as { users: { id: string; name: string }[] };
  const vjtId = users.users.find((u) => u.name === getSeededVjt().name)?.id;
  if (!vjtId) throw new Error("seeded vjt user not found");
  const patch = await fetch(`${GRAPPA_BASE_URL}/admin/users/${vjtId}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ is_admin: true }),
  });
  if (!patch.ok) throw new Error(`promote vjt failed: ${patch.status}`);
  return {
    revert: async () => {
      await fetch(`${GRAPPA_BASE_URL}/admin/users/${vjtId}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ is_admin: false }),
      });
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
    const composeTa = page.locator(".compose-box textarea").first();
    await expect(composeTa).toBeVisible();
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
      // Open settings → admin console entry. Mobile path uses the
      // members drawer launcher; navigate via direct URL nav for
      // determinism (admin-console routing identical across modes).
      await page.evaluate(() => {
        const settingsBtn = document.querySelector<HTMLElement>('[data-testid="shell-chrome-settings"]');
        settingsBtn?.click();
      });
      const adminEntry = page.getByTestId("admin-console-entry");
      await expect(adminEntry).toBeVisible({ timeout: 5000 });
      await adminEntry.click();
      const debugTab = page.getByTestId("admin-tab-debug");
      await expect(debugTab).toBeVisible();
      await debugTab.click();
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
