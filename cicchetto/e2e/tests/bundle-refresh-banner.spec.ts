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

test("UX-6-I — refresh button forces SW update + cache purge before reload", async ({ page }) => {
  // UX-6-I: pre-fix vjt observed it took THREE refresh-button presses
  // on iPhone PWA to actually pick up a new bundle. Root cause: SW's
  // precacheAndRoute serves the OLD precached index.html until the
  // new SW finishes install + activate + claim (multiple navigate
  // cycles of latency). Post-fix `performRefresh` calls
  // `registration.update()`, posts SKIP_WAITING to any waiting SW,
  // purges caches, THEN reloads — so the next navigate hits the
  // network and lands on the fresh bundle in ONE press.
  //
  // We instrument the SW API + caches API on the page side so the
  // click handler's interactions are observable from the test
  // without needing a real cic-bundle-changed deploy mid-spec. The
  // unit tests in bundleHash.test.ts cover the branching exhaustively;
  // this e2e validates the BROWSER actually invokes the patched path
  // when the live button is clicked.
  await loginAs(page, getSeededVjt());

  await expect(page.locator(BANNER_SELECTOR)).toHaveCount(0);

  // Install instrumentation BEFORE setting the server hash so the
  // click handler picks up our stubs. We can't stub `serviceWorker`
  // (read-only on Navigator), so we stub `getRegistration` directly
  // and record invocations on a window-scoped probe.
  await page.evaluate(() => {
    interface Probe {
      updateCalls: number;
      waitingSkipCalls: number;
      cacheDeletes: string[];
      reloaded: boolean;
    }
    const probe: Probe = {
      updateCalls: 0,
      waitingSkipCalls: 0,
      cacheDeletes: [],
      reloaded: false,
    };
    (window as Window & { __ux6i_probe?: Probe }).__ux6i_probe = probe;

    // Stub SW registration. The underlying `navigator.serviceWorker`
    // object is read-only so we monkey-patch `getRegistration` only +
    // the `controller` field + the `addEventListener`/`removeEventListener`
    // pair (controllerchange await path, UX-6-I reviewer H1 fix).
    if ("serviceWorker" in navigator) {
      const fakeWaiting = {
        postMessage: (msg: unknown) => {
          if ((msg as { type?: string })?.type === "SKIP_WAITING") {
            probe.waitingSkipCalls++;
          }
        },
      };
      const fakeReg = {
        update: async () => {
          probe.updateCalls++;
        },
        waiting: fakeWaiting,
        installing: null,
      };
      const swContainer = navigator.serviceWorker as ServiceWorkerContainer & {
        getRegistration: () => Promise<typeof fakeReg>;
        controller: { state: string } | null;
        addEventListener: (event: string, handler: EventListener) => void;
        removeEventListener: (event: string, handler: EventListener) => void;
      };
      swContainer.getRegistration = async () => fakeReg;
      Object.defineProperty(swContainer, "controller", {
        configurable: true,
        value: { state: "activated" },
      });
      // Fire controllerchange immediately so performRefresh's wait
      // resolves without ticking the 2s ceiling. The real flow ALSO
      // hits this listener once the new SW claims, so this mirrors
      // production timing — minus the 2s upper bound.
      swContainer.addEventListener = (event: string, handler: EventListener) => {
        if (event === "controllerchange") {
          queueMicrotask(() => handler(new Event("controllerchange")));
        }
      };
      swContainer.removeEventListener = () => undefined;
    }

    // Stub caches API to record deletion calls.
    if ("caches" in window) {
      (window.caches as CacheStorage & {
        keys: () => Promise<string[]>;
        delete: (key: string) => Promise<boolean>;
      }).keys = async () => ["workbox-precache-v2-https://test/", "workbox-runtime"];
      (window.caches as CacheStorage & {
        delete: (key: string) => Promise<boolean>;
      }).delete = async (key: string) => {
        probe.cacheDeletes.push(key);
        return true;
      };
    }

    // Replace the reload step with the probe seam (UX-6-I). The
    // production code path always reloads; the seam exists ONLY so
    // this e2e can observe the chain without navigating out of the
    // test page. `window.location.reload` is non-configurable on
    // chromium so a prototype patch is silently ignored — the seam
    // is the supported substitute.
    const bh = window.__cic_bundleHash;
    if (!bh) throw new Error("__cic_bundleHash missing");
    bh.__refreshProbe = () => {
      probe.reloaded = true;
    };
  });

  // Push synthetic mismatch → banner appears.
  await page.evaluate(() => {
    window.__cic_bundleHash?.setServerHash("ux-6-i-mismatch-hash");
  });
  const banner = page.locator(BANNER_SELECTOR);
  await expect(banner).toBeVisible();

  // Single click; allow async performRefresh chain to settle.
  await banner.locator("button").click();
  // Wait for the reload stub to be invoked. performRefresh awaits
  // SW + caches before reload, so the probe transitions from
  // reloaded:false to reloaded:true once the chain completes.
  await page.waitForFunction(
    () => (window as Window & { __ux6i_probe?: { reloaded: boolean } }).__ux6i_probe?.reloaded,
    null,
    { timeout: 5_000 },
  );

  const probe = await page.evaluate(() => {
    return (window as Window & {
      __ux6i_probe?: {
        updateCalls: number;
        waitingSkipCalls: number;
        cacheDeletes: string[];
        reloaded: boolean;
      };
    }).__ux6i_probe;
  });

  expect(probe?.reloaded).toBe(true);
  expect(probe?.updateCalls).toBe(1);
  expect(probe?.waitingSkipCalls).toBe(1);
  // Both stub caches must be deleted (workbox-precache + runtime).
  expect(probe?.cacheDeletes.length).toBe(2);
  expect(probe?.cacheDeletes).toContain("workbox-precache-v2-https://test/");
  expect(probe?.cacheDeletes).toContain("workbox-runtime");
});

declare global {
  interface Window {
    // Mirror of the prod surface in `cicchetto/src/lib/bundleHash.ts` —
    // page-side `window.__cic_bundleHash` is defined by the SPA at
    // boot; the type re-declaration here gives this spec strong
    // typing without an import (the spec doesn't run through tsc).
    __cic_bundleHash?: {
      setServerHash: (hash: string) => void;
      reset: () => void;
      bootHash: () => string | null;
      __refreshProbe?: () => void;
    };
  }
}
