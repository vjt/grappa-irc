// #75 — themes gallery consumer flow (client half of the merged themes
// server subsystem).
//
// Drives the real mobile layout (@webkit): open the hamburger, tap the 🎨
// launcher, and land on the SettingsDrawer "themes" sub-page. The built-in
// gallery (seeded by `mix grappa.seed_themes` in the e2e seeder) renders as
// derived-swatch cards. Applying a theme flips a CSS custom property on
// documentElement live, and — because the active theme is SERVER-owned
// (PUT /me/theme) — survives a reload EVEN with the localStorage cache
// cleared, proving the cross-device server round-trip (not just the local
// FOUC mirror).

import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

// The inline `--bg` custom property customTheme.ts writes on <html>. Empty
// string when no custom theme is applied (base [data-theme] cascade wins).
function readInlineBg(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => document.documentElement.style.getPropertyValue("--bg").trim());
}

async function openThemesSubPage(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  // #299 — the footer 🎨 launcher was removed; themes is reached via the
  // cog (settings) → themes nav row now. Tapping the cog closes the members
  // drawer (mutex) and opens the settings drawer on its "main" page.
  await drawer.locator("[data-testid='mobile-panel-settings']").tap();
  await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
  await page.getByTestId("themes-settings-entry").tap();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
}

test.describe("#75 — themes gallery consumer flow", () => {
  test("@webkit 🎨 launcher opens the themes sub-page with the built-in gallery", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await openThemesSubPage(page);

    // Seeded built-ins render as swatch cards.
    const cards = page.locator("[data-testid^='theme-card-']");
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);
    // Derived swatch: palette chips, not a stored screenshot.
    await expect(
      cards.first().locator("[data-testid^='theme-swatch-'] .theme-chip").first(),
    ).toBeVisible();

    // #75 hard requirement (vjt): alk's `sux` built-in ships in the v1
    // gallery (seeded from Grappa.Themes.Builtins).
    await expect(page.locator(".theme-card-name").filter({ hasText: /^sux$/ })).toBeVisible();
  });

  test("@webkit tapping a card flips --bg live and persists across reload via the server", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await openThemesSubPage(page);

    // #299 item 7 — no standalone apply button: tapping a card's select
    // button IS the apply (and reveals its action row).
    const selectButtons = page.locator("[data-testid^='theme-select-']");
    await expect(selectButtons.first()).toBeVisible({ timeout: 5_000 });
    expect(await selectButtons.count()).toBeGreaterThanOrEqual(2);

    // Tap the first card → --bg becomes non-empty (live inline apply).
    await selectButtons.nth(0).tap();
    await expect.poll(() => readInlineBg(page), { timeout: 5_000 }).not.toBe("");
    const bg1 = await readInlineBg(page);

    // Tap a DIFFERENT card → --bg changes (proves the tap drove it, not a
    // pre-existing active theme).
    await selectButtons.nth(1).tap();
    await expect.poll(() => readInlineBg(page), { timeout: 5_000 }).not.toBe(bg1);
    const bg2 = await readInlineBg(page);
    expect(bg2).not.toBe("");

    // Clear the localStorage FOUC mirror so the post-reload value can ONLY
    // come from the server (GET /me/theme) — isolates the cross-device
    // round-trip from the local cache.
    await page.evaluate(() => localStorage.removeItem("grappa-custom-theme"));
    await page.reload();

    // The seeded token survives reload (addInitScript re-seeds it), boot
    // re-fetches the server active theme and re-applies bg2.
    await expect.poll(() => readInlineBg(page), { timeout: 10_000 }).toBe(bg2);
  });
});
