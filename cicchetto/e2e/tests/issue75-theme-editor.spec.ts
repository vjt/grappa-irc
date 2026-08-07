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

// #963 — the legibility of a control, measured in PIXELS.
//
// The first version of this asked `getComputedStyle`, and computed style is
// the wrong instrument twice over for this defect. On WebKit the native
// menulist chrome paints its own fill OVER `background`, so the cascade said
// legible while the control was not; and under `devices["iPhone 15"]`
// emulation, a page carrying a <select> with <option>s makes
// `getComputedStyle` hand back DEFAULT values for a subset of nodes (a <body>
// reporting black while its own <input> child reports `#e0e0e0` is a read
// artefact, not a cascade any engine can produce). What the user sees is the
// pixels, so the pixels are the oracle: screenshot the control, histogram its
// interior, and take the WCAG contrast between what fills it and what is
// written on it.
//
// No colour literal is involved — the fill and the ink are both whatever the
// engine painted. The only constant is WCAG's 4.5:1 floor for text.
const WCAG_TEXT_CONTRAST_FLOOR = 4.5;

// Contrast of the painted control: dominant interior colour (the fill) vs the
// most frequent colour far enough from it to be ink (glyphs, caret). Null when
// nothing is written on the control — a control with no ink would otherwise
// score infinite contrast and pass vacuously.
async function paintedContrast(page: PWPage, testId: string): Promise<number | null> {
  const shot = (await page.getByTestId(testId).screenshot()).toString("base64");
  return page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    ctx.drawImage(img, 0, 0);

    // Inset past the border (1 CSS px, up to 3 device px at dsf 3) and the
    // rounded corners, so only the control's own surface is sampled.
    const inset = 7;
    const w = canvas.width - 2 * inset;
    const h = canvas.height - 2 * inset;
    if (w <= 0 || h <= 0) return null;
    const { data } = ctx.getImageData(inset, inset, w, h);

    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const byFrequency = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const fill = byFrequency[0][0];
    const rgb = (k: number) => [(k >> 16) & 255, (k >> 8) & 255, k & 255];
    const far = (k: number) =>
      Math.max(...rgb(k).map((c, i) => Math.abs(c - rgb(fill)[i]))) > 40;
    const ink = byFrequency.find(([k]) => far(k));
    if (ink === undefined) return null;

    const luminance = (k: number) => {
      const [r, g, b] = rgb(k).map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const a = luminance(fill);
    const b = luminance(ink[0]);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, shot);
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

  // #963 — the font <select> has to be READABLE, which is a fact about pixels,
  // not about the cascade. jsdom has neither, so the assertion is e2e.
  //
  // It runs on BOTH engines, as a tagged/untagged PAIR, because the two
  // Playwright projects PARTITION the suite: chromium takes `grepInvert:
  // /@webkit/`, webkit-iphone-15 takes `grep: /@webkit/`, so a single test can
  // only ever reach one of them. That partition is load-bearing here: the two
  // engines painted this control DIFFERENTLY (Chromium honoured `background`
  // on a menulist, WebKit covered it with native chrome), so a green on one
  // says nothing about the other — and cic's engine that matters most is
  // Safari. Same shape as `issue962-settings-drawer-row-squash.spec.ts`.
  test("font select is legible — painted fill vs painted text clears WCAG", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await openThemesGalleryDesktop(page);

    await page.getByTestId("theme-new").click();
    await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });

    await expect
      .poll(() => paintedContrast(page, "theme-editor-font"), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(WCAG_TEXT_CONTRAST_FLOOR);

    await page.getByTestId("theme-editor-cancel-btn").click();
  });

  test("@webkit #963 — font select is legible on the iPhone leg too", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await openThemesGalleryMobile(page);

    await page.getByTestId("theme-new").tap();
    await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });

    await expect
      .poll(() => paintedContrast(page, "theme-editor-font"), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(WCAG_TEXT_CONTRAST_FLOOR);

    await page.getByTestId("theme-editor-cancel-btn").tap();
  });

  // #963 part B — `color-scheme`. `appearance: none` makes the CLOSED select
  // ours, but the OPEN list of <option>s stays the UA's to paint (that is the
  // point of keeping a real <select>: the system picker). The UA only knows
  // which way to paint it if told, and it cannot be told a literal: cic ships
  // a light theme, a dark theme and an editor that overrides `--bg` live. So
  // the declaration is DERIVED from the theme that is painting — which is
  // exactly what this asserts, by driving the theme from one end of the range
  // to the other through the editor's own live preview and watching the
  // derivation follow. A mirror of the implementation would compute the
  // expected value the same way the product does; white and black instead
  // carry their own answer.
  test("the UA's own surfaces follow the theme — color-scheme tracks --bg", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await openThemesGalleryDesktop(page);

    await page.getByTestId("theme-new").click();
    await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });

    const scheme = () =>
      page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);

    await setEditorColor(page, "bg", "#ffffff");
    await expect.poll(scheme, { timeout: 5_000 }).toBe("light");

    await setEditorColor(page, "bg", "#000000");
    await expect.poll(scheme, { timeout: 5_000 }).toBe("dark");

    await page.getByTestId("theme-editor-cancel-btn").click();
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
