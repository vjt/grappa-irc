// #75 producer path — the theme editor overlay (client half completing the
// themes feature).
//
// Proves the three behaviours jsdom is blind to:
//   1. LIVE preview — a color change re-paints documentElement's inline
//      CSS var in real time (no save, no server call).
//   2. Save persists across reload via the SERVER (createTheme → activate →
//      PUT /me/theme), surviving a cleared localStorage FOUC mirror.
//   3. Cancel RESTORES the pre-open applied theme — an abandoned edit
//      leaves no draft applied (cic never originates server state).
//
// Rate limit: the server caps ~5 theme creations/day/user and the seeded
// `vjt` is shared across the whole integration run, so ONLY the desktop
// save test CREATEs (once). The cancel + @webkit tests open/preview/cancel
// with no server write. An iso-rerun at --repeat-each N will spend N of the
// daily create budget — use a fresh user or low N when triaging the save
// test.

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, openRailMenu, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test.setTimeout(60_000);

const CHANNEL = AUTOJOIN_CHANNELS[0];

type PWPage = import("@playwright/test").Page;

// The inline `--accent` custom property customTheme.ts writes on <html>.
function readAccent(page: PWPage): Promise<string> {
  return page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--accent").trim(),
  );
}

// Set an <input type="color"> value deterministically across engines (fill
// on color inputs is engine-flaky) and fire the input event Solid listens
// for, so the draft updates and live-preview re-applies.
async function setEditorColor(page: PWPage, key: string, value: string): Promise<void> {
  await page.getByTestId(`theme-editor-color-${key}`).evaluate((el, v) => {
    (el as HTMLInputElement).value = v as string;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function openThemesGalleryDesktop(page: PWPage): Promise<void> {
  await openRailMenu(page);
  await page.getByLabel("open settings").click();
  await page.getByTestId("themes-settings-entry").click();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
}

// Mobile route to the same gallery. The members-sidebar hamburger (which hosts
// the settings cog, the path to themes since #299) is channel-scoped, so a
// channel has to be selected first — mirror of the gallery consumer spec. #299
// removed the footer 🎨 launcher; rail launcher menu (#500) → cog → themes nav
// row is the path now.
async function openThemesGalleryMobile(page: PWPage): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });
  await openRailMenu(page);
  await page.locator(".rail-actions-menu [data-testid='action-cluster-cog']").tap();
  await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
  await page.getByTestId("themes-settings-entry").tap();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
}

// #963 — the font <select>'s computed colour, plus the computed colour of the
// name <input> beside it as the ORACLE. Both are read from the LIVE cascade:
// the name field is an <input>, so the global form-control rule already gives
// it `color: var(--fg)`, and the select must resolve to the same value from
// that same rule. Never a literal — a hardcoded expected colour would pass on
// a theme whose `--fg` happened to be black, which is the exact confusion this
// bug is made of.
function readEditorControlColors(page: PWPage): Promise<{ select: string; input: string }> {
  return page.evaluate(() => {
    const read = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? getComputedStyle(el).color : "";
    };
    return { select: read("theme-editor-font"), input: read("theme-editor-name") };
  });
}

