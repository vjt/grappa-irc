// #299 items 7 + 8 — the reworked theme card (tap-to-select-and-apply +
// progressive-disclosure action row) AND visitors as first-class theme
// producers, both proven through the REAL browser UI (jsdom is blind to
// tap-target geometry + the live CSS apply).
//
// Item 7: a card is one whole tap target. Tapping it applies the theme live
// AND reveals its action row (copy + owner/admin manage) — only ONE card's
// actions are open at a time. Action buttons are ≥44px (Apple HIG).
//
// Item 8: a minted anon visitor copies a built-in into their own library and
// gets full manage affordances on the owned copy (edit/delete) — the visitor
// is a first-class producer, not a read-only browser. The copied theme is
// attributed to the fixed "guest" label server-side (author model B); this
// spec exercises the client half.

import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import {
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const MIN_TAP_TARGET_PX = 44;

test.setTimeout(60_000);

type PWPage = import("@playwright/test").Page;

// Mobile path to the themes sub-page (mirrors the #75 gallery spec): members
// hamburger → cog (settings) → themes nav row.
async function openThemesSubPageMobile(page: PWPage): Promise<void> {
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await drawer.locator("[data-testid='mobile-panel-settings']").tap();
  await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
  await page.getByTestId("themes-settings-entry").tap();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
}

// Desktop path to the themes sub-page (settings cog → themes nav row).
async function openThemesSubPageDesktop(page: PWPage): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  await page.getByTestId("themes-settings-entry").click();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
}

test.describe("#299 — theme cards (tap-select + progressive disclosure)", () => {
  test("@webkit tapping a card reveals exactly one ≥44px action row", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await openThemesSubPageMobile(page);

    const selects = page.locator("[data-testid^='theme-select-']");
    await expect(selects.first()).toBeVisible({ timeout: 5_000 });
    expect(await selects.count()).toBeGreaterThanOrEqual(2);

    // Progressive disclosure: NOTHING is selected on entry, so no action row
    // is rendered yet.
    await expect(page.locator("[data-testid^='theme-actions-']")).toHaveCount(0);

    // Tap the first card → its (and ONLY its) action row appears.
    await selects.first().tap();
    await expect(page.locator("[data-testid^='theme-actions-']")).toHaveCount(1, { timeout: 5_000 });

    // The revealed copy button is a proper ≥44px tap target.
    const copyBtn = page.locator("[data-testid^='theme-copy-']").first();
    await expect(copyBtn).toBeVisible();
    const box = await copyBtn.boundingBox();
    if (box === null) throw new Error("copy action has no bounding box");
    // Round: webkit returns sub-pixel fractional heights for a min-44px box.
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);

    // Tapping a DIFFERENT card moves the disclosure — still exactly one row.
    await selects.nth(1).tap();
    await expect(page.locator("[data-testid^='theme-actions-']")).toHaveCount(1, { timeout: 5_000 });
  });

  test("a minted visitor copies a built-in and gets manage actions on the owned copy", async ({
    browser,
  }) => {
    const visitor = await mintVisitor(`e2e299v-${Date.now()}`);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const subjectJson = JSON.stringify({
        kind: "visitor",
        id: visitor.id,
        nick: visitor.nick,
        network_slug: visitor.network_slug,
        registered: false,
      });
      await page.addInitScript(
        ([token, subject]) => {
          localStorage.setItem("grappa-token", token);
          localStorage.setItem("grappa-subject", subject);
          localStorage.setItem("cic.installChoice", "browser");
        },
        [visitor.token, subjectJson] as const,
      );
      await page.goto("/");

      await openThemesSubPageDesktop(page);

      // Select a built-in card → reveal its actions → copy it. A visitor is a
      // first-class producer, so this succeeds (pre-#299 it 403'd).
      const selects = page.locator("[data-testid^='theme-select-']");
      await expect(selects.first()).toBeVisible({ timeout: 5_000 });
      await selects.first().click();
      const copyBtn = page.locator("[data-testid^='theme-copy-']").first();
      await expect(copyBtn).toBeVisible({ timeout: 5_000 });
      await copyBtn.click();

      // The fresh owned copy is auto-selected → its card now shows the OWNER
      // manage affordances (edit + delete), which a built-in never offered the
      // visitor. Proves `mine` flipped true for the visitor-owned copy.
      await expect(page.locator("[data-testid^='theme-edit-']").first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.locator("[data-testid^='theme-delete-']").first()).toBeVisible();
    } finally {
      await ctx.close();
      // The copy is a private (unpublished) theme, so it CASCADE-dies with the
      // visitor — no gallery residue to clean up.
      await adminDeleteVisitor(getSeededAdmin().token, visitor.id).catch(() => {});
    }
  });
});
