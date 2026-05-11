// CP23 S4 B5 — bundle refresh banner e2e.
//
// Drives the `__cic_bundleHash` black-box hook to simulate the
// server pushing a hash that differs from the one the page booted
// with. Asserts the banner appears, contains the refresh CTA, and
// that clicking the button triggers `window.location.reload()`.
//
// Reproducing a real cicchetto-build mid-session would require
// running the prod oneshot + waiting for nginx to serve the new
// bundle from runtime/cicchetto-dist — way out of scope for an e2e
// run. The banner's job is to render the bootBundleHash != serverHash
// invariant, which this spec validates end-to-end.

import { expect, test } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";

const BANNER_SELECTOR = ".bundle-refresh-banner";

test("BundleRefreshBanner appears on hash mismatch and click reloads the page", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());

  // Banner must NOT render before any server hash is known.
  await expect(page.locator(BANNER_SELECTOR)).toHaveCount(0);

  const bootHash = await page.evaluate(() => {
    const bh = window.__cic_bundleHash;
    if (!bh) throw new Error("__cic_bundleHash hook missing");
    return bh.bootHash();
  });

  // Vite-built page MUST expose a boot hash via the script tag.
  // If this null-check trips, the e2e is running against a non-built
  // surface and the banner contract isn't observable.
  expect(bootHash).not.toBeNull();
  expect(typeof bootHash).toBe("string");

  // Push a synthetic differing hash from the "server".
  await page.evaluate(() => {
    window.__cic_bundleHash?.setServerHash("synthetic-mismatch-hash-9999");
  });

  const banner = page.locator(BANNER_SELECTOR);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("New version available");

  // Set up navigation listener BEFORE clicking — the click triggers
  // window.location.reload() which fires Page navigation in
  // Playwright.
  const navPromise = page.waitForNavigation();
  await banner.locator("button").click();
  await navPromise;

  // After reload, banner is gone (server hasn't pushed yet, and the
  // boot hash matches whatever the page is running under).
  await expect(page.locator(BANNER_SELECTOR)).toHaveCount(0);
});

test("BundleRefreshBanner stays hidden when server pushes the same hash", async ({ page }) => {
  await loginAs(page, getSeededVjt());

  await expect(page.locator(BANNER_SELECTOR)).toHaveCount(0);

  await page.evaluate(() => {
    const bh = window.__cic_bundleHash;
    if (!bh) throw new Error("__cic_bundleHash hook missing");
    const boot = bh.bootHash();
    if (boot === null) throw new Error("boot hash unexpectedly null");
    bh.setServerHash(boot);
  });

  // Same hash = no mismatch = no banner.
  await expect(page.locator(BANNER_SELECTOR)).toHaveCount(0);
});

declare global {
  interface Window {
    __cic_bundleHash?: {
      setServerHash: (hash: string) => void;
      reset: () => void;
      bootHash: () => string | null;
    };
  }
}
