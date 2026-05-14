// push-install-splash — push notifications cluster B5 spec 1a
// (2026-05-14).
//
// Coverage: pre-PWA install splash (B0). Visit cic from a fresh
// browser context (no `cic.installChoice` seeded), assert the
// splash overlays the SPA, click "Continue from browser", verify
// it dismisses + the choice persists across reload.
//
// Why this lives in the push cluster: the install splash is the
// pre-condition for push — users who DON'T install (or DON'T pick
// browser-only mode) never reach the SettingsDrawer where they'd
// flip the master toggle. Regression here would silently kill the
// notification onboarding funnel.
//
// Test isolation: this is the ONLY push spec that does NOT use
// `loginAs` from cicchettoPage.ts — that helper seeds the install
// choice as a side-effect (see fixture). Subsequent push specs
// inherit the seed-loginAs path; the splash is never re-tested in
// those.

import { expect, test } from "@playwright/test";

test.describe("push install splash", () => {
  test("appears on first visit, dismisses on Continue, persists across reload", async ({
    page,
  }) => {
    await page.goto("/");

    // Splash card mounts as `.install-splash` (role=dialog) — see
    // cicchetto/src/InstallSplash.tsx. The "Continue from browser"
    // CTA is the always-rendered secondary button (the primary
    // "Install app" CTA is iOS-conditional + beforeinstallprompt-
    // gated; we only need the secondary path for the test seam).
    const splash = page.locator(".install-splash");
    await expect(splash).toBeVisible({ timeout: 5_000 });

    const continueBtn = splash.locator("button.install-splash-secondary");
    await expect(continueBtn).toContainText("Continue from browser");
    await continueBtn.click();

    // Click handler writes localStorage["cic.installChoice"] =
    // "browser" + unmounts the splash.
    await expect(splash).toHaveCount(0);

    // Reload — splash MUST stay dismissed because shouldShowInstallSplash
    // reads the persisted choice. Without persistence we'd re-prompt
    // on every visit, defeating the "make a choice and move on" UX.
    await page.reload();
    await expect(page.locator(".install-splash")).toHaveCount(0, { timeout: 5_000 });
  });
});
