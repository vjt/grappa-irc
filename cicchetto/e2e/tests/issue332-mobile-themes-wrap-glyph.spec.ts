// #332 (P0, vjt) — mobile: restore the 🎨 themes launcher under the right
// (members) sidebar, wrap the footer launchers instead of clipping, and
// swap the settings glyph for the ⚙️ emoji.
//
// Three visible outcomes, one @webkit / iPhone-15 spec (the launcher
// footer is mobile-only, hosted inside the open members drawer):
//
//   1. The themes launcher is back (removed by #299) and DEEP-LINKS: tap
//      it → members drawer closes (mutex) → settings drawer opens directly
//      on the THEMES sub-page (the gallery), not the flat "main" page.
//      This exercises the one-shot `requestSettingsPage`/
//      `consumePendingSettingsPage` hand-off (lib/settingsNav.ts) the
//      launcher uses to open + jump in one tap.
//   2. The footer `flex-wrap`s: with the 5th (themes) button back, the row
//      wraps to a new line on narrow devices instead of pushing the admin
//      launcher off-screen (the #299 clip). We assert the CSS contract
//      (`flex-wrap: wrap`) plus every launcher staying in the viewport.
//      (iPhone-15 at 393px still fits 5 tap targets on one row, so this is
//      the contract guard; the actual wrap engages on narrower devices —
//      see TESTING.md on asserting the layout contract, not device pixels.)
//   3. The settings launcher renders the ⚙️ emoji (U+2699 U+FE0F), not the
//      bare ⚙ (U+2699) glyph that rendered too small.
//
// The "admin stays reachable with 5 buttons" invariant is owned by
// issue299-footer-admin-reachable (repurposed for #332). Here vjt is base
// (non-admin): themes is not admin-gated, so we get the launcher + a
// 4-button footer (home / archive / settings / themes) without promoting.

import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import {
  AUTOJOIN_CHANNELS,
  NETWORK_NICK,
  NETWORK_SLUG,
  getSeededVjt,
} from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const SETTINGS_COG_EMOJI = "\u{2699}\u{FE0F}"; // ⚙️ — the emoji-presentation cog (#332 item 3)

test.setTimeout(60_000);

async function openMobileFooter(page: import("@playwright/test").Page) {
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

test.describe("#332 — mobile themes launcher + footer wrap + ⚙️ emoji", () => {
  test("@webkit themes launcher deep-links to the themes gallery sub-page", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    const drawer = await openMobileFooter(page);
    const footer = drawer.locator(".mobile-panel-actions");
    const themesBtn = footer.locator("[data-testid='mobile-panel-themes']");
    await expect(themesBtn).toHaveCount(1);

    // Tap themes → members drawer closes (mutex) AND the settings drawer
    // opens straight on the themes gallery (deep-link), NOT the main page.
    await themesBtn.tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
  });

  test("@webkit footer flex-wraps and keeps every launcher in the viewport", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    const drawer = await openMobileFooter(page);
    const footer = drawer.locator(".mobile-panel-actions");
    await expect(footer).toBeVisible();

    // CSS contract: the row wraps rather than overflow-clipping (#332 item 2).
    const flexWrap = await footer.evaluate((el) => getComputedStyle(el).flexWrap);
    expect(flexWrap).toBe("wrap");

    // Base vjt (non-admin) in a channel: home / archive / settings / themes.
    await expect(footer.locator("[data-testid='mobile-panel-themes']")).toHaveCount(1);

    // Every launcher must stay within the viewport (never clipped off-screen
    // — the failure mode #299 fixed by removal and #332 by wrapping).
    const buttons = footer.locator(".shell-chrome-btn");
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < count; i++) {
      await expect(buttons.nth(i)).toBeInViewport();
    }
  });

  test("@webkit settings launcher renders the ⚙️ emoji, not the bare ⚙ glyph", async ({
    page,
  }) => {
    await loginAs(page, getSeededVjt());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    const drawer = await openMobileFooter(page);
    const settingsBtn = drawer.locator(".mobile-panel-actions [data-testid='mobile-panel-settings']");
    await expect(settingsBtn).toHaveText(SETTINGS_COG_EMOJI);
  });
});
