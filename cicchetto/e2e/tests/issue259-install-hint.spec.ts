// issue259 install-hint — per-platform install-splash BRANCH rendering.
//
// GH #259 (P0, screenshot IMG_9559): the iOS install hint misdirected
// users — the step text skipped Safari's ⋯ (More) menu, and the
// Add-to-Home-Screen arrow pointed ↓ at the in-page "Continue from
// browser" button instead of the ⋯ chrome. Fix = per-platform HYBRID
// (capability-detection order: a captured `beforeinstallprompt` → native
// Install button; else iOS Safari + NOT standalone → corrected ⋯ steps +
// arrow; else → graceful hide).
//
// What THIS e2e proves in a REAL browser (both projects, via UA
// emulation — same pattern as the #255 computed-contract spec) and what
// it deliberately does NOT:
//   * webkit-iphone-15 project (@webkit) = the iOS-Safari branch: the
//     corrected step text (⋯ → More → Share → Add to Home Screen) with an
//     EMPHASIZED ⋯ glyph (asserted via computed font-weight, the #259
//     "make the target obvious" contract) and the A2HS arrow element
//     present + ⋯-targeted; plus standalone-mode suppresses the splash.
//   * chromium project = the Android/Chromium branch: a captured
//     `beforeinstallprompt` yields the real native Install button and NO
//     arrow; and non-iOS with no prompt falls to the graceful-hide branch
//     (a manual-menu hint, NOT a dead disabled button).
//
// DEVICE-VERIFY (held, NOT covered here): the arrow's exact PIXEL
// positioning relative to Safari's real ⋯ chrome, and the Android native
// install prompt actually firing — Playwright reproduces neither Safari's
// chrome geometry nor the OS install dialog. This spec asserts the
// per-platform BRANCH + computed contract, never pixel position.
//
// `@webkit` in a test title opts it into the webkit-iphone-15 project
// (playwright.config.ts grep); untitled tests run on chromium
// (grepInvert: /@webkit/). One file drives both branches.
//
// No login/seed: the splash mounts on first visit to "/" from a fresh
// context (no cic.installChoice, browser-tab mode) — see
// push-install-splash.spec.ts + main.tsx `shouldShowInstallSplash`.

import { expect, test } from "@playwright/test";

// A minimal BeforeInstallPromptEvent stand-in. The render path reads only
// its PRESENCE (`window.__cicInstallPrompt != null` → promptAvailable());
// we never click Install here (the native OS dialog is device-verify), so
// the method bodies are inert. Assigned at boot via addInitScript so the
// boot capture in main.tsx + InstallSplash's onMount read see it —
// exactly like Chrome's early `beforeinstallprompt` fire.
const INJECT_PROMPT = () => {
  (window as unknown as { __cicInstallPrompt?: unknown }).__cicInstallPrompt = {
    preventDefault() {},
    prompt() {
      return Promise.resolve();
    },
    userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" }),
    platforms: ["web"],
  };
};

// Guarantee NO captured prompt so the graceful-hide + iOS branches are
// deterministic even if the browser decides to fire `beforeinstallprompt`
// on its own: a capture-phase listener registered before main.tsx's
// handler swallows the event via stopImmediatePropagation, so
// `window.__cicInstallPrompt` is never set.
const SUPPRESS_PROMPT = () => {
  window.addEventListener(
    "beforeinstallprompt",
    (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
};

test.describe("issue259 install-hint — per-platform branch rendering", () => {
  // ---- iOS Safari branch (webkit-iphone-15 project) ----------------------
  test("@webkit issue259 — iOS Safari branch points at the ⋯ menu with emphasized glyph + arrow", async ({
    page,
  }) => {
    await page.addInitScript(SUPPRESS_PROMPT);
    await page.goto("/");

    const splash = page.locator(".install-splash");
    await expect(splash).toBeVisible({ timeout: 5_000 });

    // Corrected step text: ⋯ (More) is the target, then Share, then Add to
    // Home Screen. Pre-#259 it read "tap ⎙ Share, then Add to Home Screen"
    // — no ⋯, no More (the misdirection).
    const steps = splash.getByTestId("install-ios-steps");
    await expect(steps).toBeVisible();
    const stepText = (await steps.innerText()).replace(/\s+/g, " ");
    expect(stepText).toContain("⋯");
    expect(stepText).toMatch(/More/);
    expect(stepText).toMatch(/Share/);
    expect(stepText).toMatch(/Add to Home Screen/);

    // The ⋯ glyph is EMPHASIZED (made obvious per #259) — computed
    // font-weight bold, unlike #204's understated pre-fix glyph (normal).
    const glyphWeight = await splash
      .locator(".install-splash-glyph")
      .evaluate((el) => getComputedStyle(el).fontWeight);
    expect(glyphWeight).toBe("700");

    // The A2HS arrow element is present and its caption ALSO targets ⋯
    // (pre-#259 the caption read "tap Share" above a ↓ aimed at the
    // in-page "Continue from browser" button). Pixel position = device-verify.
    const arrow = splash.getByTestId("install-a2hs-arrow");
    await expect(arrow).toBeVisible();
    expect(await arrow.innerText()).toContain("⋯");
  });

  test("@webkit issue259 — standalone-mode PWA suppresses the install splash", async ({
    page,
  }) => {
    // A launched-from-home-screen PWA has no Safari chrome to point at, so
    // the splash must not mount at all. isStandalonePwa() reads
    // navigator.standalone (iOS pre-17) — stub it true before boot.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    });
    await page.goto("/");
    // Boot signal: unauthenticated fresh context redirects under the splash
    // overlay to the login screen. Waiting for it avoids a premature
    // count-0 false pass before the app has decided whether to mount.
    await expect(page.locator(".login-form")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".install-splash")).toHaveCount(0);
  });

  // ---- Android / Chromium branch (chromium project) ----------------------
  test("issue259 — Chromium branch shows the native Install button and NO arrow", async ({
    page,
  }) => {
    // Deterministically supply a captured beforeinstallprompt (headless
    // Chromium does not reliably fire it) — the render path reads its
    // presence and shows the native Install button, dropping the manual
    // hint entirely.
    await page.addInitScript(INJECT_PROMPT);
    await page.goto("/");

    const splash = page.locator(".install-splash");
    await expect(splash).toBeVisible({ timeout: 5_000 });

    const installBtn = splash.getByRole("button", { name: /Install app/i });
    await expect(installBtn).toBeVisible();
    await expect(installBtn).toBeEnabled();

    // The manual ⋯ arrow is iOS-only — never rendered on the native path.
    await expect(splash.getByTestId("install-a2hs-arrow")).toHaveCount(0);
  });

  test("issue259 — non-iOS with no prompt gracefully hides the CTA (menu hint, no dead button)", async ({
    page,
  }) => {
    // Non-iOS (chromium UA) with NO captured prompt: pre-#259 rendered a
    // permanently-disabled "Install app" button; #259 drops it in favour
    // of an actionable manual-menu hint (graceful hide).
    await page.addInitScript(SUPPRESS_PROMPT);
    await page.goto("/");

    const splash = page.locator(".install-splash");
    await expect(splash).toBeVisible({ timeout: 5_000 });

    // No dead disabled button on the else path.
    await expect(splash.getByRole("button", { name: /Install app/i })).toHaveCount(0);
    // An actionable manual-menu hint instead.
    const hint = splash.locator(".install-splash-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/use your browser menu/i);
  });
});
