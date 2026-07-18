// #294 — built-in background picker (theme editor).
//
// Proves the two behaviours the server + vitest gates can't:
//   1. The picker RENDERS the server-owned catalog (GET /themes/backgrounds)
//      as selectable swatches, and selecting one APPLIES the wallpaper LIVE —
//      `--theme-bg-image` points at the static /backgrounds/<key>.webp asset
//      and the `.scrollback-pane::before` layer actually consumes it.
//   2. The static assets are served with the long-lived cache posture the
//      issue mandates (nginx `expires max` → Cache-Control max-age + Expires),
//      so clients / a future CDN never re-fetch.
//
// Both tests are SAVE-FREE (pure live preview + a static asset fetch), so they
// spend NONE of the shared seeded `vjt`'s ~5/day theme-create budget — safe to
// iso-rerun at --repeat-each N. Server-side persistence of a `builtin` payload
// is already pinned by the Elixir token_model + controller tests.

import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test.setTimeout(60_000);

const CHANNEL = AUTOJOIN_CHANNELS[0];

type PWPage = import("@playwright/test").Page;

async function openEditorFromGallery(page: PWPage): Promise<void> {
  await page.getByLabel("open settings").click();
  await page.getByTestId("themes-settings-entry").click();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("theme-new").click();
  await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });
}

test.describe("#294 — built-in background picker", () => {
  test("picker renders the catalog + selecting a built-in applies the wallpaper live", async ({
    page,
  }) => {
    await loginAs(page, getSeededVjt());
    // A channel must be selected so the shell renders a .scrollback-pane — the
    // surface the wallpaper ::before layer paints behind.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();
    await openEditorFromGallery(page);

    // The picker renders the server-owned catalog (v1 = 8 cover backgrounds).
    const builtins = page.getByTestId("theme-editor-bg-builtins");
    await expect(builtins).toBeVisible({ timeout: 5_000 });
    const swatches = builtins.locator("button");
    await expect(swatches).toHaveCount(8);

    // Select the first built-in → applyCustomTheme sets the var + the gate.
    await swatches.first().click();

    await expect(page.locator("html.theme-has-bg")).toHaveCount(1, { timeout: 5_000 });
    const bgImage = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--theme-bg-image").trim(),
    );
    expect(bgImage).toContain("/backgrounds/");
    expect(bgImage).not.toContain("/uploads/"); // built-in, not an upload

    // The wallpaper layer actually CONSUMES the var (computed ::before on the
    // scrollback pane) — proves the CSS layer is wired to the built-in path.
    const layerImage = await page.evaluate(() => {
      const pane = document.querySelector(".scrollback-pane");
      return pane ? getComputedStyle(pane, "::before").backgroundImage : "";
    });
    expect(layerImage).toContain("/backgrounds/");

    // The selected swatch reflects the active state (aria-pressed).
    await expect(swatches.first()).toHaveAttribute("aria-pressed", "true");
  });

  test("built-in background assets are served with long-lived cache headers", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await openEditorFromGallery(page);

    const swatches = page.getByTestId("theme-editor-bg-builtins").locator("button");
    await expect(swatches.first()).toBeVisible({ timeout: 5_000 });

    // Each swatch previews the actual asset as its own background-image; pull
    // the resolved /backgrounds/<key>.webp URL from the first one.
    const assetUrl = await swatches.first().evaluate((el) => {
      const bg = getComputedStyle(el).backgroundImage; // url("https://host/backgrounds/x.webp")
      return bg.match(/\/backgrounds\/[^"')]+/)?.[0] ?? "";
    });
    expect(assetUrl).toMatch(/^\/backgrounds\/.+\.webp$/);

    const resp = await page.request.get(assetUrl);
    expect(resp.status()).toBe(200);
    expect(resp.headers()["content-type"]).toContain("image/webp");

    // nginx `expires max` → both a far-future Expires and a large max-age.
    const cacheControl = resp.headers()["cache-control"] ?? "";
    const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] ?? "0");
    expect(maxAge).toBeGreaterThan(31_536_000 - 1); // ≥ 1 year
    expect(resp.headers().expires).toBeTruthy();
  });
});