test.describe("#75 — theme editor (producer path)", () => {
  test("new theme: live preview + save persists across reload via the server", async ({
    page,
  }) => {
    await loginAs(page, getSeededVjt());
    await openThemesGalleryDesktop(page);

    // Open the editor seeded from a built-in (the "new theme" entry point).
    await page.getByTestId("theme-new").click();
    await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });

    // LIVE preview — change accent → the inline --accent re-paints at once
    // (no save, purely client-side applyCustomTheme).
    await setEditorColor(page, "accent", "#ff00ff");
    await expect.poll(() => readAccent(page), { timeout: 5_000 }).toBe("#ff00ff");

    await page.getByTestId("theme-editor-name").fill(`e2e-editor-${Date.now()}`);
    await page.getByTestId("theme-editor-save").click();

    // Saved + activated — the editor closes and the applied accent stays.
    await expect(page.getByTestId("theme-editor")).toHaveCount(0, { timeout: 5_000 });
    await expect.poll(() => readAccent(page), { timeout: 5_000 }).toBe("#ff00ff");

    // Clear the FOUC mirror so the post-reload value can ONLY come from the
    // server (GET /me/theme) — isolates the cross-device round-trip.
    await page.evaluate(() => localStorage.removeItem("grappa-custom-theme"));
    await page.reload();
    await expect.poll(() => readAccent(page), { timeout: 10_000 }).toBe("#ff00ff");
  });

  test("cancel restores the pre-open theme (no draft leak)", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await openThemesGalleryDesktop(page);

    // Snapshot the applied accent BEFORE opening — whatever it is (base
    // cascade = empty, or a prior active theme).
    const accentPreOpen = await readAccent(page);

    await page.getByTestId("theme-new").click();
    await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });

    // Change it live to a distinct color, prove the preview took…
    await setEditorColor(page, "accent", "#00ccff");
    await expect.poll(() => readAccent(page), { timeout: 5_000 }).toBe("#00ccff");

    // …then cancel — the draft must be discarded and the pre-open state
    // restored (no server write, no leaked draft).
    await page.getByTestId("theme-editor-cancel-btn").click();
    await expect(page.getByTestId("theme-editor")).toHaveCount(0, { timeout: 5_000 });
    await expect.poll(() => readAccent(page), { timeout: 5_000 }).toBe(accentPreOpen);
  });

  test("@webkit editor opens + live-previews + cancels on mobile", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await openThemesGalleryMobile(page);

    const accentPreOpen = await readAccent(page);
    await page.getByTestId("theme-new").tap();
    await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });

    await setEditorColor(page, "accent", "#00ccff");
    await expect.poll(() => readAccent(page), { timeout: 5_000 }).toBe("#00ccff");

    await page.getByTestId("theme-editor-cancel-btn").tap();
    await expect(page.getByTestId("theme-editor")).toHaveCount(0, { timeout: 5_000 });
    await expect.poll(() => readAccent(page), { timeout: 5_000 }).toBe(accentPreOpen);
  });

  // #963 — a <select> does NOT inherit color: the UA paints it `fieldtext`
  // (black), which on a dark theme is black-on-dark. jsdom is blind to this
  // (no UA stylesheet, no computed cascade), so the assertion has to run in a
  // real engine.
  //
  // It runs on BOTH engines, as a tagged/untagged PAIR, because the two
  // Playwright projects PARTITION the suite: chromium takes `grepInvert:
  // /@webkit/`, webkit-iphone-15 takes `grep: /@webkit/`, so a single test can
  // only ever reach one of them. A defect whose whole mechanism is a UA
  // default (`fieldtext`) has to be measured on the UA that matters most for
  // cic — Safari on iOS — and not inferred from Chrome. Same shape as
  // `issue962-settings-drawer-row-squash.spec.ts`.
  test("font select takes its color from the control rule, like a sibling input", async ({
    page,
  }) => {
    await loginAs(page, getSeededVjt());
    await openThemesGalleryDesktop(page);

    await page.getByTestId("theme-new").click();
    await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });

    const painted = await readEditorControlColors(page);

    // Guard the oracle: an empty/absent input color would make the equality
    // vacuous.
    expect(painted.input).not.toBe("");
    expect(painted.select).toBe(painted.input);

    await page.getByTestId("theme-editor-cancel-btn").click();
  });

  test("@webkit #963 — font select takes its color from the control rule (iPhone)", async ({
    page,
  }) => {
    await loginAs(page, getSeededVjt());
    await openThemesGalleryMobile(page);

    await page.getByTestId("theme-new").tap();
    await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });

    const painted = await readEditorControlColors(page);

    expect(painted.input).not.toBe("");
    expect(painted.select).toBe(painted.input);

    await page.getByTestId("theme-editor-cancel-btn").tap();
  });

  test("self-hosted font applies live from same-origin /fonts (no CDN)", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));

    await loginAs(page, getSeededVjt());
    await openThemesGalleryDesktop(page);

    await page.getByTestId("theme-new").click();
    await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });

    // Pick a vendored family → --font-mono re-paints live to include it (no
    // save; purely the editor's live preview).
    await page.getByTestId("theme-editor-font").selectOption("jetbrains-mono");
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--font-mono"),
          ),
        { timeout: 5_000 },
      )
      .toContain("jetbrains-mono");

    // The woff2 is fetched same-origin from /fonts/… once the face paints
    // (the editor modal itself uses --font-mono).
    await expect
      .poll(() => requests.some((u) => u.includes("/fonts/jetbrains-mono/")), { timeout: 5_000 })
      .toBe(true);

    // …and NO external CDN / Google-Fonts request happened — a runtime
    // webfont fetch would be a per-render beacon / IP leak (#75 security).
    expect(
      requests.some((u) => /fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.google/i.test(u)),
    ).toBe(false);

    await page.getByTestId("theme-editor-cancel-btn").click();
  });

  test("background upload: wallpaper layer applies live + persists across reload", async ({
    page,
  }) => {
    await loginAs(page, getSeededVjt());
    // Select a channel so the shell renders a .scrollback-pane (the surface
    // the wallpaper layer paints behind) underneath the settings drawer.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();
    await openThemesGalleryDesktop(page);

    await page.getByTestId("theme-new").click();
    await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });

    // Upload a tiny raster → the server re-encodes + re-hosts it → returns
    // an image_id → draft.background.image_id → applyCustomTheme sets the
    // var + the `theme-has-bg` gate LIVE.
    await page.getByTestId("theme-editor-bg-file").setInputFiles({
      name: "bg.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_HEX, "hex"),
    });

    // The gate class engages + --theme-bg-image points at the re-hosted
    // same-origin /uploads/<slug> once the upload resolves.
    await expect(page.locator("html.theme-has-bg")).toHaveCount(1, { timeout: 15_000 });
    const bgImage = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--theme-bg-image").trim(),
    );
    expect(bgImage).toContain("/uploads/");

    // The wallpaper layer actually CONSUMES the var (computed ::before on
    // the scrollback pane) — proves the CSS layer is wired, not just the var.
    const layerImage = await page.evaluate(() => {
      const pane = document.querySelector(".scrollback-pane");
      return pane ? getComputedStyle(pane, "::before").backgroundImage : "";
    });
    expect(layerImage).toContain("/uploads/");

    // Opacity slider re-paints --theme-bg-opacity live.
    await page.getByTestId("theme-editor-opacity").evaluate((el) => {
      (el as HTMLInputElement).value = "0.55";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--theme-bg-opacity").trim(),
          ),
        { timeout: 5_000 },
      )
      .toBe("0.55");

    await page.getByTestId("theme-editor-name").fill(`e2e-bg-${Date.now()}`);
    await page.getByTestId("theme-editor-save").click();
    await expect(page.getByTestId("theme-editor")).toHaveCount(0, { timeout: 5_000 });

    // Clear the FOUC mirror → reload → the bg + opacity can ONLY come from
    // the server (GET /me/theme), proving the cross-device round-trip.
    await page.evaluate(() => localStorage.removeItem("grappa-custom-theme"));
    await page.reload();
    await expect(page.locator("html.theme-has-bg")).toHaveCount(1, { timeout: 15_000 });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--theme-bg-opacity").trim(),
          ),
        { timeout: 10_000 },
      )
      .toBe("0.55");
  });
});
