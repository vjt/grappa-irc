// UX-6-I.2 (2026-05-22) — real-bundle-swap e2e for the refresh banner.
//
// Companion to bundle-refresh-banner.spec.ts. That spec stubs the SW +
// caches API + reload chain via __ux6i_probe to assert performRefresh
// invokes the right sequence. This spec proves the BROWSER converges to
// the new bundle in ONE click — the user-visible UX-6-I bug ("3 presses
// to pick up new bundle on iPhone PWA") was a reload race with the
// SW's precache; the fix is only worth shipping if a real reload after
// performRefresh actually lands on the new bundle.
//
// Flow:
//   1. snapshotBundle() — copy current dist for teardown restore.
//   2. Load the page; SW installs + claims; banner hidden (hashes match).
//   3. swapToBundleB() — rewrite dist/index.html script tag to a
//      synthetic /assets/index-<newHash>.js + drop a stub JS asset.
//   4. setServerHash(newHash) — mirror the broadcast from
//      /admin/cic-bundle-changed; banner appears.
//   5. Banner click. performRefresh runs real SW update + cache purge +
//      reload. Asserts: after navigation completes, the reloaded page's
//      <script src="/assets/index-...js"> carries newHash on the FIRST
//      click (no second / third press needed).
//   6. restore() — teardown puts the original dist back so other specs
//      see a clean baseline.
//
// Difference from the stubbed spec: we let the REAL nginx serve the
// swapped index.html, the REAL browser fetches it, the REAL SW
// precache fights workbox's network-fallback. The only stub is the
// synthetic stub JS asset (a minimal ES module) because building a
// second vite bundle inside the test is out of scope; the spec
// asserts on the script-src hash post-reload, not on full SPA boot.
//
// Caveat: this spec runs against chrome on Linux (nginx-test stack).
// The iPhone PWA bug it descends from is platform-specific (iOS Safari
// throttles SW activation more aggressively than chromium). A green
// run here proves the convergence logic + cache-purge ordering hold
// under nominal SW timing; iPhone-specific timing must be hand-
// validated each release per the H2-reviewer wait-loop in
// `performRefresh()`.

import { expect, test } from "../fixtures/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";
import { snapshotBundle, swapToBundleB } from "../fixtures/bundleSwap";

const BANNER_SELECTOR = ".bundle-refresh-banner";

test("UX-6-I.2 — single-press refresh converges to new bundle (real swap)", async ({ page }) => {
  const snap = await snapshotBundle();
  try {
    await loginAs(page, getSeededVjt());

    // SW should install + claim. Wait for either an active controller
    // or the navigator.serviceWorker.ready promise — either signals
    // precache has run at least once.
    await page.waitForFunction(
      async () => {
        if (!("serviceWorker" in navigator)) return true;
        const reg = await navigator.serviceWorker.ready;
        return reg.active !== null;
      },
      null,
      { timeout: 10_000 },
    );

    await expect(page.locator(BANNER_SELECTOR)).toHaveCount(0);

    // Read the boot hash via the same surface the production banner
    // uses.
    const bootHash = await page.evaluate(() => window.__cic_bundleHash?.bootHash() ?? null);
    expect(bootHash, "boot hash should be parseable from index.html").toBeTruthy();

    // Atomic swap on the host filesystem — nginx-test sees the new
    // index.html on the next request.
    const { newHash, oldHash } = await swapToBundleB();
    expect(newHash).not.toBe(oldHash);
    expect(bootHash).toBe(oldHash);

    // Mirror the WS broadcast that /admin/cic-bundle-changed would
    // push. setServerHash flips the signal → banner mounts on mismatch.
    await page.evaluate((h: string) => {
      window.__cic_bundleHash?.setServerHash(h);
    }, newHash);

    const banner = page.locator(BANNER_SELECTOR);
    await expect(banner).toBeVisible();

    // SINGLE click. The pre-UX-6-I bug needed 3 presses; the post-fix
    // performRefresh + cache purge + controllerchange wait should
    // converge in one.
    //
    // performRefresh is async: it awaits SW.update + controllerchange
    // (up to 2s) + caches.delete BEFORE window.location.reload(). The
    // `framenavigated` event is the tightest-coupling signal for the
    // eventual reload — armed BEFORE the click via Promise.all so we
    // capture the navigation rather than racing it (H2 reviewer fix —
    // replaces the deprecated `waitForNavigation`).
    await Promise.all([
      page.waitForEvent("framenavigated", { timeout: 15_000 }),
      banner.getByRole("button", { name: /refresh|new version/i }).click(),
    ]);
    // Belt-and-braces: ensure the reloaded document is fully parsed
    // before we assert on its DOM. waitForLoadState("load") returns
    // immediately if already in the `load` state — cheap.
    await page.waitForLoadState("load");

    // After the reload, the page's <script src="/assets/index-<hash>.js">
    // MUST carry newHash. Read it directly from the DOM rather than via
    // `__cic_bundleHash.bootHash()` — the synthetic stub bundle is a
    // minimal ES module that doesn't bootstrap the SPA, so the
    // window surface isn't installed post-reload. The DOM script tag
    // is the authoritative ground truth either way. If this assertion
    // fails, SW precache served the OLD index.html again (the original
    // 3-press bug).
    const reloadedHash = await page.evaluate(() => {
      const script = document.querySelector<HTMLScriptElement>(
        'script[src*="/assets/index-"]',
      );
      const m = script?.getAttribute("src")?.match(/\/assets\/index-([^."]+)\.js/);
      return m?.[1] ?? null;
    });
    expect(reloadedHash, "post-refresh boot hash MUST be the swapped (new) hash").toBe(newHash);
  } finally {
    await snap.restore();
  }
});
